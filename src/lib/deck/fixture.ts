/**
 * Deterministic `.deck` fixtures.
 *
 * Phase 0 proves the resolver, text layout, SVG output, collaboration, and
 * PowerPoint export against the same five slides. Later phases reuse them, so
 * generation stays deterministic: fixed ids, fixed timestamps, no clock reads,
 * no `Math.random`.
 */
import {
  DECK_DOCUMENT_KIND,
  DECK_SCHEMA_VERSION,
  DECK_SIZE_PRESETS,
  DECK_UNITS_PER_POINT,
} from '../../types/deck';
import type {
  DeckDocument,
  DeckElement,
  DeckLayout,
  DeckMaster,
  DeckParagraph,
  DeckParagraphStyle,
  DeckRichText,
  DeckRun,
  DeckRunStyle,
  DeckSlide,
  DeckTableCell,
  DeckTextBody,
  DeckTheme,
} from '../../types/deck';

const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';
const pt = (points: number) => points * DECK_UNITS_PER_POINT;

export const FIXTURE_IMAGE_PATH = 'assets/deck-fixture.png';

/** Builds a paragraph from plain text or explicit runs. */
export function paragraph(
  id: string,
  content: string | DeckRun[],
  style?: DeckParagraphStyle,
  runStyle?: DeckRunStyle,
): DeckParagraph {
  const runs: DeckRun[] =
    typeof content === 'string'
      ? [{ kind: 'text', text: content, ...(runStyle ? { style: runStyle } : {}) }]
      : content;
  return { id, runs, ...(style ? { style } : {}) };
}

export function richText(...paragraphs: DeckParagraph[]): DeckRichText {
  return { paragraphs };
}

export function textBody(
  content: DeckRichText,
  options: Omit<DeckTextBody, 'content'> = {},
): DeckTextBody {
  return { content, ...options };
}

function container(elements: DeckElement[]): {
  elements: Record<string, DeckElement>;
  elementOrder: string[];
} {
  const map: Record<string, DeckElement> = {};
  for (const element of elements) map[element.id] = element;
  return { elements: map, elementOrder: elements.map((element) => element.id) };
}

export const FIXTURE_THEME: DeckTheme = {
  id: 'theme-collab',
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

const MASTER: DeckMaster = {
  id: 'master-1',
  name: 'Collab master',
  themeId: FIXTURE_THEME.id,
  background: { kind: 'solid', color: { kind: 'theme', token: 'light1' } },
  textStyles: {
    title: [
      {
        paragraph: { align: 'left', lineSpacing: 90 },
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
        paragraph: { list: { kind: 'bullet', char: '•' }, spaceBefore: pt(10), indent: pt(20) },
        run: { font: { theme: 'body' }, size: pt(24), color: { kind: 'theme', token: 'dark2' } },
      },
      {
        paragraph: { list: { kind: 'bullet', char: '–' }, spaceBefore: pt(6), indent: pt(40) },
        run: { size: pt(20) },
      },
      {
        paragraph: { list: { kind: 'bullet', char: '•' }, spaceBefore: pt(4), indent: pt(60) },
        run: { size: pt(18) },
      },
    ],
    other: [
      {
        run: { font: { theme: 'body' }, size: pt(18), color: { kind: 'theme', token: 'dark1' } },
      },
    ],
  },
  ...container([
    {
      id: 'master-bar',
      type: 'shape',
      name: 'Accent bar',
      geometry: 'rect',
      frame: { x: 0, y: 0, width: 96_000, height: pt(8) },
      fill: { kind: 'solid', color: { kind: 'theme', token: 'accent1' } },
    },
    {
      id: 'master-title',
      type: 'text',
      placeholder: { type: 'title', key: 'title' },
      frame: { x: pt(48), y: pt(36), width: pt(864), height: pt(80) },
      text: textBody(richText(), { verticalAlign: 'bottom', autoFit: 'shrink' }),
    },
    {
      id: 'master-body',
      type: 'text',
      placeholder: { type: 'body', key: 'body' },
      frame: { x: pt(48), y: pt(132), width: pt(864), height: pt(340) },
      text: textBody(richText(), { verticalAlign: 'top' }),
    },
    {
      id: 'master-footer',
      type: 'text',
      placeholder: { type: 'footer', key: 'footer' },
      frame: { x: pt(48), y: pt(500), width: pt(600), height: pt(24) },
      text: textBody(richText(), {}),
    },
    {
      id: 'master-number',
      type: 'text',
      placeholder: { type: 'slideNumber', key: 'number' },
      frame: { x: pt(840), y: pt(500), width: pt(72), height: pt(24) },
      text: textBody(richText(paragraph('number-p', '', { align: 'right' }))),
    },
  ]),
};

const TITLE_LAYOUT: DeckLayout = {
  id: 'layout-title',
  name: 'Title slide',
  masterId: MASTER.id,
  background: { kind: 'solid', color: { kind: 'theme', token: 'dark1' } },
  showMasterElements: false,
  ...container([
    {
      id: 'layout-title-title',
      type: 'text',
      placeholder: { type: 'title', key: 'title' },
      frame: { x: pt(96), y: pt(170), width: pt(768), height: pt(110) },
      text: textBody(
        richText(
          paragraph(
            'ltt-p',
            '',
            { align: 'center' },
            { color: { kind: 'theme', token: 'light1' } },
          ),
        ),
        { verticalAlign: 'bottom' },
      ),
    },
    {
      id: 'layout-title-subtitle',
      type: 'text',
      placeholder: { type: 'subtitle', key: 'subtitle' },
      frame: { x: pt(96), y: pt(300), width: pt(768), height: pt(60) },
      text: textBody(
        richText(
          paragraph(
            'lts-p',
            '',
            { align: 'center', list: null },
            { color: { kind: 'theme', token: 'accent1' } },
          ),
        ),
      ),
    },
  ]),
};

const CONTENT_LAYOUT: DeckLayout = {
  id: 'layout-content',
  name: 'Title and content',
  masterId: MASTER.id,
  ...container([
    {
      id: 'layout-content-title',
      type: 'text',
      placeholder: { type: 'title', key: 'title' },
      text: textBody(richText()),
    },
    {
      id: 'layout-content-body',
      type: 'text',
      placeholder: { type: 'body', key: 'body' },
      text: textBody(richText()),
    },
  ]),
};

const BLANK_LAYOUT: DeckLayout = {
  id: 'layout-title-only',
  name: 'Title only',
  masterId: MASTER.id,
  ...container([
    {
      id: 'layout-title-only-title',
      type: 'text',
      placeholder: { type: 'title', key: 'title' },
      text: textBody(richText()),
    },
  ]),
};

function slide(
  id: string,
  layoutId: string,
  elements: DeckElement[],
  extra: Partial<DeckSlide> = {},
): DeckSlide {
  return { id, layoutId, ...container(elements), ...extra };
}

function titleElement(id: string, text: string): DeckElement {
  return {
    id,
    type: 'text',
    placeholder: { type: 'title', key: 'title' },
    text: textBody(richText(paragraph(`${id}-p`, text))),
  };
}

function cell(key: string, text: string, bold = false): DeckTableCell {
  return {
    text: textBody(
      richText(paragraph(`s4-${key}-p`, text, undefined, bold ? { bold } : undefined)),
      { insets: [pt(6), pt(4), pt(6), pt(4)] },
    ),
  };
}

/** The five-slide Phase 0 fixture. */
export function buildFixtureDeck(): DeckDocument {
  const slides: DeckSlide[] = [
    slide('slide-1', TITLE_LAYOUT.id, [
      titleElement('s1-title', 'Collab Presentations'),
      {
        id: 's1-subtitle',
        type: 'text',
        placeholder: { type: 'subtitle', key: 'subtitle' },
        text: textBody(richText(paragraph('s1-sub-p', 'Phase 0 fixture deck'))),
      },
    ]),
    slide(
      'slide-2',
      CONTENT_LAYOUT.id,
      [
        titleElement('s2-title', 'Why a native format'),
        {
          id: 's2-body',
          type: 'text',
          placeholder: { type: 'body', key: 'body' },
          text: textBody(
            richText(
              paragraph('s2-p1', [
                { kind: 'text', text: 'The ' },
                { kind: 'text', text: '.deck', style: { bold: true } },
                { kind: 'text', text: ' file is always the editable source' },
              ]),
              paragraph('s2-p2', 'PowerPoint files are generated copies', { level: 1 }),
              paragraph('s2-p3', 'Unsupported features are reported, never hidden', { level: 1 }),
              paragraph('s2-p4', [
                { kind: 'text', text: 'Read the ' },
                {
                  kind: 'text',
                  text: 'plan',
                  link: { kind: 'vault', path: 'docs/plans/presentation-tool-plan.md' },
                },
                { kind: 'break' },
                { kind: 'text', text: 'before changing the schema', style: { italic: true } },
              ]),
            ),
          ),
        },
        {
          // No frame and no text: position, alignment, and the number itself
          // all come from the master placeholder and the slide-number field.
          id: 's2-number',
          type: 'text',
          placeholder: { type: 'slideNumber', key: 'number' },
          text: textBody(richText(paragraph('s2-number-p', ''))),
        },
      ],
      {
        speakerNotes: richText(
          paragraph('s2-n1', 'Stress that export never changes the backing format.'),
        ),
      },
    ),
    slide('slide-3', BLANK_LAYOUT.id, [
      titleElement('s3-title', 'Shapes, lines, and images'),
      {
        id: 's3-card',
        type: 'shape',
        geometry: 'roundRect',
        frame: { x: pt(48), y: pt(140), width: pt(260), height: pt(140) },
        fill: { kind: 'solid', color: { kind: 'theme', token: 'accent1' } },
        text: textBody(
          richText(
            paragraph(
              's3-card-p',
              'Theme-coloured card with centred text',
              { align: 'center' },
              { color: { kind: 'theme', token: 'light1' }, bold: true },
            ),
          ),
          { verticalAlign: 'middle' },
        ),
      },
      {
        id: 's3-arrow',
        type: 'shape',
        geometry: 'rightArrow',
        frame: { x: pt(330), y: pt(180), width: pt(120), height: pt(60), rotation: 1_500 },
        fill: { kind: 'solid', color: { kind: 'theme', token: 'accent2' } },
      },
      {
        id: 's3-line',
        type: 'line',
        from: { x: pt(48), y: pt(320) },
        to: { x: pt(450), y: pt(420) },
        line: { color: { kind: 'rgb', value: '#374151' }, width: pt(2), dash: 'dash' },
        endArrow: 'triangle',
      },
      {
        id: 's3-image',
        type: 'image',
        frame: { x: pt(500), y: pt(140), width: pt(400), height: pt(225) },
        asset: {
          path: FIXTURE_IMAGE_PATH,
          mediaType: 'image/png',
          pixelWidth: 1_600,
          pixelHeight: 1_000,
        },
        crop: { left: 0, top: 50, right: 0, bottom: 50 },
        altText: 'Architecture diagram',
      },
      {
        id: 's3-group',
        type: 'group',
        name: 'Badge',
        frame: { x: pt(500), y: pt(390), width: pt(160), height: pt(80) },
        childIds: ['s3-badge-back', 's3-badge-dot'],
      },
      {
        id: 's3-badge-back',
        type: 'shape',
        geometry: 'rect',
        frame: { x: pt(500), y: pt(390), width: pt(160), height: pt(80) },
        fill: { kind: 'solid', color: { kind: 'theme', token: 'light2' } },
        line: { color: { kind: 'theme', token: 'accent1' }, width: pt(1) },
      },
      {
        id: 's3-badge-dot',
        type: 'shape',
        geometry: 'ellipse',
        frame: { x: pt(520), y: pt(410), width: pt(40), height: pt(40) },
        fill: { kind: 'solid', color: { kind: 'theme', token: 'accent4', alpha: 80 } },
      },
    ]),
    slide('slide-4', BLANK_LAYOUT.id, [
      titleElement('s4-title', 'A table'),
      {
        id: 's4-table',
        type: 'table',
        frame: { x: pt(48), y: pt(140), width: pt(600), height: pt(160) },
        rowOrder: ['r1', 'r2', 'r3', 'r4'],
        columnOrder: ['c1', 'c2', 'c3'],
        rowHeights: { r1: pt(40), r2: pt(40), r3: pt(40), r4: pt(40) },
        columnWidths: { c1: pt(240), c2: pt(180), c3: pt(180) },
        headerRow: true,
        border: { color: { kind: 'theme', token: 'dark2' }, width: pt(1) },
        cells: {
          'r1:c1': {
            ...cell('r1c1', 'Output', true),
            fill: { kind: 'solid', color: { kind: 'theme', token: 'light2' } },
          },
          'r1:c2': {
            ...cell('r1c2', 'Fidelity', true),
            fill: { kind: 'solid', color: { kind: 'theme', token: 'light2' } },
          },
          'r1:c3': {
            ...cell('r1c3', 'Phase', true),
            fill: { kind: 'solid', color: { kind: 'theme', token: 'light2' } },
          },
          'r2:c1': cell('r2c1', 'Editor stage'),
          'r2:c2': cell('r2c2', 'Exact'),
          'r2:c3': cell('r2c3', '2'),
          'r3:c1': cell('r3c1', 'PDF and images'),
          'r3:c2': cell('r3c2', 'Exact'),
          'r3:c3': cell('r3c3', '5'),
          'r4:c1': cell('r4c1', 'PowerPoint'),
          'r4:c2': cell('r4c2', 'Reported'),
          'r4:c3': cell('r4c3', '7'),
        },
      },
    ]),
    slide('slide-5', BLANK_LAYOUT.id, [
      titleElement('s5-title', 'A chart'),
      {
        id: 's5-chart',
        type: 'chart',
        kind: 'column',
        title: 'Export coverage',
        frame: { x: pt(48), y: pt(140), width: pt(560), height: pt(320) },
        categories: ['Text', 'Shapes', 'Images', 'Tables'],
        series: [
          { id: 'series-a', name: 'Exact', values: [92, 88, 100, 75] },
          { id: 'series-b', name: 'Reported', values: [8, 12, 0, 25] },
        ],
        showLegend: true,
      },
      {
        id: 's5-note',
        type: 'text',
        frame: { x: pt(640), y: pt(160), width: pt(272), height: pt(160) },
        fill: { kind: 'solid', color: { kind: 'rgb', value: '#fef3c7' } },
        text: textBody(
          richText(
            paragraph(
              's5-note-p',
              'A free text box: it takes the master "other" style, not the body style.',
            ),
          ),
          { autoFit: 'shrink' },
        ),
      },
    ]),
  ];

  // Group children are listed by their group only, never at the top level.
  const shapes = slides[2];
  shapes.elementOrder = shapes.elementOrder.filter(
    (id) => id !== 's3-badge-back' && id !== 's3-badge-dot',
  );

  // A deep copy, so a caller mutating the result never leaks into the next
  // fixture through the shared theme, master, and layout constants.
  return structuredClone({
    kind: DECK_DOCUMENT_KIND,
    schemaVersion: DECK_SCHEMA_VERSION,
    id: 'deck-fixture',
    name: 'Phase 0 fixture',
    createdAt: FIXED_TIMESTAMP,
    updatedAt: FIXED_TIMESTAMP,
    size: DECK_SIZE_PRESETS.widescreen,
    themeId: FIXTURE_THEME.id,
    themes: { [FIXTURE_THEME.id]: FIXTURE_THEME },
    masters: { [MASTER.id]: MASTER },
    layouts: {
      [TITLE_LAYOUT.id]: TITLE_LAYOUT,
      [CONTENT_LAYOUT.id]: CONTENT_LAYOUT,
      [BLANK_LAYOUT.id]: BLANK_LAYOUT,
    },
    slides: Object.fromEntries(slides.map((entry) => [entry.id, entry])),
    slideOrder: slides.map((entry) => entry.id),
    sections: [
      { id: 'section-intro', name: 'Introduction', firstSlideId: 'slide-1' },
      { id: 'section-objects', name: 'Objects', firstSlideId: 'slide-3' },
    ],
  } satisfies DeckDocument);
}

/**
 * A large synthetic deck for scale measurements: `slides` content slides, each
 * with a title, a five-paragraph body, and a few shapes.
 */
export function buildScaleDeck(slideCount: number): DeckDocument {
  const base = buildFixtureDeck();
  const slides: Record<string, DeckSlide> = {};
  const order: string[] = [];
  for (let index = 0; index < slideCount; index += 1) {
    const id = `scale-${index + 1}`;
    const elements: DeckElement[] = [
      titleElement(`${id}-title`, `Slide ${index + 1} of ${slideCount}`),
      {
        id: `${id}-body`,
        type: 'text',
        placeholder: { type: 'body', key: 'body' },
        text: textBody(
          richText(
            ...Array.from({ length: 5 }, (_, line) =>
              paragraph(
                `${id}-p${line}`,
                `Point ${line + 1}: a representative sentence that wraps across the body placeholder width`,
                { level: line % 2 },
              ),
            ),
          ),
        ),
      },
    ];
    for (let shape = 0; shape < 4; shape += 1) {
      elements.push({
        id: `${id}-shape-${shape}`,
        type: 'shape',
        geometry: shape % 2 === 0 ? 'rect' : 'ellipse',
        frame: { x: pt(600 + shape * 70), y: pt(420), width: pt(60), height: pt(40) },
        fill: { kind: 'solid', color: { kind: 'theme', token: 'accent2' } },
      });
    }
    slides[id] = slide(id, CONTENT_LAYOUT.id, elements);
    order.push(id);
  }
  return { ...base, id: `deck-scale-${slideCount}`, slides, slideOrder: order, sections: [] };
}
