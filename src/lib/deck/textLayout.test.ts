import { describe, expect, it } from 'vitest';

import { DECK_UNITS_PER_POINT } from '../../types/deck';

import type { ResolvedParagraph, ResolvedRunStyle, ResolvedTextBody } from './resolve';
import {
  breakUnits,
  createApproximateMeasurer,
  createCanvasMeasurer,
  cssFont,
  DECK_LINE_HEIGHT_FACTOR,
  layoutText,
} from './textLayout';

const pt = (points: number) => points * DECK_UNITS_PER_POINT;
const measurer = createApproximateMeasurer();

const STYLE: ResolvedRunStyle = {
  font: { family: 'Inter', fallbacks: ['Arial', 'sans-serif'] },
  size: pt(20),
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: { hex: '#111827', alpha: 1 },
  baseline: 'normal',
};

function para(text: string, overrides: Partial<ResolvedParagraph> = {}): ResolvedParagraph {
  return {
    id: `p-${text.length}-${overrides.align ?? 'l'}`,
    align: 'left',
    level: 0,
    label: null,
    indent: 0,
    spaceBefore: 0,
    spaceAfter: 0,
    lineSpacing: 100,
    runs: text.split('\n').flatMap((part, index) =>
      index === 0
        ? [{ kind: 'text' as const, text: part, style: STYLE }]
        : [
            { kind: 'break' as const, style: STYLE },
            { kind: 'text' as const, text: part, style: STYLE },
          ],
    ),
    endStyle: STYLE,
    ...overrides,
  };
}

function body(
  paragraphs: ResolvedParagraph[],
  overrides: Partial<ResolvedTextBody> = {},
): ResolvedTextBody {
  return {
    paragraphs,
    insets: [0, 0, 0, 0],
    verticalAlign: 'top',
    autoFit: 'none',
    wrap: true,
    ...overrides,
  };
}

const LONG =
  'The quick brown fox jumps over the lazy dog while the slide keeps its wrapping stable';

describe('layoutText', () => {
  it('keeps short text on one line', () => {
    const layout = layoutText(body([para('Hello')]), pt(400), pt(100), measurer);
    expect(layout.lines).toHaveLength(1);
    expect(layout.lines[0].fragments[0].text).toBe('Hello');
    expect(layout.overflow).toBe(false);
  });

  it('wraps at word boundaries and never exceeds the available width', () => {
    const width = pt(200);
    const layout = layoutText(body([para(LONG)]), width, pt(400), measurer);
    expect(layout.lines.length).toBeGreaterThan(2);
    for (const line of layout.lines) {
      expect(line.width).toBeLessThanOrEqual(width + 0.001);
      // No wrapped line starts or ends with a space.
      const text = line.fragments.map((fragment) => fragment.text).join('');
      expect(text).toBe(text.trim());
    }
    const rejoined = layout.lines
      .map((line) => line.fragments.map((f) => f.text).join(''))
      .join(' ');
    expect(rejoined).toBe(LONG);
  });

  it('splits a single word longer than the line', () => {
    const layout = layoutText(
      body([para('Antidisestablishmentarianism')]),
      pt(60),
      pt(400),
      measurer,
    );
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(layout.lines.map((line) => line.fragments[0].text).join('')).toBe(
      'Antidisestablishmentarianism',
    );
  });

  it('honours soft breaks', () => {
    const layout = layoutText(body([para('one\ntwo')]), pt(400), pt(200), measurer);
    expect(layout.lines.map((line) => line.fragments.map((f) => f.text).join(''))).toEqual([
      'one',
      'two',
    ]);
  });

  it('does not wrap when wrapping is off', () => {
    const layout = layoutText(body([para(LONG)], { wrap: false }), pt(100), pt(400), measurer);
    expect(layout.lines).toHaveLength(1);
  });

  it('uses 1.2x size per line at single spacing, scaled by line spacing', () => {
    const single = layoutText(body([para('a\nb')]), pt(400), pt(400), measurer);
    expect(single.lines[1].top - single.lines[0].top).toBeCloseTo(
      pt(20) * DECK_LINE_HEIGHT_FACTOR,
      6,
    );
    const double = layoutText(
      body([para('a\nb', { lineSpacing: 200 })]),
      pt(400),
      pt(400),
      measurer,
    );
    expect(double.lines[1].top - double.lines[0].top).toBeCloseTo(
      pt(20) * DECK_LINE_HEIGHT_FACTOR * 2,
      6,
    );
  });

  it('aligns centre and right inside the insets', () => {
    const width = pt(400);
    const insets: [number, number, number, number] = [pt(10), 0, pt(30), 0];
    const center = layoutText(
      body([para('Hi', { align: 'center' })], { insets }),
      width,
      pt(100),
      measurer,
    );
    const right = layoutText(
      body([para('Hi', { align: 'right' })], { insets }),
      width,
      pt(100),
      measurer,
    );
    const lineWidth = center.lines[0].width;
    expect(center.lines[0].fragments[0].x).toBeCloseTo(pt(10) + (pt(360) - lineWidth) / 2, 6);
    expect(right.lines[0].fragments[0].x).toBeCloseTo(width - pt(30) - lineWidth, 6);
  });

  it('hangs a list label left of the indented text on the first line only', () => {
    const layout = layoutText(
      body([para(LONG, { label: '•', indent: pt(40) })]),
      pt(240),
      pt(400),
      measurer,
    );
    expect(layout.lines[0].label?.text).toBe('•');
    expect(layout.lines[0].label!.x).toBeLessThan(layout.lines[0].fragments[0].x);
    expect(layout.lines[0].fragments[0].x).toBe(pt(40));
    expect(layout.lines.slice(1).every((line) => line.label === null)).toBe(true);
  });

  it('positions top, middle, and bottom vertical alignment', () => {
    const height = pt(300);
    const tops = (['top', 'middle', 'bottom'] as const).map(
      (verticalAlign) =>
        layoutText(body([para('x')], { verticalAlign }), pt(400), height, measurer).lines[0].top,
    );
    const lineHeight = pt(20) * DECK_LINE_HEIGHT_FACTOR;
    expect(tops[0]).toBe(0);
    expect(tops[1]).toBeCloseTo((height - lineHeight) / 2, 6);
    expect(tops[2]).toBeCloseTo(height - lineHeight, 6);
  });

  it('shrinks text to fit in whole-percent steps and reports overflow otherwise', () => {
    const paragraphs = Array.from({ length: 6 }, () => para(LONG));
    const plain = layoutText(body(paragraphs), pt(300), pt(200), measurer);
    expect(plain.overflow).toBe(true);
    expect(plain.scale).toBe(1);

    const shrunk = layoutText(body(paragraphs, { autoFit: 'shrink' }), pt(300), pt(200), measurer);
    expect(shrunk.scale).toBeLessThan(1);
    expect(Math.round(shrunk.scale * 100)).toBe(shrunk.scale * 100);
    expect(shrunk.contentHeight).toBeLessThanOrEqual(pt(200));
    expect(shrunk.overflow).toBe(false);
  });

  it('reports the height a growing box needs without flagging overflow', () => {
    const layout = layoutText(body([para(LONG)], { autoFit: 'grow' }), pt(120), pt(20), measurer);
    expect(layout.overflow).toBe(false);
    expect(layout.contentHeight).toBeGreaterThan(pt(20));
  });

  it('is deterministic', () => {
    const input = body([
      para(LONG, { label: '1.', indent: pt(20) }),
      para('tail', { align: 'right' }),
    ]);
    expect(layoutText(input, pt(250), pt(300), measurer)).toEqual(
      layoutText(input, pt(250), pt(300), measurer),
    );
  });
});

describe('measurers', () => {
  it('builds a quoted CSS font with generic fallbacks unquoted', () => {
    expect(cssFont({ ...STYLE, bold: true, italic: true }, 100)).toBe(
      'italic 700 100px "Inter", "Arial", sans-serif',
    );
  });

  it('scales a canvas measurement linearly from the reference size', () => {
    const calls: string[] = [];
    const fake = {
      font: '',
      measureText(text: string) {
        calls.push(this.font);
        return { width: text.length * 50 };
      },
    };
    const canvas = createCanvasMeasurer(fake);
    // 2 chars x 50 px at 100 px reference = 100 px wide at size 100 px.
    expect(canvas.measure('ab', { ...STYLE, size: 7_500 })).toBe(7_500);
    canvas.measure('ab', { ...STYLE, size: 1_000 });
    // Cached per font and text, independent of size.
    expect(calls).toHaveLength(1);
  });
});

describe('CJK line breaking', () => {
  it('keeps Latin words whole and breaks CJK text between characters', () => {
    expect(breakUnits('presentation')).toEqual(['presentation']);
    expect(breakUnits('日本語')).toEqual(['日', '本', '語']);
    expect(breakUnits('漢字abc')).toEqual(['漢', '字', 'abc']);
  });

  it('applies kinsoku: no closing punctuation or small kana at a line start', () => {
    expect(breakUnits('です。')).toEqual(['で', 'す。']);
    expect(breakUnits('ちょっと')).toEqual(['ちょっ', 'と']);
    expect(breakUnits('「日本」')).toEqual(['「日', '本」']);
    expect(breakUnits('一、二')).toEqual(['一、', '二']);
  });

  it('never splits a grapheme cluster', () => {
    expect(breakUnits('日👍🏽本').join('|')).toBe('日|👍🏽|本');
  });

  it('wraps CJK text without spaces and never starts a line with 。', () => {
    const text = '私は毎日学校に行きます。今日はとても良い天気です。';
    const layout = layoutText(body([para(text)]), pt(120), pt(400), measurer);
    expect(layout.lines.length).toBeGreaterThan(2);
    const lines = layout.lines.map((line) => line.fragments.map((f) => f.text).join(''));
    expect(lines.join('')).toBe(text);
    for (const line of lines) expect(line.startsWith('。')).toBe(false);
    for (const line of layout.lines) expect(line.width).toBeLessThanOrEqual(pt(120) + 1);
  });
});

describe('justified text', () => {
  it('stretches every wrapped line to the full width except the last', () => {
    const width = pt(200);
    const layout = layoutText(body([para(LONG, { align: 'justify' })]), width, pt(400), measurer);
    expect(layout.lines.length).toBeGreaterThan(2);
    for (const line of layout.lines.slice(0, -1)) {
      const last = line.fragments[line.fragments.length - 1];
      expect(last.x + last.width).toBeCloseTo(width, 3);
      expect(line.fragments.every((fragment) => !/\s/.test(fragment.text))).toBe(true);
    }
    const final = layout.lines[layout.lines.length - 1];
    const end = final.fragments[final.fragments.length - 1];
    expect(end.x + end.width).toBeLessThan(width - 1);
    const words = layout.lines.flatMap((line) => line.fragments.map((f) => f.text.trim()));
    expect(words.join(' ').replace(/\s+/g, ' ')).toBe(LONG);
  });
});
