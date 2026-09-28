import { describe, expect, it } from 'vitest';

import { DECK_UNITS_PER_POINT } from '../../types/deck';
import type { DeckDocument, DeckSlide } from '../../types/deck';

import { buildFixtureDeck, paragraph, richText, textBody } from './fixture';
import { DeckResolveError, plainText, resolveDeck, resolveSlide } from './resolve';
import type { ResolvedShapeItem } from './resolve';

const pt = (points: number) => points * DECK_UNITS_PER_POINT;

function shape(deck: DeckDocument, slideId: string, id: string): ResolvedShapeItem {
  const item = resolveSlide(deck, slideId).items.find((entry) => entry.id === id);
  if (!item || item.kind !== 'shape') throw new Error(`no shape ${id}`);
  return item;
}

describe('resolveSlide', () => {
  it('resolves every fixture slide', () => {
    const slides = resolveDeck(buildFixtureDeck());
    expect(slides.map((slide) => slide.number)).toEqual([1, 2, 3, 4, 5]);
    expect(slides.every((slide) => slide.items.length > 0)).toBe(true);
  });

  it('inherits a placeholder frame from the master through a frameless layout', () => {
    const deck = buildFixtureDeck();
    const title = shape(deck, 'slide-2', 's2-title');
    expect(title.frame).toMatchObject({ x: pt(48), y: pt(36), width: pt(864), height: pt(80) });
  });

  it('lets a layout placeholder override the master geometry and style', () => {
    const deck = buildFixtureDeck();
    const title = shape(deck, 'slide-1', 's1-title');
    expect(title.frame.y).toBe(pt(170));
    const paragraph = title.text!.paragraphs[0];
    expect(paragraph.align).toBe('center');
    // Master title style says dark1; the title layout's prompt says light1.
    const run = paragraph.runs[0];
    expect(run.kind === 'text' && run.style.color.hex).toBe(
      deck.themes['theme-collab'].colors.light1,
    );
    // Size and weight still come from the master title style.
    expect(run.style.size).toBe(pt(40));
    expect(run.style.bold).toBe(true);
  });

  it('applies master body styles per list level, with labels', () => {
    const body = shape(buildFixtureDeck(), 'slide-2', 's2-body').text!;
    expect(body.paragraphs.map((paragraph) => paragraph.label)).toEqual(['•', '–', '–', '•']);
    expect(body.paragraphs.map((paragraph) => paragraph.runs[0].style.size)).toEqual([
      pt(24),
      pt(20),
      pt(20),
      pt(24),
    ]);
    // Levels are independent, as in PowerPoint: level 1 sets only a size, and
    // its unset font falls back to the theme body font, not to level 0.
    expect(body.paragraphs[1].runs[0].style.font.family).toBe('Inter');
  });

  it('lets a slide-level run override inherited style without losing the rest', () => {
    const body = shape(buildFixtureDeck(), 'slide-2', 's2-body').text!;
    const [plain, bold] = body.paragraphs[0].runs;
    expect(plain.style.bold).toBe(false);
    expect(bold.style.bold).toBe(true);
    expect(bold.style.size).toBe(plain.style.size);
    expect(bold.style.color).toEqual(plain.style.color);
  });

  it('removes an inherited list when a layout sets list to null', () => {
    const subtitle = shape(buildFixtureDeck(), 'slide-1', 's1-subtitle');
    expect(subtitle.text!.paragraphs[0].label).toBeNull();
  });

  it('fills an empty slide-number placeholder with the slide number', () => {
    const number = shape(buildFixtureDeck(), 'slide-2', 's2-number');
    expect(plainText(number.text)).toBe('2');
    expect(number.frame.x).toBe(pt(840));
    expect(number.text!.paragraphs[0].align).toBe('right');
  });

  it('numbers lists and restarts numbering after an unnumbered paragraph', () => {
    const deck = buildFixtureDeck();
    const slide = deck.slides['slide-2'];
    const numbered = { kind: 'number' as const, numberStyle: 'alphaLcPeriod' as const };
    slide.elements['s2-body'] = {
      ...slide.elements['s2-body'],
      type: 'text',
      text: textBody(
        richText(
          paragraph('a', 'one', { list: numbered }),
          paragraph('b', 'two', { list: numbered }),
          paragraph('c', 'plain', { list: null }),
          paragraph('d', 'again', { list: numbered }),
        ),
      ),
    };
    const labels = shape(deck, 'slide-2', 's2-body').text!.paragraphs.map((p) => p.label);
    expect(labels).toEqual(['a.', 'b.', null, 'a.']);
  });

  it('paints master decorations only where the layout shows them', () => {
    const deck = buildFixtureDeck();
    const titleSlide = resolveSlide(deck, 'slide-1');
    const content = resolveSlide(deck, 'slide-2');
    expect(titleSlide.items.some((item) => item.id === 'master-bar')).toBe(false);
    expect(content.items[0].id).toBe('master-bar');
    expect(content.items[0].origin).toBe('master');
  });

  it('never paints master or layout placeholder prompts', () => {
    for (const slide of resolveDeck(buildFixtureDeck())) {
      expect(
        slide.items.every((item) => item.origin === 'slide' || item.placeholder === undefined),
      ).toBe(true);
    }
  });

  it('resolves backgrounds slide over layout over master', () => {
    const deck = buildFixtureDeck();
    const theme = deck.themes['theme-collab'];
    expect(resolveSlide(deck, 'slide-1').background).toEqual({
      kind: 'solid',
      color: { hex: theme.colors.dark1, alpha: 1 },
    });
    expect(resolveSlide(deck, 'slide-2').background).toEqual({
      kind: 'solid',
      color: { hex: theme.colors.light1, alpha: 1 },
    });
  });

  it('flattens groups into children in group order, multiplying opacity', () => {
    const deck = buildFixtureDeck();
    deck.slides['slide-3'].elements['s3-group'].opacity = 50;
    const items = resolveSlide(deck, 'slide-3').items;
    const ids = items.map((item) => item.id);
    expect(ids).not.toContain('s3-group');
    expect(ids.indexOf('s3-badge-back')).toBeLessThan(ids.indexOf('s3-badge-dot'));
    expect(items.find((item) => item.id === 's3-badge-dot')!.opacity).toBe(0.5);
  });

  it('resolves theme colours with alpha', () => {
    const dot = shape(buildFixtureDeck(), 'slide-3', 's3-badge-dot');
    expect(dot.fill).toEqual({ kind: 'solid', color: { hex: '#ef4444', alpha: 0.8 } });
  });

  it('lays out table cells from the row and column ids, honouring spans', () => {
    const deck = buildFixtureDeck();
    const table = deck.slides['slide-4'].elements['s4-table'];
    if (table.type !== 'table') throw new Error('fixture changed');
    table.cells['r4:c1'] = { ...table.cells['r4:c1'], colSpan: 2 };
    const item = resolveSlide(deck, 'slide-4').items.find((entry) => entry.id === 's4-table');
    if (item?.kind !== 'table') throw new Error('no table');
    expect(item.cells).toHaveLength(11);
    const merged = item.cells.find((cell) => cell.rowId === 'r4' && cell.columnId === 'c1')!;
    expect(merged.width).toBe(pt(420));
    expect(merged.y).toBe(item.frame.y + pt(120));
  });

  it('resolves notes as plain body text', () => {
    expect(plainText(resolveSlide(buildFixtureDeck(), 'slide-2').notes)).toContain(
      'backing format',
    );
  });

  it('rejects a group that contains itself instead of recursing forever', () => {
    const deck = buildFixtureDeck();
    const slide: DeckSlide = deck.slides['slide-3'];
    const group = slide.elements['s3-group'];
    if (group.type !== 'group') throw new Error('fixture changed');
    group.childIds = ['s3-group'];
    expect(() => resolveSlide(deck, 'slide-3')).toThrow(DeckResolveError);
  });

  it('rejects a frameless element with nothing to inherit from', () => {
    const deck = buildFixtureDeck();
    deck.slides['slide-5'].elements['s5-note'].frame = undefined;
    expect(() => resolveSlide(deck, 'slide-5')).toThrow(/no frame/);
  });

  it('does not depend on the application theme or zoom', () => {
    // The resolved scene is document content only; resolving twice is equal.
    const deck = buildFixtureDeck();
    expect(resolveSlide(deck, 'slide-3')).toEqual(resolveSlide(deck, 'slide-3'));
  });
});
