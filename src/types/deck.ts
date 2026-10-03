/**
 * `.deck` document schema — frozen in Phase 0 of the Presentations plan.
 *
 * See `docs/plans/presentation-phase0-contract.md` for the reasoning. The short
 * version:
 *
 * - Geometry is stored in **integer deck units**, not CSS pixels. One unit is
 *   1/100 pt, which is exactly 127 EMU, so conversion to PowerPoint's English
 *   Metric Units is an integer multiplication and never drifts.
 * - Font sizes use the same unit (hundredths of a point, which is also what
 *   OOXML stores). Rotation is integer hundredths of a degree in [0, 36000).
 * - Everything addressable has a stable id, and ordered collections are an id
 *   array beside an id-keyed map. Nothing is index-addressed, so concurrent
 *   edits to different objects never collide on a position.
 * - Rich text is a Collab-owned paragraph/run model. It is not HTML and not any
 *   editor library's serialized state.
 * - Theme, master, and layout inheritance is document content resolved by one
 *   shared resolver, never by an output adapter.
 * - No field may carry executable content, raw HTML, or an external URL that a
 *   renderer would fetch. Media is a vault-relative path.
 */

export const DECK_EXTENSION = 'deck';
export const DECK_MEDIA_TYPE = 'application/vnd.collab.deck+json';
export const DECK_DOCUMENT_KIND = 'collab-deck';
export const DECK_SCHEMA_VERSION = 1;

/** Deck units per PostScript point. One unit is 1/100 pt. */
export const DECK_UNITS_PER_POINT = 100;

/** Deck units per inch (72 pt). */
export const DECK_UNITS_PER_INCH = DECK_UNITS_PER_POINT * 72;

/** Deck units per CSS pixel at 100% zoom (1 px = 0.75 pt). */
export const DECK_UNITS_PER_PX = DECK_UNITS_PER_POINT * 0.75;

/** English Metric Units per deck unit: 914,400 EMU per inch / 7,200. Exact. */
export const DECK_EMU_PER_UNIT = 127;

/** Rotation is stored in hundredths of a degree. */
export const DECK_ROTATION_UNITS_PER_DEGREE = 100;
export const DECK_ROTATION_FULL_TURN = 360 * DECK_ROTATION_UNITS_PER_DEGREE;

/**
 * Hard structural limits. These bound parsing, paste, collaboration, and
 * export. A document exceeding one is rejected with a specific error rather
 * than silently truncated.
 */
export const DECK_LIMITS = {
  /**
   * Amended in Phase 1 from 32 MiB. Hosted vaults run every structured document
   * through the server's generic parser caps (`collab_documents::
   * DEFAULT_PARSER_LIMITS`): 16 MiB, 100,000 JSON entries, 128 levels. The
   * client enforces the same caps so it never saves a deck the server refuses.
   */
  documentBytes: 16 * 1024 * 1024,
  jsonEntries: 100_000,
  jsonDepth: 128,
  slides: 1_000,
  sections: 200,
  themes: 16,
  masters: 16,
  layouts: 128,
  elementsPerSlide: 2_000,
  elementsPerDeck: 100_000,
  /** Characters in one text body (one element, one table cell, or notes). */
  textPerBody: 32_768,
  textPerDeck: 2_000_000,
  paragraphsPerBody: 2_000,
  runsPerParagraph: 500,
  /** OOXML supports nine list levels; so do we. */
  listLevels: 9,
  groupDepth: 8,
  imagePixels: 40_000_000,
  imageBytes: 32 * 1024 * 1024,
  tableRows: 500,
  tableColumns: 64,
  tableCells: 10_000,
  chartSeries: 32,
  chartPointsPerSeries: 1_000,
  animationsPerSlide: 200,
  animationDurationMs: 60_000,
  clipboardBytes: 8 * 1024 * 1024,
  /** Shortest slide side: 1 inch. */
  minSlideSide: DECK_UNITS_PER_INCH,
  /** Longest slide side: 56 inches, PowerPoint's own ceiling. */
  maxSlideSide: 56 * DECK_UNITS_PER_INCH,
  /** How far an element may extend beyond the slide, per side. */
  canvasOverscan: 56 * DECK_UNITS_PER_INCH,
  /** Font size range in hundredths of a point (1 pt .. 4,000 pt, as OOXML). */
  minFontSize: 100,
  maxFontSize: 400_000,
  nameLength: 256,
  altTextLength: 4_096,
  linkLength: 2_048,
  metadataEntries: 64,
} as const;

/* ------------------------------------------------------------------------- */
/* Size                                                                       */
/* ------------------------------------------------------------------------- */

export type DeckSizePreset = 'widescreen' | 'standard' | 'a4' | 'letter' | 'custom';

export interface DeckSize {
  preset: DeckSizePreset;
  width: number;
  height: number;
}

/** Standard sizes, matching PowerPoint's own presets exactly. */
export const DECK_SIZE_PRESETS: Record<Exclude<DeckSizePreset, 'custom'>, DeckSize> = {
  /** 13.333 in x 7.5 in, 16:9. The default. */
  widescreen: { preset: 'widescreen', width: 96_000, height: 54_000 },
  /** 10 in x 7.5 in, 4:3. */
  standard: { preset: 'standard', width: 72_000, height: 54_000 },
  /** PowerPoint's "A4 paper" slide: 10.833 in x 7.5 in. */
  a4: { preset: 'a4', width: 78_000, height: 54_000 },
  /** PowerPoint's "Letter paper" slide: 10 in x 7.5 in. */
  letter: { preset: 'letter', width: 72_000, height: 54_000 },
};

/* ------------------------------------------------------------------------- */
/* Colour, fill, line                                                         */
/* ------------------------------------------------------------------------- */

/** The OOXML theme colour slots, so themes map onto PowerPoint one-to-one. */
export const DECK_THEME_COLOR_TOKENS = [
  'dark1',
  'light1',
  'dark2',
  'light2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hyperlink',
  'followedHyperlink',
] as const;
export type DeckThemeColorToken = (typeof DECK_THEME_COLOR_TOKENS)[number];

/**
 * A colour is either explicit (`#rrggbb`) or a theme reference. `alpha` is a
 * whole percentage (0 transparent, 100 opaque, default 100).
 */
export type DeckColor =
  | { kind: 'rgb'; value: string; alpha?: number }
  | { kind: 'theme'; token: DeckThemeColorToken; alpha?: number };

export type DeckFill =
  | { kind: 'none' }
  | { kind: 'solid'; color: DeckColor }
  | { kind: 'image'; asset: DeckAssetRef; fit: 'cover' | 'contain' | 'stretch' };

export type DeckDash = 'solid' | 'dash' | 'dot' | 'dashDot';
export type DeckArrowhead = 'none' | 'triangle' | 'open' | 'oval' | 'diamond';

export interface DeckLine {
  color: DeckColor;
  /** Stroke width in deck units. */
  width: number;
  dash?: DeckDash;
}

/* ------------------------------------------------------------------------- */
/* Assets                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * A vault asset. Never an external URL: document content cannot make the
 * renderer fetch from the network.
 */
export interface DeckAssetRef {
  /** Vault-relative path. */
  path: string;
  mediaType: string;
  /** Intrinsic pixel size, recorded at insert so layout never waits on a decode. */
  pixelWidth: number;
  pixelHeight: number;
  /** Content hash at insert, used to detect a replaced file. */
  sha256?: string;
}

/* ------------------------------------------------------------------------- */
/* Rich text                                                                  */
/* ------------------------------------------------------------------------- */

export type DeckThemeFontRole = 'heading' | 'body';

export interface DeckRunStyle {
  /** A family name, or a theme font role. */
  font?: string | { theme: DeckThemeFontRole };
  /** Hundredths of a point. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: DeckColor;
  baseline?: 'superscript' | 'subscript';
  /** BCP 47 language tag. */
  lang?: string;
}

export type DeckLink =
  | { kind: 'url'; href: string }
  | { kind: 'slide'; slideId: string }
  | { kind: 'vault'; path: string };

export type DeckRun =
  | { kind: 'text'; text: string; style?: DeckRunStyle; link?: DeckLink }
  /** A soft line break inside a paragraph. A hard break is a new paragraph. */
  | { kind: 'break'; style?: DeckRunStyle };

export type DeckTextAlign = 'left' | 'center' | 'right' | 'justify';

export interface DeckList {
  kind: 'bullet' | 'number';
  /** A single bullet character for `bullet`. */
  char?: string;
  numberStyle?: 'arabicPeriod' | 'alphaLcPeriod' | 'alphaUcPeriod' | 'romanLcPeriod';
  startAt?: number;
}

export interface DeckParagraphStyle {
  align?: DeckTextAlign;
  /** 0-based list/outline level, bounded by `DECK_LIMITS.listLevels`. */
  level?: number;
  /** `null` explicitly removes an inherited list. */
  list?: DeckList | null;
  /** Deck units. */
  indent?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  /** Line spacing as a percentage of single spacing (100 = single). */
  lineSpacing?: number;
}

export interface DeckParagraph {
  id: string;
  style?: DeckParagraphStyle;
  runs: DeckRun[];
  /** Style of the paragraph mark, which is what an empty paragraph renders at. */
  endStyle?: DeckRunStyle;
}

export interface DeckRichText {
  paragraphs: DeckParagraph[];
}

export type DeckAutoFit = 'none' | 'shrink' | 'grow';
export type DeckVerticalAlign = 'top' | 'middle' | 'bottom';

export interface DeckTextBody {
  content: DeckRichText;
  /** Inner padding in deck units, left/top/right/bottom. */
  insets?: [number, number, number, number];
  verticalAlign?: DeckVerticalAlign;
  autoFit?: DeckAutoFit;
  /** Defaults to true. */
  wrap?: boolean;
}

/** PowerPoint's default text box inset: 0.1 in left/right, 0.05 in top/bottom. */
export const DECK_DEFAULT_INSETS: [number, number, number, number] = [720, 360, 720, 360];

/* ------------------------------------------------------------------------- */
/* Elements                                                                   */
/* ------------------------------------------------------------------------- */

/** Axis-aligned frame, then rotated about its centre. All deck units. */
export interface DeckFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Hundredths of a degree, clockwise, [0, 36000). */
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
}

export type DeckPlaceholderType =
  'title' | 'subtitle' | 'body' | 'content' | 'picture' | 'date' | 'footer' | 'slideNumber';

/**
 * Links an element to a layout/master placeholder. The resolver inherits
 * every property the element leaves unset from the matching placeholder.
 */
export interface DeckPlaceholderRef {
  type: DeckPlaceholderType;
  /** Stable key shared by the master, layout, and slide placeholders. */
  key: string;
}

interface DeckElementBase {
  id: string;
  name?: string;
  /**
   * Optional only on an element that inherits its frame from a placeholder.
   * Validation rejects a frameless element without one.
   */
  frame?: DeckFrame;
  placeholder?: DeckPlaceholderRef;
  locked?: boolean;
  hidden?: boolean;
  /** Whole percentage, default 100. */
  opacity?: number;
  altText?: string;
}

export interface DeckTextElement extends DeckElementBase {
  type: 'text';
  text: DeckTextBody;
  fill?: DeckFill;
  line?: DeckLine;
}

/** A deliberately small preset set, every one of which has an OOXML preset. */
export const DECK_SHAPE_GEOMETRIES = [
  'rect',
  'roundRect',
  'ellipse',
  'triangle',
  'rightTriangle',
  'diamond',
  'pentagon',
  'hexagon',
  'rightArrow',
  'leftArrow',
  'upArrow',
  'downArrow',
  'chevron',
  'star5',
] as const;
export type DeckShapeGeometry = (typeof DECK_SHAPE_GEOMETRIES)[number];

export interface DeckShapeElement extends DeckElementBase {
  type: 'shape';
  geometry: DeckShapeGeometry;
  fill?: DeckFill;
  line?: DeckLine;
  /** Shapes may carry text, as in PowerPoint. */
  text?: DeckTextBody;
}

export interface DeckLineElement extends DeckElementBase {
  type: 'line';
  /** Endpoints in slide deck units. The frame is derived from them. */
  from: { x: number; y: number };
  to: { x: number; y: number };
  line: DeckLine;
  startArrow?: DeckArrowhead;
  endArrow?: DeckArrowhead;
}

/** Crop in thousandths of the image per side, the same scale as OOXML `srcRect` / 100. */
export interface DeckCrop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DeckImageElement extends DeckElementBase {
  type: 'image';
  asset: DeckAssetRef;
  crop?: DeckCrop;
  line?: DeckLine;
}

export interface DeckTableCell {
  text: DeckTextBody;
  fill?: DeckFill;
  rowSpan?: number;
  colSpan?: number;
}

export interface DeckTableElement extends DeckElementBase {
  type: 'table';
  rowOrder: string[];
  columnOrder: string[];
  /** Row heights and column widths by id, in deck units. */
  rowHeights: Record<string, number>;
  columnWidths: Record<string, number>;
  /** Keyed `${rowId}:${columnId}`. A missing key is an empty cell. */
  cells: Record<string, DeckTableCell>;
  headerRow?: boolean;
  border?: DeckLine;
}

export type DeckChartKind = 'bar' | 'column' | 'line' | 'pie' | 'area';

export interface DeckChartSeries {
  id: string;
  name: string;
  values: number[];
  color?: DeckColor;
}

export interface DeckChartElement extends DeckElementBase {
  type: 'chart';
  kind: DeckChartKind;
  title?: string;
  categories: string[];
  series: DeckChartSeries[];
  showLegend?: boolean;
  /** An explicit `.sheet` snapshot the values were last refreshed from. */
  source?: { path: string; range: string; refreshedAt: string };
}

/**
 * A group. Children stay in the container's flat element map with absolute
 * slide geometry; the group lists their ids in paint order. Flat storage keeps
 * a group edit and a child edit from contending for the same CRDT node.
 */
export interface DeckGroupElement extends DeckElementBase {
  type: 'group';
  childIds: string[];
}

/** A static, source-linked preview of another vault document. */
export interface DeckEmbedElement extends DeckElementBase {
  type: 'embed';
  source: { path: string; view?: string };
  preview?: DeckAssetRef;
}

export type DeckElement =
  | DeckTextElement
  | DeckShapeElement
  | DeckLineElement
  | DeckImageElement
  | DeckTableElement
  | DeckChartElement
  | DeckGroupElement
  | DeckEmbedElement;

export type DeckElementType = DeckElement['type'];

/* ------------------------------------------------------------------------- */
/* Theme, master, layout                                                      */
/* ------------------------------------------------------------------------- */

export interface DeckThemeFont {
  family: string;
  /** Tried in order when `family` is unavailable. */
  fallbacks?: string[];
}

export interface DeckTheme {
  id: string;
  name: string;
  /** `#rrggbb` per slot. */
  colors: Record<DeckThemeColorToken, string>;
  fonts: Record<DeckThemeFontRole, DeckThemeFont>;
}

/** Per-level paragraph and run defaults for one class of text. */
export interface DeckTextLevelStyle {
  paragraph?: DeckParagraphStyle;
  run?: DeckRunStyle;
}

export interface DeckTextStyles {
  /** Title placeholders. */
  title: DeckTextLevelStyle[];
  /** Body/content/subtitle placeholders, by list level. */
  body: DeckTextLevelStyle[];
  /** Everything else: free text boxes, shapes, table cells, notes. */
  other: DeckTextLevelStyle[];
}

export interface DeckElementContainer {
  elements: Record<string, DeckElement>;
  /** Top-level paint order. Group children are listed by their group only. */
  elementOrder: string[];
}

export interface DeckMaster extends DeckElementContainer {
  id: string;
  name: string;
  themeId?: string;
  background?: DeckFill;
  textStyles: DeckTextStyles;
}

export interface DeckLayout extends DeckElementContainer {
  id: string;
  name: string;
  masterId: string;
  background?: DeckFill;
  /** Whether the master's non-placeholder elements paint under this layout. Default true. */
  showMasterElements?: boolean;
}

/* ------------------------------------------------------------------------- */
/* Slides and document                                                        */
/* ------------------------------------------------------------------------- */

export interface DeckTransition {
  kind: 'none' | 'fade' | 'push' | 'wipe';
  durationMs: number;
}

export interface DeckAnimation {
  id: string;
  elementId: string;
  effect: 'appear' | 'fade' | 'fly' | 'zoom';
  phase: 'entrance' | 'emphasis' | 'exit';
  trigger: 'click' | 'withPrevious' | 'afterPrevious';
  durationMs: number;
  delayMs?: number;
}

export interface DeckSlide extends DeckElementContainer {
  id: string;
  name?: string;
  layoutId?: string;
  hidden?: boolean;
  background?: DeckFill;
  speakerNotes?: DeckRichText;
  transition?: DeckTransition;
  animations?: DeckAnimation[];
  /**
   * Optional assistive-technology reading order for slide-owned objects.
   * Missing ids are appended in paint order, so older decks and newly added
   * objects remain readable without coupling reading order to z-order.
   */
  readingOrder?: string[];
}

export interface DeckSection {
  id: string;
  name: string;
  /** The slide the section begins at. */
  firstSlideId: string;
}

export interface DeckDocument {
  kind: typeof DECK_DOCUMENT_KIND;
  schemaVersion: typeof DECK_SCHEMA_VERSION;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  size: DeckSize;
  themeId: string;
  themes: Record<string, DeckTheme>;
  masters: Record<string, DeckMaster>;
  layouts: Record<string, DeckLayout>;
  slides: Record<string, DeckSlide>;
  slideOrder: string[];
  sections?: DeckSection[];
  /** Bounded, inert key/value metadata. Never interpreted as behaviour. */
  metadata?: Record<string, string | number | boolean>;
}
