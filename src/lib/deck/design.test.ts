import { describe, expect, it } from 'vitest';

import type { DeckDocument, DeckElement } from '../../types/deck';

import {
  createSlideForLayout,
  deleteLayout,
  duplicateLayout,
  hasPlaceholderOverrides,
  insertPlaceholder,
  placeholdersForLayout,
  resetPlaceholders,
  setSlideLayout,
  updateLayout,
  updateMaster,
  updateTheme,
} from './design';
import { createDeckDocument } from './document';
import { addElements, insertSlide, updateElements } from './operations';
import { plainText, resolveDesign, resolveSlide } from './resolve';
import type { ResolvedShapeItem } from './resolve';
import { applyTemplate, buildDesign, DECK_TEMPLATES } from './templates';
import { targetGeometry } from './transform';
import { validateDeck } from './validate';

const NOW = '2026-09-30T00:00:00.000Z';

const ids = () => {
  let count = 0;
  return (prefix: string) => `${prefix}-n${++count}`;
};

function deck(): DeckDocument {
  return createDeckDocument({ id: 'deck', name: 'Talk', now: NOW });
}

function withText(document: DeckDocument, slideId: string, elementId: string, text: string) {
  return updateElements(document, slideId, {
    [elementId]: (element) =>
      element.type === 'text'
        ? {
            ...element,
            text: {
              ...element.text,
              content: { paragraphs: [{ id: `${elementId}-p`, runs: [{ kind: 'text', text }] }] },
            },
          }
        : element,
  }).result;
}

function shape(document: DeckDocument, slideId: string, id: string): ResolvedShapeItem {
  const item = resolveSlide(document, slideId, { prompts: true }).items.find(
    (entry) => entry.id === id,
  );
  if (!item || item.kind !== 'shape') throw new Error(`no shape ${id}`);
  return item;
}

describe('design records', () => {
  it('edits the theme and restyles every slide, reversibly', () => {
    const before = deck();
    const edit = updateTheme(before, before.themeId, (theme) => ({
      ...theme,
      colors: { ...theme.colors, light1: '#000000' },
    }));
    expect(resolveSlide(edit.result, 'slide-1').background).toEqual({
      kind: 'solid',
      color: { hex: '#000000', alpha: 1 },
    });
    expect(edit.inverse(edit.result).result).toEqual(before);
  });

  it('edits master text styles, which every placeholder inherits', () => {
    const edit = updateMaster(deck(), 'master-default', (master) => ({
      ...master,
      textStyles: {
        ...master.textStyles,
        title: [{ ...master.textStyles.title[0], run: { size: 6_000 } }],
      },
    }));
    const document = withText(edit.result, 'slide-1', 'slide-1-title', 'Hello');
    const run = shape(document, 'slide-1', 'slide-1-title').text!.paragraphs[0].runs[0];
    expect(run.style.size).toBe(6_000);
  });

  it('renames, duplicates, and deletes layouts, refusing one in use', () => {
    const renamed = updateLayout(deck(), 'layout-blank', (layout) => ({
      ...layout,
      name: 'Empty',
    }));
    expect(renamed.result.layouts['layout-blank'].name).toBe('Empty');
    const copy = duplicateLayout(renamed.result, 'layout-content', 'layout-copy');
    expect(copy.result.layouts['layout-copy'].name).toBe('Title and content copy');
    expect(deleteLayout(copy.result, 'layout-copy').result.layouts['layout-copy']).toBeUndefined();
    expect(() => deleteLayout(copy.result, 'layout-title')).toThrow(/used by 1 slide/);
  });
});

describe('placeholders', () => {
  it('creates slides with one empty element per content placeholder', () => {
    const document = deck();
    const layout = document.layouts['layout-two-content'];
    expect(placeholdersForLayout(layout).map((ref) => ref.key)).toEqual([
      'title',
      'body',
      'body-2',
    ]);
    const slide = createSlideForLayout('s2', layout);
    const next = insertSlide(document, slide).result;
    expect(validateDeck(next).ok).toBe(true);
    const left = shape(next, 's2', 's2-body').frame;
    const right = shape(next, 's2', 's2-body-2').frame;
    expect(right.x).toBeGreaterThan(left.x + left.width);
  });

  it('shows prompt text in empty placeholders only when asked, dimmed on slides', () => {
    const document = deck();
    const plain = resolveSlide(document, 'slide-1').items[0] as ResolvedShapeItem;
    expect(plainText(plain.text)).toBe('');
    expect(plain.prompt).toBeUndefined();
    const prompted = shape(document, 'slide-1', 'slide-1-title');
    expect(prompted.prompt).toBe(true);
    expect(plainText(prompted.text)).toBe('Click to add title');
    const run = prompted.text!.paragraphs[0].runs[0];
    expect(run.style.color.alpha).toBe(0.5);
    // Alignment still comes from the layout's prompt paragraph.
    expect(prompted.text!.paragraphs[0].align).toBe('center');
  });

  it('uses the layout prompt text a person wrote', () => {
    let document = deck();
    document = updateLayout(document, 'layout-title', (layout) => ({
      ...layout,
      elements: {
        ...layout.elements,
        'layout-title-subtitle': {
          ...layout.elements['layout-title-subtitle'],
          text: {
            content: {
              paragraphs: [{ id: 'x', runs: [{ kind: 'text', text: 'Speaker, date' }] }],
            },
          },
        } as DeckElement,
      },
    })).result;
    expect(plainText(shape(document, 'slide-1', 'slide-1-subtitle').text)).toBe('Speaker, date');
    // Real content replaces the prompt.
    document = withText(document, 'slide-1', 'slide-1-subtitle', 'Ada');
    const subtitle = shape(document, 'slide-1', 'slide-1-subtitle');
    expect(subtitle.prompt).toBeUndefined();
    expect(plainText(subtitle.text)).toBe('Ada');
  });

  it('adds placeholders to a layout, which new slides then receive', () => {
    const edit = insertPlaceholder(deck(), { kind: 'layout', id: 'layout-content' }, 'body', 'ph');
    const layout = edit.result.layouts['layout-content'];
    expect(layout.elements.ph.placeholder).toEqual({ type: 'body', key: 'body-2' });
    expect(placeholdersForLayout(layout).map((ref) => ref.key)).toEqual([
      'title',
      'body',
      'body-2',
    ]);
    expect(validateDeck(edit.result).ok).toBe(true);
  });

  it('resets overrides but keeps text, links, and levels', () => {
    let document = withText(deck(), 'slide-1', 'slide-1-title', 'Hello');
    document = updateElements(document, 'slide-1', {
      'slide-1-title': (element) =>
        element.type === 'text'
          ? {
              ...element,
              frame: { x: 0, y: 0, width: 1_000, height: 1_000 },
              fill: { kind: 'solid', color: { kind: 'rgb', value: '#ff0000' } },
              text: {
                ...element.text,
                autoFit: 'shrink',
                content: {
                  paragraphs: [
                    {
                      id: 'p',
                      style: { level: 1, align: 'right' },
                      runs: [{ kind: 'text', text: 'Hello', style: { bold: true } }],
                    },
                  ],
                },
              },
            }
          : element,
    }).result;
    const element = document.slides['slide-1'].elements['slide-1-title'];
    expect(hasPlaceholderOverrides(element)).toBe(true);
    const reset = resetPlaceholders(document, 'slide-1');
    const after = reset.result.slides['slide-1'].elements['slide-1-title'];
    expect(hasPlaceholderOverrides(after)).toBe(false);
    expect(after).toMatchObject({
      text: {
        content: {
          paragraphs: [{ id: 'p', style: { level: 1 }, runs: [{ kind: 'text', text: 'Hello' }] }],
        },
      },
    });
    expect(shape(reset.result, 'slide-1', 'slide-1-title').frame).toEqual(
      shape(deck(), 'slide-1', 'slide-1-title').frame,
    );
    expect(reset.inverse(reset.result).result).toEqual(document);
  });
});

describe('setSlideLayout', () => {
  it('keeps matching placeholders, drops empty orphans, and adds new ones', () => {
    const document = deck();
    const edit = setSlideLayout(document, ['slide-1'], 'layout-content', ids());
    const slide = edit.result.slides['slide-1'];
    expect(slide.layoutId).toBe('layout-content');
    expect(Object.values(slide.elements).map((element) => element.placeholder?.key)).toEqual([
      'title',
      'body',
    ]);
    expect(validateDeck(edit.result).ok).toBe(true);
    expect(edit.inverse(edit.result).result).toEqual(document);
  });

  it('keeps an orphan with content where it was drawn', () => {
    const document = withText(deck(), 'slide-1', 'slide-1-subtitle', 'By Ada');
    const drawn = shape(document, 'slide-1', 'slide-1-subtitle').frame;
    const edit = setSlideLayout(document, ['slide-1'], 'layout-title-only', ids());
    const subtitle = edit.result.slides['slide-1'].elements['slide-1-subtitle'];
    expect(subtitle.frame).toEqual(drawn);
    expect(plainText(shape(edit.result, 'slide-1', 'slide-1-subtitle').text)).toBe('By Ada');
  });

  it('rekeys a placeholder that matched by type', () => {
    let document = deck();
    document = insertSlide(
      document,
      createSlideForLayout('s2', document.layouts['layout-content']),
    ).result;
    const edit = setSlideLayout(document, ['s2'], 'layout-two-content', ids());
    const keys = edit.result.slides.s2.elementOrder.map(
      (id) => edit.result.slides.s2.elements[id].placeholder?.key,
    );
    expect(keys).toEqual(['title', 'body', 'body-2']);
  });
});

describe('layout and master editing scenes', () => {
  it('draws a layout with its placeholders as prompts over the master artwork', () => {
    const document = createDeckDocument({ id: 'd', name: 'T', now: NOW, template: 'lecture' });
    const scene = resolveDesign(document, { kind: 'layout', id: 'layout-content' });
    const origins = scene.items.map((item) => `${item.origin}:${item.id}`);
    expect(origins).toContain('master:master-lecture-rule');
    expect(origins).toContain('layout:layout-content-title');
    const title = scene.items.find((item) => item.id === 'layout-content-title');
    expect(title?.kind === 'shape' && plainText(title.text)).toBe('Click to add title');
    const geometry = targetGeometry(document, { kind: 'layout', id: 'layout-content' });
    expect([...geometry.frames.keys()]).toEqual(['layout-content-title', 'layout-content-body']);
  });

  it('shows the slide-number field token on the master', () => {
    const scene = resolveDesign(deck(), { kind: 'master', id: 'master-default' });
    const number = scene.items.find((item) => item.id === 'master-number');
    expect(number?.kind === 'shape' && plainText(number.text)).toBe('‹#›');
  });

  it('lets element operations target layouts and masters', () => {
    const element: DeckElement = {
      id: 'logo',
      type: 'shape',
      geometry: 'ellipse',
      frame: { x: 0, y: 0, width: 1_000, height: 1_000 },
    };
    const edit = addElements(deck(), { kind: 'master', id: 'master-default' }, [element]);
    expect(edit.result.masters['master-default'].elementOrder).toContain('logo');
    // Master artwork paints under slides whose layout shows it.
    expect(resolveSlide(edit.result, 'slide-1').items.some((item) => item.id === 'logo')).toBe(
      true,
    );
    const hidden = updateLayout(edit.result, 'layout-title', (layout) => ({
      ...layout,
      showMasterElements: false,
    })).result;
    expect(resolveSlide(hidden, 'slide-1').items.some((item) => item.id === 'logo')).toBe(false);
  });
});

describe('templates', () => {
  it('builds a valid deck from every template at every size', () => {
    for (const template of DECK_TEMPLATES) {
      for (const sizePreset of ['widescreen', 'standard'] as const) {
        const document = createDeckDocument({
          id: 'd',
          name: 'T',
          now: NOW,
          template: template.id,
          sizePreset,
        });
        expect(validateDeck(document).ok, `${template.id} ${sizePreset}`).toBe(true);
        expect(Object.keys(document.layouts).sort()).toEqual(Object.keys(deck().layouts).sort());
      }
    }
  });

  it('keeps the Collab design identical to what decks were created with', () => {
    const design = buildDesign('collab', 96_000, 54_000);
    expect(design.theme.id).toBe('theme-default');
    expect(design.master.id).toBe('master-default');
    expect(design.master.elementOrder).toEqual([
      'master-title',
      'master-body',
      'master-footer',
      'master-number',
    ]);
  });

  it('applies a template, keeping slide content and layouts, undoably', () => {
    let document = withText(deck(), 'slide-1', 'slide-1-title', 'Hello');
    document = insertSlide(
      document,
      createSlideForLayout('s2', document.layouts['layout-content']),
    ).result;
    const edit = applyTemplate(document, 'midnight', ids());
    expect(validateDeck(edit.result).ok).toBe(true);
    expect(edit.result.themeId).toBe('theme-midnight');
    expect(Object.keys(edit.result.masters)).toEqual(['master-midnight']);
    expect(edit.result.slides.s2.layoutId).toBe('layout-content');
    const title = shape(edit.result, 'slide-1', 'slide-1-title');
    expect(plainText(title.text)).toBe('Hello');
    expect(title.text!.paragraphs[0].runs[0].style.color.hex).toBe('#f8fafc');
    const undone = edit.inverse(edit.result);
    expect(undone.result).toEqual(document);
    expect(undone.inverse(undone.result).result).toEqual(edit.result);
  });

  it('moves slides on a layout the template lacks to Title and content', () => {
    let document = deck();
    document = duplicateLayout(document, 'layout-blank', 'layout-custom').result;
    document = updateLayout(document, 'layout-custom', (layout) => ({
      ...layout,
      name: 'Mine',
    })).result;
    document = insertSlide(
      document,
      createSlideForLayout('s2', document.layouts['layout-custom']),
    ).result;
    const edit = applyTemplate(document, 'paper', ids());
    expect(edit.result.slides.s2.layoutId).toBe('layout-content');
    expect(edit.result.layouts['layout-custom']).toBeUndefined();
    expect(validateDeck(edit.result).ok).toBe(true);
  });
});
