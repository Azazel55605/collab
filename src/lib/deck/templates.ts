/**
 * Built-in starter designs.
 *
 * A template is ordinary, inspectable `.deck` content — a theme, one master,
 * and a set of layouts — produced for a given slide size. Nothing about a
 * template lives in the renderer: once a deck is created from one, or has one
 * applied, the design is the deck's own copy, fully editable in the theme,
 * master, and layout editors, and changing a template here never restyles an
 * existing deck.
 *
 * Every template produces the same layout ids, so applying another design
 * keeps each slide on the equivalent layout.
 */
import { DECK_DEFAULT_INSETS, DECK_UNITS_PER_POINT } from '../../types/deck';
import type {
  DeckColor,
  DeckDocument,
  DeckElement,
  DeckElementContainer,
  DeckFill,
  DeckLayout,
  DeckMaster,
  DeckPlaceholderType,
  DeckSlide,
  DeckTextStyles,
  DeckTheme,
  DeckThemeColorToken,
  DeckThemeFont,
} from '../../types/deck';

import { setSlideLayout } from './design';
import { applyPatch, composeEdits } from './operations';
import type { DeckEdit, DeckOperation } from './operations';

const pt = (points: number) => points * DECK_UNITS_PER_POINT;
const theme = (token: DeckThemeColorToken): DeckColor => ({ kind: 'theme', token });
const solid = (token: DeckThemeColorToken): DeckFill => ({ kind: 'solid', color: theme(token) });

export type DeckTemplateId = 'collab' | 'lecture' | 'midnight' | 'paper';

export interface DeckDesign {
  theme: DeckTheme;
  master: DeckMaster;
  layouts: DeckLayout[];
}

interface DesignSpec {
  id: DeckTemplateId;
  name: string;
  description: string;
  themeId: string;
  masterId: string;
  colors: DeckTheme['colors'];
  fonts: { heading: DeckThemeFont; body: DeckThemeFont };
  background: DeckThemeColorToken;
  titleColor: DeckThemeColorToken;
  bodyColor: DeckThemeColorToken;
  titleBold: boolean;
  bullets: [string, string, string];
  /** Master artwork painted under every slide whose layout shows it. */
  artwork?: (size: { width: number; height: number; margin: number }) => DeckElement[];
  /** Title-slide background and artwork, replacing the master's. */
  titleSlide?: {
    background?: DeckFill;
    artwork?: (size: { width: number; height: number; margin: number }) => DeckElement[];
    titleColor?: DeckThemeColorToken;
  };
}

const SPECS: Record<DeckTemplateId, DesignSpec> = {
  collab: {
    id: 'collab',
    name: 'Collab',
    description: 'Clean sans-serif on white with a violet accent.',
    themeId: 'theme-default',
    masterId: 'master-default',
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
    background: 'light1',
    titleColor: 'dark1',
    bodyColor: 'dark2',
    titleBold: true,
    bullets: ['•', '–', '•'],
  },
  lecture: {
    id: 'lecture',
    name: 'Lecture',
    description: 'Serif headings, navy and brick accents, a rule under every title.',
    themeId: 'theme-lecture',
    masterId: 'master-lecture',
    colors: {
      dark1: '#1b2a41',
      light1: '#ffffff',
      dark2: '#324a5f',
      light2: '#eef2f6',
      accent1: '#1f4e79',
      accent2: '#b5473a',
      accent3: '#d4a72c',
      accent4: '#4f7d5c',
      accent5: '#6b8cae',
      accent6: '#7a5c99',
      hyperlink: '#1f4e79',
      followedHyperlink: '#7a5c99',
    },
    fonts: {
      heading: { family: 'Georgia', fallbacks: ['Times New Roman', 'serif'] },
      body: { family: 'Calibri', fallbacks: ['Carlito', 'Arial', 'sans-serif'] },
    },
    background: 'light1',
    titleColor: 'dark1',
    bodyColor: 'dark2',
    titleBold: false,
    bullets: ['▪', '–', '▪'],
    artwork: ({ width, height, margin }) => [
      {
        id: 'master-lecture-rule',
        type: 'line',
        name: 'Title rule',
        from: { x: margin, y: Math.round(height * 0.22) },
        to: { x: width - margin, y: Math.round(height * 0.22) },
        line: { color: theme('accent1'), width: pt(1.5) },
      },
    ],
    titleSlide: {
      artwork: ({ width, height }) => [
        {
          id: 'layout-title-band',
          type: 'shape',
          name: 'Band',
          geometry: 'rect',
          frame: { x: 0, y: Math.round(height * 0.86), width, height: Math.round(height * 0.14) },
          fill: solid('accent1'),
        },
      ],
    },
  },
  midnight: {
    id: 'midnight',
    name: 'Midnight',
    description: 'Light text on a deep navy background with bright accents.',
    themeId: 'theme-midnight',
    masterId: 'master-midnight',
    colors: {
      dark1: '#0b1120',
      light1: '#f8fafc',
      dark2: '#1e293b',
      light2: '#cbd5e1',
      accent1: '#38bdf8',
      accent2: '#a78bfa',
      accent3: '#34d399',
      accent4: '#fbbf24',
      accent5: '#f472b6',
      accent6: '#fb7185',
      hyperlink: '#7dd3fc',
      followedHyperlink: '#c4b5fd',
    },
    fonts: {
      heading: { family: 'Inter', fallbacks: ['Segoe UI', 'Arial', 'sans-serif'] },
      body: { family: 'Inter', fallbacks: ['Segoe UI', 'Arial', 'sans-serif'] },
    },
    background: 'dark1',
    titleColor: 'light1',
    bodyColor: 'light2',
    titleBold: true,
    bullets: ['›', '–', '·'],
    artwork: ({ height, margin }) => [
      {
        id: 'master-midnight-bar',
        type: 'shape',
        name: 'Accent bar',
        geometry: 'rect',
        frame: {
          x: Math.round(margin * 0.45),
          y: Math.round(height * 0.08),
          width: pt(6),
          height: Math.round(height * 0.11),
        },
        fill: solid('accent1'),
      },
    ],
    titleSlide: {
      background: solid('dark2'),
      titleColor: 'light1',
    },
  },
  paper: {
    id: 'paper',
    name: 'Paper',
    description: 'Warm off-white with book-style serif type.',
    themeId: 'theme-paper',
    masterId: 'master-paper',
    colors: {
      dark1: '#2b2118',
      light1: '#fffdf8',
      dark2: '#4a3b2c',
      light2: '#f4ecdf',
      accent1: '#a0522d',
      accent2: '#5f7a4e',
      accent3: '#c49a3a',
      accent4: '#8c3b3b',
      accent5: '#4c6a86',
      accent6: '#7b6a58',
      hyperlink: '#8c3b3b',
      followedHyperlink: '#7b6a58',
    },
    fonts: {
      heading: { family: 'Palatino Linotype', fallbacks: ['Book Antiqua', 'Palatino', 'serif'] },
      body: { family: 'Palatino Linotype', fallbacks: ['Book Antiqua', 'Palatino', 'serif'] },
    },
    background: 'light2',
    titleColor: 'dark1',
    bodyColor: 'dark2',
    titleBold: false,
    bullets: ['—', '·', '—'],
  },
};

export interface DeckTemplateInfo {
  id: DeckTemplateId;
  name: string;
  description: string;
  /** Background, title, and accent colours, for a gallery swatch. */
  swatch: { background: string; text: string; accent: string };
}

export const DECK_TEMPLATES: DeckTemplateInfo[] = (Object.values(SPECS) as DesignSpec[]).map(
  (spec) => ({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    swatch: {
      background: spec.colors[spec.background],
      text: spec.colors[spec.titleColor],
      accent: spec.colors.accent1,
    },
  }),
);

export function isDeckTemplateId(value: unknown): value is DeckTemplateId {
  return typeof value === 'string' && value in SPECS;
}

function container(elements: DeckElement[]): DeckElementContainer {
  return {
    elements: Object.fromEntries(elements.map((element) => [element.id, element])),
    elementOrder: elements.map((element) => element.id),
  };
}

function prompt(
  id: string,
  type: DeckPlaceholderType,
  frame: DeckElement['frame'],
  options: { align?: 'left' | 'center' | 'right'; key?: string; color?: DeckThemeColorToken } = {},
): DeckElement {
  const style =
    options.align || options.color
      ? {
          paragraphs: [
            {
              id: `${id}-p`,
              ...(options.align ? { style: { align: options.align } } : {}),
              ...(options.color ? { endStyle: { color: theme(options.color) } } : {}),
              runs: [],
            },
          ],
        }
      : { paragraphs: [] };
  return {
    id,
    type: 'text',
    placeholder: {
      type,
      key: options.key ?? (type === 'slideNumber' ? 'number' : type),
    },
    ...(frame ? { frame } : {}),
    text: {
      content: style,
      insets: DECK_DEFAULT_INSETS,
      verticalAlign: type === 'title' ? 'bottom' : 'top',
    },
  };
}

function textStyles(spec: DesignSpec): DeckTextStyles {
  const [first, second, third] = spec.bullets;
  return {
    title: [
      {
        paragraph: { lineSpacing: 90 },
        run: {
          font: { theme: 'heading' },
          size: pt(40),
          bold: spec.titleBold,
          color: theme(spec.titleColor),
        },
      },
    ],
    body: [
      {
        paragraph: { list: { kind: 'bullet', char: first }, spaceBefore: pt(10), indent: pt(24) },
        run: { font: { theme: 'body' }, size: pt(24), color: theme(spec.bodyColor) },
      },
      {
        paragraph: { list: { kind: 'bullet', char: second }, spaceBefore: pt(6), indent: pt(48) },
        run: { font: { theme: 'body' }, size: pt(20), color: theme(spec.bodyColor) },
      },
      {
        paragraph: { list: { kind: 'bullet', char: third }, spaceBefore: pt(4), indent: pt(72) },
        run: { font: { theme: 'body' }, size: pt(18), color: theme(spec.bodyColor) },
      },
    ],
    other: [{ run: { font: { theme: 'body' }, size: pt(18), color: theme(spec.titleColor) } }],
  };
}

/** Builds a template's theme, master, and layouts for a slide size. */
export function buildDesign(templateId: DeckTemplateId, width: number, height: number): DeckDesign {
  const spec = SPECS[templateId];
  const margin = Math.round(width / 20);
  const inner = width - margin * 2;
  const titleHeight = Math.round(height * 0.15);
  const bodyTop = Math.round(height * 0.26);
  const footerTop = height - Math.round(height * 0.08);
  const footerHeight = Math.round(height * 0.05);
  const gap = Math.round(width / 40);
  const box = { width, height, margin };
  const bodyHeight = footerTop - bodyTop - Math.round(height * 0.03);
  const layoutId = (name: string) => `layout-${name}`;
  // The Collab design keeps the element ids decks were first created with.
  const prefix = spec.id === 'collab' ? 'master' : spec.masterId;

  const designTheme: DeckTheme = {
    id: spec.themeId,
    name: spec.name,
    colors: { ...spec.colors },
    fonts: {
      heading: structuredClone(spec.fonts.heading),
      body: structuredClone(spec.fonts.body),
    },
  };

  const master: DeckMaster = {
    id: spec.masterId,
    name: spec.name,
    themeId: designTheme.id,
    background: solid(spec.background),
    textStyles: textStyles(spec),
    ...container([
      ...(spec.artwork?.(box) ?? []),
      prompt(`${prefix}-title`, 'title', {
        x: margin,
        y: Math.round(height * 0.06),
        width: inner,
        height: titleHeight,
      }),
      prompt(`${prefix}-body`, 'body', {
        x: margin,
        y: bodyTop,
        width: inner,
        height: bodyHeight,
      }),
      prompt(`${prefix}-footer`, 'footer', {
        x: margin,
        y: footerTop,
        width: Math.round(inner * 0.6),
        height: footerHeight,
      }),
      prompt(
        `${prefix}-number`,
        'slideNumber',
        {
          x: width - margin - Math.round(inner * 0.1),
          y: footerTop,
          width: Math.round(inner * 0.1),
          height: footerHeight,
        },
        { align: 'right' },
      ),
    ]),
  };

  const titleColor = spec.titleSlide?.titleColor;
  const centred = (id: string, top: number, boxHeight: number, type: 'title' | 'subtitle') =>
    prompt(
      id,
      type,
      { x: margin, y: top, width: inner, height: boxHeight },
      { align: 'center', ...(titleColor ? { color: titleColor } : {}) },
    );
  const half = Math.round((inner - gap) / 2);

  const titleLayout: DeckLayout = {
    id: layoutId('title'),
    name: 'Title slide',
    masterId: master.id,
    ...(spec.titleSlide?.background ? { background: spec.titleSlide.background } : {}),
    ...(spec.titleSlide ? { showMasterElements: false } : {}),
    ...container([
      ...(spec.titleSlide?.artwork?.(box) ?? []),
      centred('layout-title-title', Math.round(height * 0.3), Math.round(height * 0.2), 'title'),
      centred(
        'layout-title-subtitle',
        Math.round(height * 0.52),
        Math.round(height * 0.12),
        'subtitle',
      ),
    ]),
  };

  const layouts: DeckLayout[] = [
    titleLayout,
    {
      id: layoutId('content'),
      name: 'Title and content',
      masterId: master.id,
      ...container([
        prompt('layout-content-title', 'title', undefined),
        prompt('layout-content-body', 'body', undefined),
      ]),
    },
    {
      id: layoutId('two-content'),
      name: 'Two content',
      masterId: master.id,
      ...container([
        prompt('layout-two-content-title', 'title', undefined),
        prompt('layout-two-content-left', 'body', {
          x: margin,
          y: bodyTop,
          width: half,
          height: bodyHeight,
        }),
        prompt(
          'layout-two-content-right',
          'body',
          { x: margin + half + gap, y: bodyTop, width: half, height: bodyHeight },
          { key: 'body-2' },
        ),
      ]),
    },
    {
      id: layoutId('section'),
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
      id: layoutId('title-only'),
      name: 'Title only',
      masterId: master.id,
      ...container([prompt('layout-title-only-title', 'title', undefined)]),
    },
    { id: layoutId('blank'), name: 'Blank', masterId: master.id, ...container([]) },
  ];
  return { theme: designTheme, master, layouts };
}

/**
 * Replaces a deck's design with a template's: theme, master, and layouts.
 * Slides keep their content and move to the template's layout of the same id
 * (or name), falling back to "Title and content"; slide-level overrides are
 * kept, so this restyles without rewriting anything a person set by hand.
 */
export function applyTemplate(
  document: DeckDocument,
  templateId: DeckTemplateId,
  nextId: (prefix: string) => string,
): DeckEdit {
  const design = buildDesign(templateId, document.size.width, document.size.height);
  const layoutIds = new Set(design.layouts.map((layout) => layout.id));
  const byName = new Map(design.layouts.map((layout) => [layout.name.toLowerCase(), layout.id]));

  const patch = {
    themes: Object.fromEntries([
      ...Object.keys(document.themes).map((id) => [id, null] as const),
      [design.theme.id, design.theme],
    ]),
    masters: Object.fromEntries([
      ...Object.keys(document.masters).map((id) => [id, null] as const),
      [design.master.id, design.master],
    ]),
    layouts: Object.fromEntries([
      ...Object.keys(document.layouts).map((id) => [id, null] as const),
      ...design.layouts.map((layout) => [layout.id, layout] as const),
    ]),
    themeId: design.theme.id,
  };

  const targets = new Map<string, string>();
  for (const slideId of document.slideOrder) {
    const slide = document.slides[slideId];
    const current = slide.layoutId ? document.layouts[slide.layoutId] : undefined;
    const target =
      (slide.layoutId && layoutIds.has(slide.layoutId) ? slide.layoutId : undefined) ??
      (current ? byName.get(current.name.toLowerCase()) : undefined) ??
      'layout-content';
    targets.set(slideId, target);
  }

  // Slides whose layout changes move first, while the old design still
  // resolves, so a placeholder the new layout lacks keeps where it was drawn.
  const moves = new Map<string, string[]>();
  for (const [slideId, target] of targets) {
    if (document.slides[slideId].layoutId === target || !document.layouts[target]) continue;
    moves.set(target, [...(moves.get(target) ?? []), slideId]);
  }
  const operations: DeckOperation[] = [...moves].map(
    ([target, slideIds]) =>
      (current: DeckDocument) =>
        setSlideLayout(current, slideIds, target, nextId),
  );
  operations.push((current) => {
    const slides: Record<string, DeckSlide> = {};
    for (const [slideId, target] of targets) {
      const slide = current.slides[slideId];
      if (slide.layoutId !== target) slides[slideId] = { ...slide, layoutId: target };
    }
    return applyPatch(current, { ...patch, slides });
  });
  return composeEdits(document, operations);
}
