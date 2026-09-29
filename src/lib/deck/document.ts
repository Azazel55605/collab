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
  DECK_DEFAULT_INSETS,
  DECK_DOCUMENT_KIND,
  DECK_EXTENSION,
  DECK_LIMITS,
  DECK_SCHEMA_VERSION,
  DECK_SIZE_PRESETS,
  DECK_UNITS_PER_POINT,
} from '../../types/deck';
import type {
  DeckDocument,
  DeckElement,
  DeckElementContainer,
  DeckLayout,
  DeckMaster,
  DeckSizePreset,
  DeckSlide,
  DeckTheme,
} from '../../types/deck';

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

const pt = (points: number) => points * DECK_UNITS_PER_POINT;

/**
 * The built-in theme. Ordinary document content: a deck carries its own copy,
 * so changing this default never restyles an existing deck.
 */
export function defaultDeckTheme(): DeckTheme {
  return {
    id: 'theme-default',
    name: 'Collab',
    colors: {
      dark1: '#111827',
      light1: '#ffffff',
      dark2: '#1f2937',
      light2: '#f3f4f6',
      accent1: '#6d5dfc',
      accent2: '#10b981',
      accent3: '#f59e0b',
      accent4: '#ef4444',
      accent5: '#0ea5e9',
      accent6: '#a855f7',
      hyperlink: '#2563eb',
      followedHyperlink: '#7c3aed',
    },
    fonts: {
      heading: { family: 'Inter', fallbacks: ['Arial', 'sans-serif'] },
      body: { family: 'Inter', fallbacks: ['Arial', 'sans-serif'] },
    },
  };
}

function container(elements: DeckElement[]): DeckElementContainer {
  return {
    elements: Object.fromEntries(elements.map((element) => [element.id, element])),
    elementOrder: elements.map((element) => element.id),
  };
}

function prompt(
  id: string,
  type: 'title' | 'subtitle' | 'body' | 'footer' | 'slideNumber',
  frame: DeckElement['frame'],
  align?: 'left' | 'center' | 'right',
): DeckElement {
  return {
    id,
    type: 'text',
    placeholder: { type, key: type === 'slideNumber' ? 'number' : type },
    ...(frame ? { frame } : {}),
    text: {
      content: {
        paragraphs: align ? [{ id: `${id}-p`, style: { align }, runs: [] }] : [],
      },
      insets: DECK_DEFAULT_INSETS,
      verticalAlign: type === 'title' ? 'bottom' : 'top',
    },
  };
}

/** Master and layouts sized for a slide, so every size preset gets sensible geometry. */
function defaultMasterAndLayouts(
  width: number,
  height: number,
  themeId: string,
): { master: DeckMaster; layouts: DeckLayout[] } {
  const margin = Math.round(width / 20);
  const inner = width - margin * 2;
  const titleHeight = Math.round(height * 0.15);
  const bodyTop = Math.round(height * 0.26);
  const footerTop = height - Math.round(height * 0.08);
  const footerHeight = Math.round(height * 0.05);

  const master: DeckMaster = {
    id: 'master-default',
    name: 'Default',
    themeId,
    background: { kind: 'solid', color: { kind: 'theme', token: 'light1' } },
    textStyles: {
      title: [
        {
          paragraph: { lineSpacing: 90 },
          run: {
            font: { theme: 'heading' },
            size: pt(40),
            bold: true,
            color: { kind: 'theme', token: 'dark1' },
          },
        },
      ],
      body: [
        {
          paragraph: { list: { kind: 'bullet', char: '•' }, spaceBefore: pt(10), indent: pt(24) },
          run: { font: { theme: 'body' }, size: pt(24), color: { kind: 'theme', token: 'dark2' } },
        },
        {
          paragraph: { list: { kind: 'bullet', char: '–' }, spaceBefore: pt(6), indent: pt(48) },
          run: { font: { theme: 'body' }, size: pt(20), color: { kind: 'theme', token: 'dark2' } },
        },
        {
          paragraph: { list: { kind: 'bullet', char: '•' }, spaceBefore: pt(4), indent: pt(72) },
          run: { font: { theme: 'body' }, size: pt(18), color: { kind: 'theme', token: 'dark2' } },
        },
      ],
      other: [
        {
          run: { font: { theme: 'body' }, size: pt(18), color: { kind: 'theme', token: 'dark1' } },
        },
      ],
    },
    ...container([
      prompt('master-title', 'title', {
        x: margin,
        y: Math.round(height * 0.06),
        width: inner,
        height: titleHeight,
      }),
      prompt('master-body', 'body', {
        x: margin,
        y: bodyTop,
        width: inner,
        height: footerTop - bodyTop - Math.round(height * 0.03),
      }),
      prompt('master-footer', 'footer', {
        x: margin,
        y: footerTop,
        width: Math.round(inner * 0.6),
        height: footerHeight,
      }),
      prompt(
        'master-number',
        'slideNumber',
        {
          x: width - margin - Math.round(inner * 0.1),
          y: footerTop,
          width: Math.round(inner * 0.1),
          height: footerHeight,
        },
        'right',
      ),
    ]),
  };

  const centred = (id: string, top: number, boxHeight: number, type: 'title' | 'subtitle') =>
    prompt(id, type, { x: margin, y: top, width: inner, height: boxHeight }, 'center');

  const layouts: DeckLayout[] = [
    {
      id: 'layout-title',
      name: 'Title slide',
      masterId: master.id,
      ...container([
        centred('layout-title-title', Math.round(height * 0.3), Math.round(height * 0.2), 'title'),
        centred(
          'layout-title-subtitle',
          Math.round(height * 0.52),
          Math.round(height * 0.12),
          'subtitle',
        ),
      ]),
    },
    {
      id: 'layout-content',
      name: 'Title and content',
      masterId: master.id,
      ...container([
        prompt('layout-content-title', 'title', undefined),
        prompt('layout-content-body', 'body', undefined),
      ]),
    },
    {
      id: 'layout-section',
      name: 'Section header',
      masterId: master.id,
      ...container([
        prompt('layout-section-title', 'title', {
          x: margin,
          y: Math.round(height * 0.35),
          width: inner,
          height: Math.round(height * 0.2),
        }),
      ]),
    },
    {
      id: 'layout-title-only',
      name: 'Title only',
      masterId: master.id,
      ...container([prompt('layout-title-only-title', 'title', undefined)]),
    },
    { id: 'layout-blank', name: 'Blank', masterId: master.id, ...container([]) },
  ];
  return { master, layouts };
}

export interface CreateDeckOptions {
  id: string;
  name: string;
  /** ISO timestamp; injected so creation is deterministic in tests. */
  now: string;
  sizePreset?: Exclude<DeckSizePreset, 'custom'>;
}

/**
 * A new deck: the default theme, one master, five layouts, and one empty title
 * slide. Everything is ordinary, inspectable document content.
 */
export function createDeckDocument(options: CreateDeckOptions): DeckDocument {
  const size = { ...DECK_SIZE_PRESETS[options.sizePreset ?? 'widescreen'] };
  const theme = defaultDeckTheme();
  const { master, layouts } = defaultMasterAndLayouts(size.width, size.height, theme.id);
  const firstSlide = createSlide('slide-1', 'layout-title', ['title', 'subtitle']);
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
export function newDeckContent(name: string): string {
  return serializeDeck(
    createDeckDocument({ id: `deck-${crypto.randomUUID()}`, name, now: new Date().toISOString() }),
  );
}

/** A slide on a layout, with an empty slide element for each named placeholder. */
export function createSlide(
  id: string,
  layoutId: string,
  placeholders: Array<'title' | 'subtitle' | 'body'>,
): DeckSlide {
  return {
    id,
    layoutId,
    ...container(
      placeholders.map((type): DeckElement => ({
        id: `${id}-${type}`,
        type: 'text',
        placeholder: { type, key: type },
        text: { content: { paragraphs: [] } },
      })),
    ),
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
