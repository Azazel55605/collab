/**
 * The shared slide scene resolver.
 *
 * Every output — the editor stage, thumbnails, presentation mode, SVG, PDF,
 * images, and the PowerPoint exporter — consumes the `ResolvedSlide` this
 * produces. Outputs differ only in how they draw it and at what scale; none of
 * them resolves inheritance, theme colours, fonts, fields, or paint order on
 * its own. A second resolver is how an exported slide stops matching the
 * editor.
 *
 * The resolved scene is in deck units and has no notion of zoom or device
 * pixels, which is what lets one scene serve every output.
 *
 * Inheritance, lowest priority first:
 *
 *   theme → master text styles → master placeholder → layout placeholder → slide
 *
 * Placeholders match by `placeholder.key`, then by `placeholder.type`.
 */
import { DECK_LIMITS, DECK_UNITS_PER_POINT } from '../../types/deck';
import type {
  DeckArrowhead,
  DeckAssetRef,
  DeckChartKind,
  DeckColor,
  DeckCrop,
  DeckDash,
  DeckDocument,
  DeckElement,
  DeckElementContainer,
  DeckFill,
  DeckFrame,
  DeckLayout,
  DeckLine,
  DeckLink,
  DeckList,
  DeckMaster,
  DeckParagraph,
  DeckParagraphStyle,
  DeckPlaceholderType,
  DeckRunStyle,
  DeckShapeGeometry,
  DeckSlide,
  DeckTextAlign,
  DeckTextBody,
  DeckTextLevelStyle,
  DeckTheme,
  DeckThemeColorToken,
  DeckVerticalAlign,
} from '../../types/deck';
import { DECK_DEFAULT_INSETS } from '../../types/deck';

import { isRichTextEmpty } from './richText';

/* ------------------------------------------------------------------------- */
/* Resolved types                                                             */
/* ------------------------------------------------------------------------- */

/** A concrete colour: `#rrggbb` plus 0..1 alpha. */
export interface ResolvedColor {
  hex: string;
  alpha: number;
}

export type ResolvedFill =
  | { kind: 'none' }
  | { kind: 'solid'; color: ResolvedColor }
  | { kind: 'image'; asset: DeckAssetRef; fit: 'cover' | 'contain' | 'stretch' };

export interface ResolvedLine {
  color: ResolvedColor;
  width: number;
  dash: DeckDash;
}

export interface ResolvedFont {
  family: string;
  /** Families to try in order when `family` is unavailable. */
  fallbacks: string[];
}

export interface ResolvedRunStyle {
  font: ResolvedFont;
  /** Hundredths of a point, the same unit as geometry. */
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: ResolvedColor;
  baseline: 'normal' | 'superscript' | 'subscript';
  lang?: string;
}

export type ResolvedRun =
  | { kind: 'text'; text: string; style: ResolvedRunStyle; link?: DeckLink }
  | { kind: 'break'; style: ResolvedRunStyle };

export interface ResolvedParagraph {
  id: string;
  align: DeckTextAlign;
  level: number;
  /** The list label text actually drawn ("•", "3.", "c."), or null. */
  label: string | null;
  indent: number;
  spaceBefore: number;
  spaceAfter: number;
  lineSpacing: number;
  runs: ResolvedRun[];
  /** Style an empty paragraph renders its line height at. */
  endStyle: ResolvedRunStyle;
}

export interface ResolvedTextBody {
  paragraphs: ResolvedParagraph[];
  insets: [number, number, number, number];
  verticalAlign: DeckVerticalAlign;
  autoFit: 'none' | 'shrink' | 'grow';
  wrap: boolean;
}

export type ResolvedOrigin = 'master' | 'layout' | 'slide';

interface ResolvedItemBase {
  id: string;
  origin: ResolvedOrigin;
  frame: Required<DeckFrame>;
  /** 0..1, already multiplied through enclosing groups. */
  opacity: number;
  placeholder?: DeckPlaceholderType;
  altText?: string;
  name?: string;
}

export interface ResolvedShapeItem extends ResolvedItemBase {
  kind: 'shape';
  /**
   * The text is a placeholder prompt ("Click to add title"), not content.
   * Only produced when resolving with `prompts`, i.e. for the editor.
   */
  prompt?: boolean;
  /** Text elements resolve to rectangles with text. */
  elementType: 'text' | 'shape';
  geometry: DeckShapeGeometry;
  fill: ResolvedFill;
  line: ResolvedLine | null;
  text: ResolvedTextBody | null;
}

export interface ResolvedLineItem extends ResolvedItemBase {
  kind: 'line';
  from: { x: number; y: number };
  to: { x: number; y: number };
  line: ResolvedLine;
  startArrow: DeckArrowhead;
  endArrow: DeckArrowhead;
}

export interface ResolvedImageItem extends ResolvedItemBase {
  kind: 'image';
  asset: DeckAssetRef;
  crop: DeckCrop;
  line: ResolvedLine | null;
}

export interface ResolvedTableCell {
  rowId: string;
  columnId: string;
  /** Absolute slide geometry of the (possibly merged) cell. */
  x: number;
  y: number;
  width: number;
  height: number;
  rowSpan: number;
  colSpan: number;
  fill: ResolvedFill;
  text: ResolvedTextBody;
}

export interface ResolvedTableItem extends ResolvedItemBase {
  kind: 'table';
  rowIds: string[];
  columnIds: string[];
  columnWidths: number[];
  rowHeights: number[];
  cells: ResolvedTableCell[];
  border: ResolvedLine | null;
  headerRow: boolean;
}

export interface ResolvedChartItem extends ResolvedItemBase {
  kind: 'chart';
  chartKind: DeckChartKind;
  title: string | null;
  categories: string[];
  series: Array<{ id: string; name: string; values: number[]; color: ResolvedColor }>;
  showLegend: boolean;
  textStyle: ResolvedRunStyle;
}

export interface ResolvedEmbedItem extends ResolvedItemBase {
  kind: 'embed';
  source: { path: string; view?: string };
  preview: DeckAssetRef | null;
}

export type ResolvedItem =
  | ResolvedShapeItem
  | ResolvedLineItem
  | ResolvedImageItem
  | ResolvedTableItem
  | ResolvedChartItem
  | ResolvedEmbedItem;

export interface ResolvedSlide {
  /** The slide id, or the layout or master id when resolving one for editing. */
  slideId: string;
  /** 1-based position in `slideOrder`, used for slide-number fields. */
  number: number;
  width: number;
  height: number;
  hidden: boolean;
  background: ResolvedFill;
  /** Paint order, back to front. Groups are flattened into their children. */
  items: ResolvedItem[];
  /** Slide-owned object ids in assistive-technology reading order. */
  readingOrder: string[];
  notes: ResolvedTextBody | null;
  theme: DeckTheme;
}

/** What the editor edits: a slide, or a layout or master of the deck's design. */
export type DeckTarget = { kind: 'slide' | 'layout' | 'master'; id: string };

export interface ResolveOptions {
  /**
   * Fill empty placeholders with their prompt text, as the editor shows them.
   * Thumbnails, playback, and every export leave them empty.
   */
  prompts?: boolean;
}

/** The prompt an empty placeholder shows when its layout does not define one. */
export function defaultPromptText(type: DeckPlaceholderType): string {
  switch (type) {
    case 'title':
      return 'Click to add title';
    case 'subtitle':
      return 'Click to add subtitle';
    case 'body':
    case 'content':
      return 'Click to add text';
    case 'picture':
      return 'Picture';
    case 'date':
      return 'Date';
    case 'footer':
      return 'Footer';
    case 'slideNumber':
      return '‹#›';
  }
}

/** How much a prompt's colours are dimmed on a slide, so it never reads as content. */
const PROMPT_ALPHA = 0.5;

export class DeckResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeckResolveError';
  }
}

/* ------------------------------------------------------------------------- */
/* Colours and fonts                                                          */
/* ------------------------------------------------------------------------- */

const FALLBACK_TEXT_SIZE = 18 * DECK_UNITS_PER_POINT;

export function resolveColor(color: DeckColor, theme: DeckTheme): ResolvedColor {
  const hex = color.kind === 'rgb' ? color.value : theme.colors[color.token];
  const alpha = (color.alpha ?? 100) / 100;
  return { hex: normalizeHex(hex), alpha: Math.min(1, Math.max(0, alpha)) };
}

function normalizeHex(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : '#000000';
}

export function resolveFill(fill: DeckFill | undefined, theme: DeckTheme): ResolvedFill {
  if (!fill || fill.kind === 'none') return { kind: 'none' };
  if (fill.kind === 'solid') return { kind: 'solid', color: resolveColor(fill.color, theme) };
  return { kind: 'image', asset: fill.asset, fit: fill.fit };
}

function resolveLine(line: DeckLine | undefined, theme: DeckTheme): ResolvedLine | null {
  if (!line || line.width <= 0) return null;
  return { color: resolveColor(line.color, theme), width: line.width, dash: line.dash ?? 'solid' };
}

function resolveFont(font: DeckRunStyle['font'], theme: DeckTheme): ResolvedFont {
  if (font === undefined) return resolveFont({ theme: 'body' }, theme);
  if (typeof font === 'string') return { family: font, fallbacks: ['sans-serif'] };
  const themeFont = theme.fonts[font.theme];
  return { family: themeFont.family, fallbacks: [...(themeFont.fallbacks ?? [])] };
}

/* ------------------------------------------------------------------------- */
/* Text                                                                       */
/* ------------------------------------------------------------------------- */

type TextClass = 'title' | 'body' | 'other';

function textClassFor(type: DeckPlaceholderType | undefined): TextClass {
  if (type === 'title') return 'title';
  if (type === 'body' || type === 'content' || type === 'subtitle') return 'body';
  return 'other';
}

function mergeRunStyle(base: DeckRunStyle, over: DeckRunStyle | undefined): DeckRunStyle {
  if (!over) return base;
  const merged: DeckRunStyle = { ...base };
  for (const [key, value] of Object.entries(over) as Array<[keyof DeckRunStyle, unknown]>) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

function mergeParagraphStyle(
  base: DeckParagraphStyle,
  over: DeckParagraphStyle | undefined,
): DeckParagraphStyle {
  if (!over) return base;
  const merged: DeckParagraphStyle = { ...base };
  for (const [key, value] of Object.entries(over) as Array<[keyof DeckParagraphStyle, unknown]>) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

function levelStyle(styles: DeckTextLevelStyle[], level: number): DeckTextLevelStyle {
  if (styles.length === 0) return {};
  return styles[Math.min(level, styles.length - 1)];
}

/**
 * The paragraph and run defaults a placeholder prompt carries for a level: the
 * prompt paragraph at that level if it has one, otherwise its first paragraph.
 */
function promptStyle(body: DeckTextBody | undefined, level: number): DeckTextLevelStyle {
  const paragraphs = body?.content.paragraphs ?? [];
  const match =
    paragraphs.find((candidate) => (candidate.style?.level ?? 0) === level) ?? paragraphs[0];
  if (!match) return {};
  const firstRun = match.runs.find((run) => run.style)?.style;
  const { level: _ignored, ...paragraphStyle } = match.style ?? {};
  return { paragraph: paragraphStyle, run: mergeRunStyle(match.endStyle ?? {}, firstRun) };
}

function finalizeRunStyle(style: DeckRunStyle, theme: DeckTheme): ResolvedRunStyle {
  const size = Math.min(
    DECK_LIMITS.maxFontSize,
    Math.max(DECK_LIMITS.minFontSize, style.size ?? FALLBACK_TEXT_SIZE),
  );
  return {
    font: resolveFont(style.font, theme),
    size,
    bold: style.bold ?? false,
    italic: style.italic ?? false,
    underline: style.underline ?? false,
    strike: style.strike ?? false,
    color: resolveColor(style.color ?? { kind: 'theme', token: 'dark1' }, theme),
    baseline: style.baseline ?? 'normal',
    ...(style.lang ? { lang: style.lang } : {}),
  };
}

const ROMAN: Array<[number, string]> = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

function listLabel(list: DeckList, ordinal: number): string {
  if (list.kind === 'bullet') return list.char ?? '•';
  const n = (list.startAt ?? 1) + ordinal;
  switch (list.numberStyle ?? 'arabicPeriod') {
    case 'alphaLcPeriod':
    case 'alphaUcPeriod': {
      let value = n;
      let label = '';
      while (value > 0) {
        value -= 1;
        label = String.fromCharCode(97 + (value % 26)) + label;
        value = Math.floor(value / 26);
      }
      return `${list.numberStyle === 'alphaUcPeriod' ? label.toUpperCase() : label}.`;
    }
    case 'romanLcPeriod': {
      let value = n;
      let label = '';
      for (const [amount, glyph] of ROMAN) {
        while (value >= amount) {
          label += glyph;
          value -= amount;
        }
      }
      return `${label}.`;
    }
    default:
      return `${n}.`;
  }
}

interface TextContext {
  theme: DeckTheme;
  master: DeckMaster;
  textClass: TextClass;
  /** Placeholder prompt bodies, master first, then layout. */
  prompts: Array<DeckTextBody | undefined>;
  /** A number on slides; the `‹#›` token when editing a layout or master. */
  fields: { slideNumber: number | string };
  placeholderType?: DeckPlaceholderType;
}

function resolveParagraphs(paragraphs: DeckParagraph[], context: TextContext): ResolvedParagraph[] {
  // Numbering restarts whenever a paragraph at the same level is not numbered.
  const counters = new Array<number>(DECK_LIMITS.listLevels).fill(0);
  const resolved: ResolvedParagraph[] = [];

  for (const source of paragraphs) {
    const level = Math.min(DECK_LIMITS.listLevels - 1, Math.max(0, source.style?.level ?? 0));
    const master = levelStyle(context.master.textStyles[context.textClass], level);
    let paragraphStyle: DeckParagraphStyle = mergeParagraphStyle({}, master.paragraph);
    // Subtitles use the body text style without its bullets and hanging indent,
    // as PowerPoint's subtitle placeholders do.
    if (context.placeholderType === 'subtitle') {
      delete paragraphStyle.list;
      delete paragraphStyle.indent;
    }
    let runStyle: DeckRunStyle = mergeRunStyle({}, master.run);
    for (const prompt of context.prompts) {
      const inherited = promptStyle(prompt, level);
      paragraphStyle = mergeParagraphStyle(paragraphStyle, inherited.paragraph);
      runStyle = mergeRunStyle(runStyle, inherited.run);
    }
    paragraphStyle = mergeParagraphStyle(paragraphStyle, source.style);

    const list = paragraphStyle.list ?? null;
    let label: string | null = null;
    if (list) {
      label = listLabel(list, counters[level]);
      counters[level] = list.kind === 'number' ? counters[level] + 1 : 0;
    } else {
      counters[level] = 0;
    }
    for (let deeper = level + 1; deeper < counters.length; deeper += 1) counters[deeper] = 0;

    const runs: ResolvedRun[] = source.runs.map((run) => {
      // Links draw in the theme's hyperlink colour, underlined, unless the run says otherwise.
      const base =
        run.kind === 'text' && run.link
          ? mergeRunStyle(runStyle, {
              color: { kind: 'theme', token: 'hyperlink' },
              underline: true,
            })
          : runStyle;
      const style = finalizeRunStyle(mergeRunStyle(base, run.style), context.theme);
      if (run.kind === 'break') return { kind: 'break', style };
      return run.link
        ? { kind: 'text', text: run.text, style, link: run.link }
        : { kind: 'text', text: run.text, style };
    });

    // Fields: an empty slide-number placeholder shows the slide's number.
    const endStyle = finalizeRunStyle(mergeRunStyle(runStyle, source.endStyle), context.theme);
    if (
      context.placeholderType === 'slideNumber' &&
      runs.every((run) => run.kind === 'text' && run.text === '')
    ) {
      runs.splice(0, runs.length, {
        kind: 'text',
        text: String(context.fields.slideNumber),
        style: endStyle,
      });
    }

    resolved.push({
      id: source.id,
      align: paragraphStyle.align ?? 'left',
      level,
      label,
      indent: paragraphStyle.indent ?? 0,
      spaceBefore: paragraphStyle.spaceBefore ?? 0,
      spaceAfter: paragraphStyle.spaceAfter ?? 0,
      lineSpacing: paragraphStyle.lineSpacing ?? 100,
      runs,
      endStyle,
    });
  }
  return resolved;
}

function resolveTextBody(
  body: DeckTextBody | undefined,
  inherited: Array<DeckTextBody | undefined>,
  context: TextContext,
): ResolvedTextBody {
  const pick = <K extends keyof DeckTextBody>(key: K): DeckTextBody[K] | undefined => {
    if (body?.[key] !== undefined) return body[key];
    for (let index = inherited.length - 1; index >= 0; index -= 1) {
      const value = inherited[index]?.[key];
      if (value !== undefined) return value;
    }
    return undefined;
  };
  return {
    paragraphs: resolveParagraphs(body?.content.paragraphs ?? [], context),
    insets: pick('insets') ?? DECK_DEFAULT_INSETS,
    verticalAlign: pick('verticalAlign') ?? 'top',
    autoFit: pick('autoFit') ?? 'none',
    wrap: pick('wrap') ?? true,
  };
}

/* ------------------------------------------------------------------------- */
/* Elements                                                                   */
/* ------------------------------------------------------------------------- */

function fullFrame(frame: DeckFrame): Required<DeckFrame> {
  return {
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
    rotation: frame.rotation ?? 0,
    flipH: frame.flipH ?? false,
    flipV: frame.flipV ?? false,
  };
}

/** The placeholder in a layout or master that an element inherits from: by key, then by type. */
export function findPlaceholder(
  container: DeckElementContainer | undefined,
  ref: DeckElement['placeholder'],
): DeckElement | undefined {
  if (!container || !ref) return undefined;
  const elements = Object.values(container.elements);
  return (
    elements.find((element) => element.placeholder?.key === ref.key) ??
    elements.find((element) => element.placeholder?.type === ref.type)
  );
}

interface ResolveScope {
  deck: DeckDocument;
  theme: DeckTheme;
  master: DeckMaster;
  layout: DeckLayout | undefined;
  slideNumber: number | string;
  prompts: boolean;
}

function resolveElement(
  element: DeckElement,
  container: DeckElementContainer,
  origin: ResolvedOrigin,
  scope: ResolveScope,
  inheritedOpacity: number,
  depth: number,
  output: ResolvedItem[],
): void {
  if (element.hidden) return;
  if (depth > DECK_LIMITS.groupDepth) {
    throw new DeckResolveError(`Group nesting exceeds ${DECK_LIMITS.groupDepth} levels.`);
  }

  // The placeholder chain this element inherits from, lowest priority first.
  const chain: DeckElement[] = [];
  if (element.placeholder && origin !== 'master') {
    const fromMaster = findPlaceholder(scope.master, element.placeholder);
    if (fromMaster) chain.push(fromMaster);
    if (origin === 'slide') {
      const fromLayout = findPlaceholder(scope.layout, element.placeholder);
      if (fromLayout) chain.push(fromLayout);
    }
  }

  const frameSource = element.frame ?? [...chain].reverse().find((entry) => entry.frame)?.frame;
  const opacity = inheritedOpacity * ((element.opacity ?? 100) / 100);
  const base = {
    id: element.id,
    origin,
    opacity,
    ...(element.placeholder ? { placeholder: element.placeholder.type } : {}),
    ...(element.altText ? { altText: element.altText } : {}),
    ...(element.name ? { name: element.name } : {}),
  };

  if (element.type === 'line') {
    const minX = Math.min(element.from.x, element.to.x);
    const minY = Math.min(element.from.y, element.to.y);
    output.push({
      ...base,
      kind: 'line',
      frame: fullFrame({
        x: minX,
        y: minY,
        width: Math.abs(element.to.x - element.from.x),
        height: Math.abs(element.to.y - element.from.y),
      }),
      from: element.from,
      to: element.to,
      line: resolveLine(element.line, scope.theme) ?? {
        color: { hex: '#000000', alpha: 1 },
        width: DECK_UNITS_PER_POINT,
        dash: 'solid',
      },
      startArrow: element.startArrow ?? 'none',
      endArrow: element.endArrow ?? 'none',
    });
    return;
  }

  if (!frameSource) {
    throw new DeckResolveError(
      `Element ${element.id} has no frame and no placeholder to inherit one from.`,
    );
  }
  const frame = fullFrame(frameSource);

  if (element.type === 'group') {
    for (const childId of element.childIds) {
      const child = container.elements[childId];
      if (!child) continue;
      if (child.id === element.id)
        throw new DeckResolveError(`Group ${element.id} contains itself.`);
      resolveElement(child, container, origin, scope, opacity, depth + 1, output);
    }
    return;
  }

  const textContext = (placeholderType: DeckPlaceholderType | undefined): TextContext => ({
    theme: scope.theme,
    master: scope.master,
    textClass: textClassFor(placeholderType),
    prompts: chain.map((entry) => ('text' in entry ? entry.text : undefined)),
    fields: { slideNumber: scope.slideNumber },
    ...(placeholderType ? { placeholderType } : {}),
  });

  switch (element.type) {
    case 'text':
    case 'shape': {
      const inheritedBodies = chain.map((entry) =>
        entry.type === 'text' || entry.type === 'shape' ? entry.text : undefined,
      );
      const inheritedFill = [...chain]
        .reverse()
        .find((entry) => (entry.type === 'text' || entry.type === 'shape') && entry.fill);
      const inheritedLine = [...chain]
        .reverse()
        .find((entry) => (entry.type === 'text' || entry.type === 'shape') && entry.line);
      const fill =
        element.fill ??
        (inheritedFill && 'fill' in inheritedFill ? (inheritedFill.fill as DeckFill) : undefined);
      const line =
        element.line ??
        (inheritedLine && 'line' in inheritedLine ? (inheritedLine.line as DeckLine) : undefined);
      let body = element.text;
      let prompt = false;
      const placeholderType = element.placeholder?.type;
      if (
        scope.prompts &&
        placeholderType &&
        placeholderType !== 'slideNumber' &&
        isRichTextEmpty(body?.content)
      ) {
        // A slide shows its layout's prompt text; a layout or master shows the default.
        const custom =
          origin === 'slide'
            ? [...inheritedBodies].reverse().find((entry) => !isRichTextEmpty(entry?.content))
            : undefined;
        const own = body?.content.paragraphs[0];
        body = {
          ...(body ?? {}),
          content: custom?.content ?? {
            paragraphs: [
              {
                ...(own ?? { id: `${element.id}-prompt` }),
                runs: [{ kind: 'text', text: defaultPromptText(placeholderType) }],
              },
            ],
          },
        };
        prompt = true;
      }
      let text =
        body || inheritedBodies.some(Boolean)
          ? resolveTextBody(body, inheritedBodies, textContext(placeholderType))
          : null;
      if (text && prompt && origin === 'slide') text = dimmed(text);
      output.push({
        ...base,
        kind: 'shape',
        elementType: element.type,
        geometry: element.type === 'shape' ? element.geometry : 'rect',
        frame,
        fill: resolveFill(fill, scope.theme),
        line: resolveLine(line, scope.theme),
        text,
        ...(prompt ? { prompt: true } : {}),
      });
      return;
    }
    case 'image':
      output.push({
        ...base,
        kind: 'image',
        frame,
        asset: element.asset,
        crop: element.crop ?? { left: 0, top: 0, right: 0, bottom: 0 },
        line: resolveLine(element.line, scope.theme),
      });
      return;
    case 'table': {
      const columnWidths = element.columnOrder.map((id) => element.columnWidths[id] ?? 0);
      const rowHeights = element.rowOrder.map((id) => element.rowHeights[id] ?? 0);
      const columnX = prefixSums(frame.x, columnWidths);
      const rowY = prefixSums(frame.y, rowHeights);
      const covered = new Set<string>();
      const cells: ResolvedTableCell[] = [];
      element.rowOrder.forEach((rowId, row) => {
        element.columnOrder.forEach((columnId, column) => {
          const key = `${rowId}:${columnId}`;
          if (covered.has(key)) return;
          const cell = element.cells[key];
          const rowSpan = Math.max(1, Math.min(cell?.rowSpan ?? 1, element.rowOrder.length - row));
          const colSpan = Math.max(
            1,
            Math.min(cell?.colSpan ?? 1, element.columnOrder.length - column),
          );
          for (let r = row; r < row + rowSpan; r += 1) {
            for (let c = column; c < column + colSpan; c += 1) {
              covered.add(`${element.rowOrder[r]}:${element.columnOrder[c]}`);
            }
          }
          cells.push({
            rowId,
            columnId,
            x: columnX[column],
            y: rowY[row],
            width: columnX[column + colSpan] - columnX[column],
            height: rowY[row + rowSpan] - rowY[row],
            rowSpan,
            colSpan,
            fill: resolveFill(cell?.fill, scope.theme),
            text: resolveTextBody(cell?.text, [], textContext(undefined)),
          });
        });
      });
      output.push({
        ...base,
        kind: 'table',
        frame,
        rowIds: [...element.rowOrder],
        columnIds: [...element.columnOrder],
        columnWidths,
        rowHeights,
        cells,
        border: resolveLine(element.border, scope.theme),
        headerRow: element.headerRow ?? false,
      });
      return;
    }
    case 'chart': {
      const accents: DeckThemeColorToken[] = [
        'accent1',
        'accent2',
        'accent3',
        'accent4',
        'accent5',
        'accent6',
      ];
      const other = levelStyle(scope.master.textStyles.other, 0);
      output.push({
        ...base,
        kind: 'chart',
        frame,
        chartKind: element.kind,
        title: element.title ?? null,
        categories: [...element.categories],
        series: element.series.map((series, index) => ({
          id: series.id,
          name: series.name,
          values: series.values.map((value) => (Number.isFinite(value) ? value : 0)),
          color: resolveColor(
            series.color ?? { kind: 'theme', token: accents[index % accents.length] },
            scope.theme,
          ),
        })),
        showLegend: element.showLegend ?? false,
        textStyle: finalizeRunStyle(
          mergeRunStyle(other.run ?? {}, { size: 14 * DECK_UNITS_PER_POINT }),
          scope.theme,
        ),
      });
      return;
    }
    case 'embed':
      output.push({
        ...base,
        kind: 'embed',
        frame,
        source: element.source,
        preview: element.preview ?? null,
      });
      return;
  }
}

function dimmed(body: ResolvedTextBody): ResolvedTextBody {
  const dim = (style: ResolvedRunStyle): ResolvedRunStyle => ({
    ...style,
    color: { ...style.color, alpha: style.color.alpha * PROMPT_ALPHA },
  });
  return {
    ...body,
    paragraphs: body.paragraphs.map((paragraph) => ({
      ...paragraph,
      endStyle: dim(paragraph.endStyle),
      runs: paragraph.runs.map((run) => ({ ...run, style: dim(run.style) })),
    })),
  };
}

function prefixSums(start: number, sizes: number[]): number[] {
  const sums = [start];
  for (const size of sizes) sums.push(sums[sums.length - 1] + size);
  return sums;
}

function resolveContainer(
  container: DeckElementContainer,
  origin: ResolvedOrigin,
  scope: ResolveScope,
  output: ResolvedItem[],
  includePlaceholders = origin === 'slide',
): void {
  for (const id of container.elementOrder) {
    const element = container.elements[id];
    if (!element) continue;
    // Master and layout placeholders are prompts, not content. They paint
    // only through the slide elements that reference them — except in the
    // layout and master editors, where they are what is being edited.
    if (!includePlaceholders && element.placeholder) continue;
    resolveElement(element, container, origin, scope, 1, 0, output);
  }
}

/* ------------------------------------------------------------------------- */
/* Entry points                                                               */
/* ------------------------------------------------------------------------- */

export function resolveSlide(
  deck: DeckDocument,
  slideId: string,
  options: ResolveOptions = {},
): ResolvedSlide {
  const slide: DeckSlide | undefined = deck.slides[slideId];
  if (!slide) throw new DeckResolveError(`Slide ${slideId} does not exist.`);

  const layout = slide.layoutId ? deck.layouts[slide.layoutId] : undefined;
  if (slide.layoutId && !layout) {
    throw new DeckResolveError(`Slide ${slideId} uses missing layout ${slide.layoutId}.`);
  }
  const master = layout
    ? deck.masters[layout.masterId]
    : deck.masters[Object.keys(deck.masters).sort()[0]];
  if (!master) throw new DeckResolveError(`Slide ${slideId} has no master.`);
  const theme = deck.themes[master.themeId ?? deck.themeId] ?? deck.themes[deck.themeId];
  if (!theme) throw new DeckResolveError(`Theme ${master.themeId ?? deck.themeId} does not exist.`);

  const scope: ResolveScope = {
    deck,
    theme,
    master,
    layout,
    slideNumber: deck.slideOrder.indexOf(slideId) + 1,
    prompts: options.prompts ?? false,
  };

  const items: ResolvedItem[] = [];
  if (!layout || layout.showMasterElements !== false)
    resolveContainer(master, 'master', scope, items);
  if (layout) resolveContainer(layout, 'layout', scope, items);
  resolveContainer(slide, 'slide', scope, items);

  const notesContext: TextContext = {
    theme,
    master,
    textClass: 'other',
    prompts: [],
    fields: { slideNumber: scope.slideNumber },
  };

  return {
    slideId,
    number: deck.slideOrder.indexOf(slideId) + 1,
    width: deck.size.width,
    height: deck.size.height,
    hidden: slide.hidden ?? false,
    background: resolveFill(slide.background ?? layout?.background ?? master.background, theme),
    items,
    readingOrder: [...(slide.readingOrder ?? [])],
    notes: slide.speakerNotes
      ? {
          paragraphs: resolveParagraphs(slide.speakerNotes.paragraphs, notesContext),
          insets: [0, 0, 0, 0],
          verticalAlign: 'top',
          autoFit: 'none',
          wrap: true,
        }
      : null,
    theme,
  };
}

function themeFor(deck: DeckDocument, master: DeckMaster): DeckTheme {
  const theme = deck.themes[master.themeId ?? deck.themeId] ?? deck.themes[deck.themeId];
  if (!theme) throw new DeckResolveError(`Theme ${master.themeId ?? deck.themeId} does not exist.`);
  return theme;
}

/**
 * A layout or master as its editor shows it: its own placeholders drawn with
 * their prompts, over the master's artwork. Slide-number fields show `‹#›`.
 */
export function resolveDesign(
  deck: DeckDocument,
  target: { kind: 'layout' | 'master'; id: string },
): ResolvedSlide {
  const layout = target.kind === 'layout' ? deck.layouts[target.id] : undefined;
  if (target.kind === 'layout' && !layout) {
    throw new DeckResolveError(`Layout ${target.id} does not exist.`);
  }
  const master = deck.masters[layout ? layout.masterId : target.id];
  if (!master) throw new DeckResolveError(`Master ${target.id} does not exist.`);
  const theme = themeFor(deck, master);
  const scope: ResolveScope = {
    deck,
    theme,
    master,
    layout,
    slideNumber: '‹#›',
    prompts: true,
  };
  const items: ResolvedItem[] = [];
  if (layout) {
    if (layout.showMasterElements !== false) resolveContainer(master, 'master', scope, items);
    resolveContainer(layout, 'layout', scope, items, true);
  } else {
    resolveContainer(master, 'master', scope, items, true);
  }
  return {
    slideId: target.id,
    number: 0,
    width: deck.size.width,
    height: deck.size.height,
    hidden: false,
    background: resolveFill(layout?.background ?? master.background, theme),
    items,
    readingOrder: [],
    notes: null,
    theme,
  };
}

/** Resolves whatever the editor is editing. */
export function resolveTarget(
  deck: DeckDocument,
  target: DeckTarget,
  options: ResolveOptions = {},
): ResolvedSlide {
  return target.kind === 'slide'
    ? resolveSlide(deck, target.id, options)
    : resolveDesign(deck, { kind: target.kind, id: target.id });
}

export function resolveDeck(deck: DeckDocument): ResolvedSlide[] {
  return deck.slideOrder.map((id) => resolveSlide(deck, id));
}

/** Plain text of a resolved body, one line per paragraph. For reports and tests. */
export function plainText(body: ResolvedTextBody | null): string {
  if (!body) return '';
  return body.paragraphs
    .map((paragraph) =>
      paragraph.runs.map((run) => (run.kind === 'break' ? '\n' : run.text)).join(''),
    )
    .join('\n');
}
