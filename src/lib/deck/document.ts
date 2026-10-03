/**
 * `.deck` document lifecycle: creation, parsing, repair, and migration.
 *
 * Parsing follows the ink document's rule: damage a person could not have
 * meant — an element missing from its paint order, a slide missing from the
 * slide order, a layout reference to a layout that no longer exists — is
 * **repaired and reported**, never silent. Only a document that is the wrong
 * kind, has no usable schema version, breaks a hard limit, or is still invalid
 * after repair refuses to open.
 *
 * A document from a newer schema version opens read-only and untouched: this
 * build would otherwise strip fields it cannot see and corrupt the file for the
 * build that wrote it.
 */
import {
  DECK_DOCUMENT_KIND,
  DECK_EXTENSION,
  DECK_LIMITS,
  DECK_SCHEMA_VERSION,
  DECK_SIZE_PRESETS,
} from '../../types/deck';
import type {
  DeckDocument,
  DeckElement,
  DeckLayout,
  DeckMaster,
  DeckSizePreset,
  DeckSlide,
  DeckTheme,
} from '../../types/deck';

import { createSlideForLayout } from './design';
import { buildDesign } from './templates';
import type { DeckTemplateId } from './templates';
import { countJsonEntries, serializeDeck, validateDeck } from './validate';

export type DeckDocumentErrorCode =
  | 'invalid-json'
  | 'not-an-object'
  | 'wrong-kind'
  | 'invalid-schema-version'
  | 'invalid-structure'
  | 'limit-exceeded';

export class DeckDocumentError extends Error {
  readonly code: DeckDocumentErrorCode;
  /** The validator's findings, when the document was structurally invalid. */
  readonly issues: string[];

  constructor(code: DeckDocumentErrorCode, message: string, issues: string[] = []) {
    super(message);
    this.name = 'DeckDocumentError';
    this.code = code;
    this.issues = issues;
  }
}

/**
 * How this build can handle a stored document.
 * - `supported`: normalized and editable.
 * - `newer`: written by a newer build; open read-only and never write it back.
 */
export type DeckSchemaSupport = 'supported' | 'newer';

export interface DeckDocumentInspection {
  support: DeckSchemaSupport;
  schemaVersion: number;
  document: DeckDocument;
  /** Non-fatal repairs applied while normalizing. Surfaced, never silent. */
  warnings: string[];
}

export function isDeckPath(path: string): boolean {
  return path.toLowerCase().endsWith(`.${DECK_EXTENSION}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;

/* ------------------------------------------------------------------------- */
/* Creation                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The built-in theme. Ordinary document content: a deck carries its own copy,
 * so changing this default never restyles an existing deck.
 */
export function defaultDeckTheme(): DeckTheme {
  const { width, height } = DECK_SIZE_PRESETS.widescreen;
  return buildDesign('collab', width, height).theme;
}

/** Master and layouts sized for a slide, so every size preset gets sensible geometry. */
function defaultMasterAndLayouts(
  width: number,
  height: number,
  themeId: string,
): { master: DeckMaster; layouts: DeckLayout[] } {
  const { master, layouts } = buildDesign('collab', width, height);
  return { master: { ...master, themeId }, layouts };
}

export interface CreateDeckOptions {
  id: string;
  name: string;
  /** ISO timestamp; injected so creation is deterministic in tests. */
  now: string;
  sizePreset?: Exclude<DeckSizePreset, 'custom'>;
  /** A built-in starter design; the Collab design by default. */
  template?: DeckTemplateId;
}

/**
 * A new deck: the default theme, one master, five layouts, and one empty title
 * slide. Everything is ordinary, inspectable document content.
 */
export function createDeckDocument(options: CreateDeckOptions): DeckDocument {
  const size = { ...DECK_SIZE_PRESETS[options.sizePreset ?? 'widescreen'] };
  const { theme, master, layouts } = buildDesign(
    options.template ?? 'collab',
    size.width,
    size.height,
  );
  const firstSlide = createSlideForLayout(
    'slide-1',
    layouts.find((layout) => layout.id === 'layout-title'),
  );
  return {
    kind: DECK_DOCUMENT_KIND,
    schemaVersion: DECK_SCHEMA_VERSION,
    id: options.id,
    name: options.name,
    createdAt: options.now,
    updatedAt: options.now,
    size,
    themeId: theme.id,
    themes: { [theme.id]: theme },
    masters: { [master.id]: master },
    layouts: Object.fromEntries(layouts.map((layout) => [layout.id, layout])),
    slides: { [firstSlide.id]: firstSlide },
    slideOrder: [firstSlide.id],
  };
}

/** Serialized content for a brand-new deck, as the create flows write it. */
export function newDeckContent(name: string, template?: DeckTemplateId): string {
  return serializeDeck(
    createDeckDocument({
      id: `deck-${crypto.randomUUID()}`,
      name,
      now: new Date().toISOString(),
      ...(template ? { template } : {}),
    }),
  );
}

/** A slide on a layout, with an empty slide element for each named placeholder. */
export function createSlide(
  id: string,
  layoutId: string,
  placeholders: Array<'title' | 'subtitle' | 'body'>,
): DeckSlide {
  const elements = placeholders.map((type): DeckElement => ({
    id: `${id}-${type}`,
    type: 'text',
    placeholder: { type, key: type },
    text: { content: { paragraphs: [] } },
  }));
  return {
    id,
    layoutId,
    elements: Object.fromEntries(elements.map((element) => [element.id, element])),
    elementOrder: elements.map((element) => element.id),
  };
}

/* ------------------------------------------------------------------------- */
/* Repair                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Repairs one element map and its paint order in place: drops order entries
 * and group children that name nothing, drops duplicates, and appends elements
 * that are neither ordered nor grouped rather than losing them.
 */
function repairContainer(
  container: Record<string, unknown>,
  where: string,
  warnings: string[],
): void {
  if (!isRecord(container.elements)) {
    container.elements = {};
    warnings.push(`${where} had no element map; it was reset`);
  }
  const elements = container.elements as Record<string, Record<string, unknown>>;
  for (const [key, element] of Object.entries(elements)) {
    if (!isRecord(element)) {
      delete elements[key];
      warnings.push(`${where}: element '${key}' was not an object and was removed`);
    } else if (element.id !== key) {
      element.id = key;
      warnings.push(`${where}: element '${key}' had a mismatched id and was corrected`);
    }
  }

  const grouped = new Set<string>();
  for (const element of Object.values(elements)) {
    if (element.type !== 'group' || !Array.isArray(element.childIds)) continue;
    const kept = element.childIds.filter(
      (child): child is string =>
        isId(child) && child in elements && child !== element.id && !grouped.has(child),
    );
    if (kept.length !== element.childIds.length) {
      warnings.push(
        `${where}: group '${String(element.id)}' referenced missing or shared children; they were dropped`,
      );
    }
    element.childIds = kept;
    for (const child of kept) grouped.add(child);
  }

  const raw = Array.isArray(container.elementOrder) ? container.elementOrder : [];
  const order: string[] = [];
  for (const id of raw) {
    if (isId(id) && id in elements && !order.includes(id) && !grouped.has(id)) order.push(id);
  }
  if (order.length !== raw.length)
    warnings.push(`${where}: invalid or duplicate paint-order entries were dropped`);
  for (const id of Object.keys(elements)) {
    if (!order.includes(id) && !grouped.has(id)) {
      order.push(id);
      warnings.push(`${where}: element '${id}' was missing from the paint order and was appended`);
    }
  }
  container.elementOrder = order;
}

function repairReadingOrder(
  slide: Record<string, unknown>,
  where: string,
  warnings: string[],
): void {
  if (slide.readingOrder === undefined) return;
  const elements = slide.elements as Record<string, unknown>;
  const raw = Array.isArray(slide.readingOrder) ? slide.readingOrder : [];
  const order = raw.filter(
    (id, index): id is string =>
      isId(id) &&
      id in elements &&
      isRecord(elements[id]) &&
      elements[id].type !== 'group' &&
      raw.indexOf(id) === index,
  );
  if (order.length !== raw.length) {
    warnings.push(`${where}: invalid, duplicate, or missing reading-order entries were dropped`);
  }
  if (order.length > 0) slide.readingOrder = order;
  else delete slide.readingOrder;
}

function repairStructure(deck: Record<string, unknown>, warnings: string[]): void {
  for (const field of ['themes', 'masters', 'layouts', 'slides'] as const) {
    if (!isRecord(deck[field])) {
      deck[field] = {};
      warnings.push(`the ${field} map was missing and was reset`);
    }
  }
  const themes = deck.themes as Record<string, unknown>;
  const masters = deck.masters as Record<string, Record<string, unknown>>;
  const layouts = deck.layouts as Record<string, Record<string, unknown>>;
  const slides = deck.slides as Record<string, Record<string, unknown>>;
  const size = isRecord(deck.size) ? deck.size : DECK_SIZE_PRESETS.widescreen;

  if (Object.keys(themes).length === 0) {
    const theme = defaultDeckTheme();
    themes[theme.id] = theme;
    warnings.push('the deck had no theme; the default theme was added');
  }
  if (!isId(deck.themeId) || !(deck.themeId in themes)) {
    deck.themeId = Object.keys(themes).sort()[0];
    warnings.push(`the deck theme was missing and '${String(deck.themeId)}' is used instead`);
  }
  if (Object.keys(masters).length === 0) {
    const { master } = defaultMasterAndLayouts(
      Number(size.width) || DECK_SIZE_PRESETS.widescreen.width,
      Number(size.height) || DECK_SIZE_PRESETS.widescreen.height,
      String(deck.themeId),
    );
    masters[master.id] = master as unknown as Record<string, unknown>;
    warnings.push('the deck had no master; the default master was added');
  }
  const firstMaster = Object.keys(masters).sort()[0];
  for (const [id, master] of Object.entries(masters)) {
    if (isRecord(master) && master.themeId !== undefined && !(String(master.themeId) in themes)) {
      delete master.themeId;
      warnings.push(`master '${id}' used a missing theme and now uses the deck theme`);
    }
    if (isRecord(master)) repairContainer(master, `master '${id}'`, warnings);
  }
  for (const [id, layout] of Object.entries(layouts)) {
    if (!isRecord(layout)) continue;
    if (!(String(layout.masterId) in masters)) {
      layout.masterId = firstMaster;
      warnings.push(`layout '${id}' used a missing master and now uses '${firstMaster}'`);
    }
    repairContainer(layout, `layout '${id}'`, warnings);
  }
  for (const [id, slide] of Object.entries(slides)) {
    if (!isRecord(slide)) continue;
    if (slide.layoutId !== undefined && !(String(slide.layoutId) in layouts)) {
      delete slide.layoutId;
      warnings.push(`slide '${id}' used a missing layout; it now uses its master directly`);
    }
    repairContainer(slide, `slide '${id}'`, warnings);
    repairReadingOrder(slide, `slide '${id}'`, warnings);
  }

  const rawOrder = Array.isArray(deck.slideOrder) ? deck.slideOrder : [];
  const order: string[] = [];
  for (const id of rawOrder) if (isId(id) && id in slides && !order.includes(id)) order.push(id);
  if (order.length !== rawOrder.length)
    warnings.push('invalid or duplicate slide-order entries were dropped');
  for (const id of Object.keys(slides)) {
    if (!order.includes(id)) {
      order.push(id);
      warnings.push(`slide '${id}' was missing from the slide order and was appended`);
    }
  }
  if (order.length === 0) {
    const slide = createSlide('slide-1', 'layout-blank' in layouts ? 'layout-blank' : '', []);
    if (!slide.layoutId) delete slide.layoutId;
    slides[slide.id] = slide as unknown as Record<string, unknown>;
    order.push(slide.id);
    warnings.push('the deck had no slides; a blank slide was added');
  }
  deck.slideOrder = order;

  if (Array.isArray(deck.sections)) {
    const kept = deck.sections.filter(
      (section) =>
        isRecord(section) && isId(section.firstSlideId) && section.firstSlideId in slides,
    );
    if (kept.length !== deck.sections.length)
      warnings.push('sections starting at missing slides were removed');
    deck.sections = kept;
  }
}

/* ------------------------------------------------------------------------- */
/* Parse and normalize                                                        */
/* ------------------------------------------------------------------------- */

const LIMIT_PATTERN = /more than|exceeds|too many|limit/;

export function normalizeDeckDocument(value: unknown): DeckDocumentInspection {
  if (!isRecord(value))
    throw new DeckDocumentError('not-an-object', 'Deck document must be a JSON object');
  if (value.kind !== DECK_DOCUMENT_KIND) {
    throw new DeckDocumentError(
      'wrong-kind',
      `Deck document must declare kind "${DECK_DOCUMENT_KIND}"`,
    );
  }
  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new DeckDocumentError(
      'invalid-schema-version',
      'Deck document must declare a positive integer schemaVersion',
    );
  }
  if (schemaVersion > DECK_SCHEMA_VERSION) {
    return {
      support: 'newer',
      schemaVersion,
      document: value as unknown as DeckDocument,
      warnings: [],
    };
  }
  if (countJsonEntries(value, DECK_LIMITS.jsonEntries) > DECK_LIMITS.jsonEntries) {
    throw new DeckDocumentError(
      'limit-exceeded',
      `Deck document exceeds the ${DECK_LIMITS.jsonEntries}-entry or ${DECK_LIMITS.jsonDepth}-level limit`,
    );
  }

  const warnings: string[] = [];
  // Repairs work on a copy, so unknown fields survive and the input is untouched.
  const working = structuredClone(value);
  repairStructure(working, warnings);
  const migrated = migrateDeckDocument(working as unknown as DeckDocument, schemaVersion);
  warnings.push(...migrated.warnings);

  const result = validateDeck(migrated.document);
  if (!result.ok) {
    const issues = result.issues.map((issue) => `${issue.path || 'deck'}: ${issue.message}`);
    const code = issues.some((issue) => LIMIT_PATTERN.test(issue))
      ? 'limit-exceeded'
      : 'invalid-structure';
    throw new DeckDocumentError(code, `Deck document is invalid: ${issues[0]}`, issues);
  }
  return { support: 'supported', schemaVersion, document: result.deck, warnings };
}

/** Parses stored text, enforcing the byte limit before `JSON.parse`. */
export function parseDeckDocument(text: string): DeckDocumentInspection {
  if (new TextEncoder().encode(text).length > DECK_LIMITS.documentBytes) {
    throw new DeckDocumentError(
      'limit-exceeded',
      `Deck document exceeds the ${DECK_LIMITS.documentBytes}-byte limit`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new DeckDocumentError(
      'invalid-json',
      `Deck document is not valid JSON: ${(error as Error).message}`,
    );
  }
  return normalizeDeckDocument(parsed);
}

/* ------------------------------------------------------------------------- */
/* Migration                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Migrates an older document forward. Version 1 is the first schema, so there
 * is nothing to migrate yet; the dispatch exists so version 2 adds a step
 * rather than retrofitting the mechanism.
 */
export function migrateDeckDocument(
  document: DeckDocument,
  fromVersion: number,
): { document: DeckDocument; warnings: string[] } {
  const warnings: string[] = [];
  let current = document;
  for (let version = fromVersion; version < DECK_SCHEMA_VERSION; version += 1) {
    const step = MIGRATIONS[version];
    if (!step) {
      warnings.push(`no migration from schema version ${version}; left unchanged`);
      break;
    }
    current = step(current, warnings);
  }
  return { document: { ...current, schemaVersion: DECK_SCHEMA_VERSION }, warnings };
}

/** Keyed by the version being migrated *from*. */
const MIGRATIONS: Record<number, (document: DeckDocument, warnings: string[]) => DeckDocument> = {};

/* ------------------------------------------------------------------------- */
/* Summary                                                                    */
/* ------------------------------------------------------------------------- */

export interface DeckDocumentStats {
  slides: number;
  hiddenSlides: number;
  elements: number;
  layouts: number;
}

export function deckDocumentStats(deck: DeckDocument): DeckDocumentStats {
  let elements = 0;
  let hiddenSlides = 0;
  for (const id of deck.slideOrder) {
    const slide = deck.slides[id];
    elements += Object.keys(slide.elements).length;
    if (slide.hidden) hiddenSlides += 1;
  }
  return {
    slides: deck.slideOrder.length,
    hiddenSlides,
    elements,
    layouts: Object.keys(deck.layouts).length,
  };
}
