/**
 * The `.deck` trust boundary.
 *
 * Everything that reads a `.deck` from disk, the network, a paste, or a peer
 * validates it here first. A document that breaks a limit or a rule is
 * rejected with every problem listed — never repaired silently, never
 * truncated. Phase 1 mirrors these rules in `collab-documents` for the server.
 */
import {
  DECK_DOCUMENT_KIND,
  DECK_LIMITS,
  DECK_ROTATION_FULL_TURN,
  DECK_SCHEMA_VERSION,
  DECK_SHAPE_GEOMETRIES,
  DECK_THEME_COLOR_TOKENS,
} from '../../types/deck';
import type {
  DeckAssetRef,
  DeckDocument,
  DeckElement,
  DeckElementContainer,
  DeckFill,
  DeckFrame,
  DeckLine,
  DeckLink,
  DeckRichText,
  DeckTextBody,
} from '../../types/deck';

export interface DeckValidationIssue {
  path: string;
  message: string;
}

export type DeckValidationResult =
  { ok: true; deck: DeckDocument } | { ok: false; issues: DeckValidationIssue[] };

/** Media types a deck may reference. Everything else is rejected, including scripts in SVG wrappers. */
export const DECK_ALLOWED_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

const MAX_ISSUES = 200;

class Collector {
  readonly issues: DeckValidationIssue[] = [];
  elementCount = 0;
  textCount = 0;

  fail(path: string, message: string): void {
    if (this.issues.length < MAX_ISSUES) this.issues.push({ path, message });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function checkString(
  c: Collector,
  path: string,
  value: unknown,
  max: number,
  required = true,
): void {
  if (value === undefined && !required) return;
  if (typeof value !== 'string') c.fail(path, 'must be a string');
  else if (value.length > max) c.fail(path, `is longer than ${max} characters`);
}

function checkCoordinate(c: Collector, path: string, value: unknown, extent: number): void {
  // Non-finite values are rejected outright: a NaN is not a position at 0.
  if (!isInt(value)) c.fail(path, 'must be a finite integer in deck units');
  else if (Math.abs(value) > extent) c.fail(path, `is outside ±${extent} deck units`);
}

/**
 * A vault-relative path: no scheme, no absolute root, no `..`, no backslashes.
 * This is what stops a document pointing its renderer at a URL or a file
 * outside the vault.
 */
export function isSafeVaultPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1_024) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/') || path.includes('\\'))
    return false;
  return !path.split('/').some((segment) => segment === '..' || segment === '');
}

function checkColor(c: Collector, path: string, color: unknown): void {
  if (!isRecord(color)) return c.fail(path, 'must be a colour');
  if (color.kind === 'rgb') {
    if (typeof color.value !== 'string' || !/^#[0-9a-f]{6}$/i.test(color.value)) {
      c.fail(`${path}.value`, 'must be #rrggbb');
    }
  } else if (color.kind === 'theme') {
    if (!(DECK_THEME_COLOR_TOKENS as readonly unknown[]).includes(color.token)) {
      c.fail(`${path}.token`, 'is not a theme colour slot');
    }
  } else {
    c.fail(path, 'has an unknown colour kind');
  }
  if (color.alpha !== undefined && (!isInt(color.alpha) || color.alpha < 0 || color.alpha > 100)) {
    c.fail(`${path}.alpha`, 'must be an integer 0..100');
  }
}

function checkAsset(c: Collector, path: string, asset: unknown): void {
  if (!isRecord(asset)) return c.fail(path, 'must be an asset reference');
  const typed = asset as unknown as DeckAssetRef;
  if (!isSafeVaultPath(typed.path)) c.fail(`${path}.path`, 'must be a vault-relative path');
  if (!DECK_ALLOWED_MEDIA_TYPES.has(typed.mediaType))
    c.fail(`${path}.mediaType`, 'is not an allowed media type');
  if (
    !isInt(typed.pixelWidth) ||
    !isInt(typed.pixelHeight) ||
    typed.pixelWidth < 1 ||
    typed.pixelHeight < 1
  ) {
    c.fail(path, 'must record positive integer pixel dimensions');
  } else if (typed.pixelWidth * typed.pixelHeight > DECK_LIMITS.imagePixels) {
    c.fail(path, `exceeds ${DECK_LIMITS.imagePixels} decoded pixels`);
  }
}

function checkFill(c: Collector, path: string, fill: DeckFill | undefined): void {
  if (fill === undefined) return;
  if (!isRecord(fill)) return c.fail(path, 'must be a fill');
  if (fill.kind === 'solid') checkColor(c, `${path}.color`, fill.color);
  else if (fill.kind === 'image') checkAsset(c, `${path}.asset`, fill.asset);
  else if (fill.kind !== 'none') c.fail(path, 'has an unknown fill kind');
}

function checkLine(c: Collector, path: string, line: DeckLine | undefined): void {
  if (line === undefined) return;
  if (!isRecord(line)) return c.fail(path, 'must be a line style');
  checkColor(c, `${path}.color`, line.color);
  if (!isInt(line.width) || line.width < 0 || line.width > 100 * 100) {
    c.fail(`${path}.width`, 'must be an integer 0..100 pt');
  }
}

function checkLink(
  c: Collector,
  path: string,
  link: DeckLink | undefined,
  slideIds: Set<string>,
): void {
  if (link === undefined) return;
  if (link.kind === 'url') {
    // Only navigable, non-executing schemes. `javascript:` and `data:` never pass.
    if (
      typeof link.href !== 'string' ||
      link.href.length > DECK_LIMITS.linkLength ||
      !/^(https?:\/\/|mailto:)/i.test(link.href)
    ) {
      c.fail(path, 'URL links must be http(s) or mailto');
    }
  } else if (link.kind === 'slide') {
    if (!slideIds.has(link.slideId)) c.fail(path, 'links to a missing slide');
  } else if (link.kind === 'vault') {
    if (!isSafeVaultPath(link.path)) c.fail(path, 'must be a vault-relative path');
  } else {
    c.fail(path, 'has an unknown link kind');
  }
}

function checkRichText(
  c: Collector,
  path: string,
  text: DeckRichText | undefined,
  slideIds: Set<string>,
): void {
  if (text === undefined) return;
  if (!isRecord(text) || !Array.isArray(text.paragraphs))
    return c.fail(path, 'must have paragraphs');
  if (text.paragraphs.length > DECK_LIMITS.paragraphsPerBody) {
    c.fail(path, `has more than ${DECK_LIMITS.paragraphsPerBody} paragraphs`);
    return;
  }
  const ids = new Set<string>();
  let characters = 0;
  text.paragraphs.forEach((paragraph, index) => {
    const at = `${path}.paragraphs[${index}]`;
    if (typeof paragraph.id !== 'string' || paragraph.id === '')
      c.fail(`${at}.id`, 'must be a non-empty id');
    else if (ids.has(paragraph.id)) c.fail(`${at}.id`, 'duplicates another paragraph id');
    ids.add(paragraph.id);
    const level = paragraph.style?.level;
    if (level !== undefined && (!isInt(level) || level < 0 || level >= DECK_LIMITS.listLevels)) {
      c.fail(`${at}.style.level`, `must be 0..${DECK_LIMITS.listLevels - 1}`);
    }
    if (!Array.isArray(paragraph.runs)) return c.fail(`${at}.runs`, 'must be an array');
    if (paragraph.runs.length > DECK_LIMITS.runsPerParagraph)
      c.fail(`${at}.runs`, 'has too many runs');
    paragraph.runs.forEach((run, runIndex) => {
      const runAt = `${at}.runs[${runIndex}]`;
      if (run.kind === 'text') {
        if (typeof run.text !== 'string') return c.fail(runAt, 'text must be a string');
        characters += run.text.length;
        checkLink(c, `${runAt}.link`, run.link, slideIds);
      } else if (run.kind !== 'break') {
        c.fail(runAt, 'has an unknown run kind');
      }
      const size = run.style?.size;
      if (
        size !== undefined &&
        (!isInt(size) || size < DECK_LIMITS.minFontSize || size > DECK_LIMITS.maxFontSize)
      ) {
        c.fail(`${runAt}.style.size`, 'is outside the font size range');
      }
      if (run.style?.color) checkColor(c, `${runAt}.style.color`, run.style.color);
    });
  });
  if (characters > DECK_LIMITS.textPerBody)
    c.fail(path, `has more than ${DECK_LIMITS.textPerBody} characters`);
  c.textCount += characters;
}

function checkTextBody(
  c: Collector,
  path: string,
  body: DeckTextBody | undefined,
  slideIds: Set<string>,
): void {
  if (body === undefined) return;
  if (!isRecord(body)) return c.fail(path, 'must be a text body');
  checkRichText(c, `${path}.content`, body.content, slideIds);
  if (
    body.insets !== undefined &&
    (!Array.isArray(body.insets) ||
      body.insets.length !== 4 ||
      !body.insets.every((inset) => isInt(inset) && inset >= 0))
  ) {
    c.fail(`${path}.insets`, 'must be four non-negative integers');
  }
}

function checkFrame(c: Collector, path: string, frame: DeckFrame, extent: number): void {
  checkCoordinate(c, `${path}.x`, frame.x, extent);
  checkCoordinate(c, `${path}.y`, frame.y, extent);
  for (const key of ['width', 'height'] as const) {
    const value = frame[key];
    if (!isInt(value) || value < 0 || value > extent * 2)
      c.fail(`${path}.${key}`, 'must be a non-negative integer inside the canvas');
  }
  if (
    frame.rotation !== undefined &&
    (!isInt(frame.rotation) || frame.rotation < 0 || frame.rotation >= DECK_ROTATION_FULL_TURN)
  ) {
    c.fail(`${path}.rotation`, `must be an integer 0..${DECK_ROTATION_FULL_TURN - 1}`);
  }
}

function checkElement(
  c: Collector,
  path: string,
  element: DeckElement,
  extent: number,
  slideIds: Set<string>,
): void {
  const base = element as DeckElement & Record<string, unknown>;
  checkString(c, `${path}.name`, base.name, DECK_LIMITS.nameLength, false);
  checkString(c, `${path}.altText`, base.altText, DECK_LIMITS.altTextLength, false);
  if (
    base.opacity !== undefined &&
    (!isInt(base.opacity) || base.opacity < 0 || base.opacity > 100)
  ) {
    c.fail(`${path}.opacity`, 'must be an integer 0..100');
  }
  if (element.frame) checkFrame(c, `${path}.frame`, element.frame, extent);
  else if (!element.placeholder && element.type !== 'line') {
    c.fail(`${path}.frame`, 'is required unless inherited from a placeholder');
  }

  switch (element.type) {
    case 'text':
      checkTextBody(c, `${path}.text`, element.text, slideIds);
      checkFill(c, `${path}.fill`, element.fill);
      checkLine(c, `${path}.line`, element.line);
      break;
    case 'shape':
      if (!(DECK_SHAPE_GEOMETRIES as readonly string[]).includes(element.geometry))
        c.fail(`${path}.geometry`, 'is not a supported preset');
      checkTextBody(c, `${path}.text`, element.text, slideIds);
      checkFill(c, `${path}.fill`, element.fill);
      checkLine(c, `${path}.line`, element.line);
      break;
    case 'line':
      for (const end of ['from', 'to'] as const) {
        checkCoordinate(c, `${path}.${end}.x`, element[end]?.x, extent);
        checkCoordinate(c, `${path}.${end}.y`, element[end]?.y, extent);
      }
      checkLine(c, `${path}.line`, element.line);
      break;
    case 'image':
      checkAsset(c, `${path}.asset`, element.asset);
      if (element.crop) {
        const { left, top, right, bottom } = element.crop;
        if (
          ![left, top, right, bottom].every((value) => isInt(value) && value >= 0) ||
          left + right >= 1_000 ||
          top + bottom >= 1_000
        ) {
          c.fail(`${path}.crop`, 'must leave part of the image visible');
        }
      }
      break;
    case 'table': {
      if (element.rowOrder.length > DECK_LIMITS.tableRows)
        c.fail(`${path}.rowOrder`, 'has too many rows');
      if (element.columnOrder.length > DECK_LIMITS.tableColumns)
        c.fail(`${path}.columnOrder`, 'has too many columns');
      const keys = Object.keys(element.cells);
      if (keys.length > DECK_LIMITS.tableCells) c.fail(`${path}.cells`, 'has too many cells');
      const rows = new Set(element.rowOrder);
      const columns = new Set(element.columnOrder);
      for (const key of keys) {
        const [row, column] = key.split(':');
        if (!rows.has(row) || !columns.has(column))
          c.fail(`${path}.cells.${key}`, 'is not addressed by a row and column id');
        checkTextBody(c, `${path}.cells.${key}.text`, element.cells[key].text, slideIds);
        checkFill(c, `${path}.cells.${key}.fill`, element.cells[key].fill);
      }
      break;
    }
    case 'chart':
      if (element.series.length > DECK_LIMITS.chartSeries)
        c.fail(`${path}.series`, 'has too many series');
      if (element.categories.length > DECK_LIMITS.chartPointsPerSeries)
        c.fail(`${path}.categories`, 'has too many categories');
      element.series.forEach((series, index) => {
        if (series.values.length > DECK_LIMITS.chartPointsPerSeries)
          c.fail(`${path}.series[${index}]`, 'has too many points');
        if (!series.values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
          c.fail(`${path}.series[${index}].values`, 'must be finite numbers');
        }
      });
      if (element.source && !isSafeVaultPath(element.source.path))
        c.fail(`${path}.source.path`, 'must be a vault-relative path');
      break;
    case 'embed':
      if (!isSafeVaultPath(element.source?.path))
        c.fail(`${path}.source.path`, 'must be a vault-relative path');
      if (element.preview) checkAsset(c, `${path}.preview`, element.preview);
      break;
    case 'group':
      break;
    default:
      c.fail(path, 'has an unknown element type');
  }
}

/**
 * Structural checks for a map + order container: ids match keys, order lists
 * each top-level element once, groups reference existing children without
 * cycles, and nesting stays within the depth bound.
 */
function checkContainer(
  c: Collector,
  path: string,
  container: DeckElementContainer,
  extent: number,
  slideIds: Set<string>,
): void {
  if (!isRecord(container.elements) || !Array.isArray(container.elementOrder)) {
    return c.fail(path, 'must have elements and elementOrder');
  }
  const ids = Object.keys(container.elements);
  if (ids.length > DECK_LIMITS.elementsPerSlide)
    c.fail(path, `has more than ${DECK_LIMITS.elementsPerSlide} elements`);
  c.elementCount += ids.length;

  const parents = new Map<string, string>();
  for (const id of ids) {
    const element = container.elements[id];
    if (!isRecord(element) || element.id !== id) {
      c.fail(`${path}.elements.${id}`, 'id does not match its key');
      continue;
    }
    checkElement(c, `${path}.elements.${id}`, element, extent, slideIds);
    if (element.type === 'group') {
      for (const child of element.childIds) {
        if (!container.elements[child])
          c.fail(`${path}.elements.${id}.childIds`, `references missing ${child}`);
        else if (parents.has(child))
          c.fail(
            `${path}.elements.${id}.childIds`,
            `${child} already belongs to ${parents.get(child)}`,
          );
        else parents.set(child, id);
      }
    }
  }

  const seen = new Set<string>();
  for (const id of container.elementOrder) {
    if (!container.elements[id]) c.fail(`${path}.elementOrder`, `references missing ${id}`);
    else if (seen.has(id)) c.fail(`${path}.elementOrder`, `lists ${id} twice`);
    else if (parents.has(id))
      c.fail(`${path}.elementOrder`, `lists group child ${id} at the top level`);
    seen.add(id);
  }
  for (const id of ids) {
    if (!seen.has(id) && !parents.has(id))
      c.fail(`${path}.elements.${id}`, 'is neither ordered nor grouped');
  }

  // Depth and cycles: walk up the parent chain from every element.
  for (const id of ids) {
    let depth = 0;
    let current = parents.get(id);
    const visited = new Set([id]);
    while (current !== undefined) {
      if (visited.has(current)) {
        c.fail(`${path}.elements.${id}`, 'is part of a group cycle');
        break;
      }
      visited.add(current);
      depth += 1;
      if (depth > DECK_LIMITS.groupDepth) {
        c.fail(`${path}.elements.${id}`, `is nested deeper than ${DECK_LIMITS.groupDepth} groups`);
        break;
      }
      current = parents.get(current);
    }
  }
}

function checkCollection(
  c: Collector,
  path: string,
  value: unknown,
  max: number,
): value is Record<string, { id: string }> {
  if (!isRecord(value)) {
    c.fail(path, 'must be an id-keyed map');
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length > max) c.fail(path, `has more than ${max} entries`);
  for (const key of keys) {
    const entry = value[key];
    if (!isRecord(entry) || entry.id !== key) c.fail(`${path}.${key}`, 'id does not match its key');
  }
  return true;
}

/**
 * Counts JSON entries the way the server's generic parser does: every array
 * element and object value, at every depth. Stops early past `limit`.
 */
export function countJsonEntries(value: unknown, limit = Infinity, depth = 1): number {
  if (depth > DECK_LIMITS.jsonDepth) return Infinity;
  if (typeof value !== 'object' || value === null) return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  let total = children.length;
  for (const child of children) {
    if (total > limit) return total;
    total += countJsonEntries(child, limit - total, depth + 1);
  }
  return total;
}

export function validateDeck(value: unknown): DeckValidationResult {
  const c = new Collector();
  if (!isRecord(value)) return { ok: false, issues: [{ path: '', message: 'must be an object' }] };
  if (countJsonEntries(value, DECK_LIMITS.jsonEntries) > DECK_LIMITS.jsonEntries) {
    return {
      ok: false,
      issues: [
        {
          path: '',
          message: `has more than ${DECK_LIMITS.jsonEntries} JSON entries or ${DECK_LIMITS.jsonDepth} levels, the hosted parser limit`,
        },
      ],
    };
  }
  const deck = value as unknown as DeckDocument;

  if (deck.kind !== DECK_DOCUMENT_KIND) c.fail('kind', `must be ${DECK_DOCUMENT_KIND}`);
  if (deck.schemaVersion !== DECK_SCHEMA_VERSION)
    c.fail('schemaVersion', `must be ${DECK_SCHEMA_VERSION}`);
  checkString(c, 'id', deck.id, DECK_LIMITS.nameLength);
  checkString(c, 'name', deck.name, DECK_LIMITS.nameLength);

  const size = deck.size;
  if (!isRecord(size) || !isInt(size.width) || !isInt(size.height)) {
    c.fail('size', 'must have integer width and height');
  } else {
    for (const side of [size.width, size.height]) {
      if (side < DECK_LIMITS.minSlideSide || side > DECK_LIMITS.maxSlideSide)
        c.fail('size', 'is outside 1..56 inches');
    }
  }
  const extent = Math.max(size?.width ?? 0, size?.height ?? 0) + DECK_LIMITS.canvasOverscan;

  if (checkCollection(c, 'themes', deck.themes, DECK_LIMITS.themes)) {
    for (const theme of Object.values(deck.themes)) {
      for (const token of DECK_THEME_COLOR_TOKENS) {
        if (!/^#[0-9a-f]{6}$/i.test(theme.colors?.[token] ?? ''))
          c.fail(`themes.${theme.id}.colors.${token}`, 'must be #rrggbb');
      }
      checkString(
        c,
        `themes.${theme.id}.fonts.heading.family`,
        theme.fonts?.heading?.family,
        DECK_LIMITS.nameLength,
      );
      checkString(
        c,
        `themes.${theme.id}.fonts.body.family`,
        theme.fonts?.body?.family,
        DECK_LIMITS.nameLength,
      );
    }
    if (!deck.themes[deck.themeId]) c.fail('themeId', 'references a missing theme');
  }

  const slideIds = new Set(isRecord(deck.slides) ? Object.keys(deck.slides) : []);

  if (checkCollection(c, 'masters', deck.masters, DECK_LIMITS.masters)) {
    if (Object.keys(deck.masters).length === 0)
      c.fail('masters', 'must contain at least one master');
    for (const master of Object.values(deck.masters)) {
      if (master.themeId !== undefined && !deck.themes?.[master.themeId])
        c.fail(`masters.${master.id}.themeId`, 'references a missing theme');
      checkFill(c, `masters.${master.id}.background`, master.background);
      checkContainer(c, `masters.${master.id}`, master, extent, slideIds);
    }
  }
  if (checkCollection(c, 'layouts', deck.layouts, DECK_LIMITS.layouts)) {
    for (const layout of Object.values(deck.layouts)) {
      if (!deck.masters?.[layout.masterId])
        c.fail(`layouts.${layout.id}.masterId`, 'references a missing master');
      checkFill(c, `layouts.${layout.id}.background`, layout.background);
      checkContainer(c, `layouts.${layout.id}`, layout, extent, slideIds);
    }
  }
  if (checkCollection(c, 'slides', deck.slides, DECK_LIMITS.slides)) {
    for (const slide of Object.values(deck.slides)) {
      const at = `slides.${slide.id}`;
      if (slide.layoutId !== undefined && !deck.layouts?.[slide.layoutId])
        c.fail(`${at}.layoutId`, 'references a missing layout');
      checkFill(c, `${at}.background`, slide.background);
      checkContainer(c, at, slide, extent, slideIds);
      checkRichText(c, `${at}.speakerNotes`, slide.speakerNotes, slideIds);
      const animations = slide.animations ?? [];
      if (animations.length > DECK_LIMITS.animationsPerSlide)
        c.fail(`${at}.animations`, 'has too many animations');
      animations.forEach((animation, index) => {
        if (!slide.elements[animation.elementId])
          c.fail(`${at}.animations[${index}]`, 'targets a missing element');
        if (
          !isInt(animation.durationMs) ||
          animation.durationMs < 0 ||
          animation.durationMs > DECK_LIMITS.animationDurationMs
        ) {
          c.fail(`${at}.animations[${index}].durationMs`, 'is out of range');
        }
      });
    }
  }

  if (!Array.isArray(deck.slideOrder)) {
    c.fail('slideOrder', 'must be an array');
  } else {
    const ordered = new Set<string>();
    for (const id of deck.slideOrder) {
      if (!slideIds.has(id)) c.fail('slideOrder', `references missing slide ${id}`);
      else if (ordered.has(id)) c.fail('slideOrder', `lists ${id} twice`);
      ordered.add(id);
    }
    for (const id of slideIds) if (!ordered.has(id)) c.fail(`slides.${id}`, 'is not in slideOrder');
  }

  const sections = deck.sections ?? [];
  if (sections.length > DECK_LIMITS.sections) c.fail('sections', 'has too many sections');
  sections.forEach((section, index) => {
    if (!slideIds.has(section.firstSlideId))
      c.fail(`sections[${index}]`, 'starts at a missing slide');
  });

  if (deck.metadata !== undefined) {
    if (
      !isRecord(deck.metadata) ||
      Object.keys(deck.metadata).length > DECK_LIMITS.metadataEntries
    ) {
      c.fail('metadata', `must be at most ${DECK_LIMITS.metadataEntries} entries`);
    } else {
      for (const [key, entry] of Object.entries(deck.metadata)) {
        if (
          !['string', 'number', 'boolean'].includes(typeof entry) ||
          (typeof entry === 'string' && entry.length > DECK_LIMITS.linkLength)
        ) {
          c.fail(`metadata.${key}`, 'must be a short string, number, or boolean');
        }
      }
    }
  }

  if (c.elementCount > DECK_LIMITS.elementsPerDeck)
    c.fail('', `has more than ${DECK_LIMITS.elementsPerDeck} elements`);
  if (c.textCount > DECK_LIMITS.textPerDeck)
    c.fail('', `has more than ${DECK_LIMITS.textPerDeck} characters of text`);

  return c.issues.length === 0 ? { ok: true, deck } : { ok: false, issues: c.issues };
}

/** Parses and validates serialized JSON, enforcing the byte limit before parsing. */
export function parseDeck(json: string): DeckValidationResult {
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > DECK_LIMITS.documentBytes) {
    return {
      ok: false,
      issues: [{ path: '', message: `document exceeds ${DECK_LIMITS.documentBytes} bytes` }],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, issues: [{ path: '', message: 'is not valid JSON' }] };
  }
  return validateDeck(value);
}

/**
 * Deterministic serialization: object keys sorted recursively, two-space
 * indentation. Order-bearing data lives in explicit arrays (`slideOrder`,
 * `elementOrder`), so sorting map keys never changes meaning — it only makes
 * two saves of the same deck byte-identical.
 */
export function serializeDeck(deck: DeckDocument): string {
  return `${JSON.stringify(sortKeys(deck), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}
