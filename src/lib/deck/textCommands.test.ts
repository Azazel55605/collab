import { describe, expect, it } from 'vitest';

import type { DeckDocument, DeckRichText } from '../../types/deck';

import { createDeckDocument } from './document';
import { updateElements } from './operations';
import { resolveSlide } from './resolve';
import type { ResolvedTextBody } from './resolve';
import { runTextCommand, steppedSize, textState, wholeBody } from './textCommands';
import { editSession, redoSession, startTextSession, undoSession } from './textSession';

const NOW = '2026-09-30T00:00:00.000Z';

/** A deck whose title placeholder holds `content`, and that body resolved. */
function titled(content: DeckRichText): { deck: DeckDocument; resolved: ResolvedTextBody } {
  const deck = updateElements(createDeckDocument({ id: 'd', name: 'T', now: NOW }), 'slide-1', {
    'slide-1-title': (element) =>
      element.type === 'text' ? { ...element, text: { ...element.text, content } } : element,
  }).result;
  const item = resolveSlide(deck, 'slide-1').items.find((entry) => entry.id === 'slide-1-title');
  if (item?.kind !== 'shape' || !item.text) throw new Error('no title');
  return { deck, resolved: item.text };
}

const content: DeckRichText = {
  paragraphs: [{ id: 'p', runs: [{ kind: 'text', text: 'Hello world' }] }],
};

describe('text commands', () => {
  it('un-bolds an inherited bold title with an explicit false', () => {
    const { resolved } = titled(content);
    expect(textState(resolved, wholeBody(content)).bold).toBe(true);
    const result = runTextCommand(content, resolved, wholeBody(content), {
      kind: 'toggle',
      key: 'bold',
    });
    expect(result.body.paragraphs[0].runs[0]).toMatchObject({ style: { bold: false } });
  });

  it('sets a typing format on a caret instead of changing text', () => {
    const { resolved } = titled(content);
    const result = runTextCommand(
      content,
      resolved,
      { start: 5, end: 5 },
      {
        kind: 'toggle',
        key: 'italic',
      },
    );
    expect(result.body).toBe(content);
    expect(result.pending).toEqual({ style: { italic: true } });
    const state = textState(resolved, { start: 5, end: 5 }, result.pending);
    expect(state.italic).toBe(true);
  });

  it('toggles lists, removing an inherited one explicitly', () => {
    const { resolved } = titled(content);
    const on = runTextCommand(content, resolved, wholeBody(content), {
      kind: 'list',
      list: 'number',
    });
    expect(on.body.paragraphs[0].style).toEqual({ list: { kind: 'number' } });
    const { resolved: numbered } = titled(on.body);
    expect(textState(numbered, wholeBody(on.body)).list).toBe('number');
    const off = runTextCommand(on.body, numbered, wholeBody(on.body), {
      kind: 'list',
      list: 'number',
    });
    expect(off.body.paragraphs[0].style).toEqual({ list: null });
  });

  it('steps font sizes along the ladder and within the limits', () => {
    expect(steppedSize(1_800, 1)).toBe(2_000);
    expect(steppedSize(1_800, -1)).toBe(1_600);
    expect(steppedSize(100, -1)).toBe(100);
    const { resolved } = titled(content);
    const bigger = runTextCommand(content, resolved, wholeBody(content), {
      kind: 'sizeStep',
      direction: 1,
    });
    expect(bigger.body.paragraphs[0].runs[0]).toMatchObject({ style: { size: 4_400 } });
  });

  it('aligns, spaces, and links paragraphs', () => {
    const { resolved } = titled(content);
    const aligned = runTextCommand(
      content,
      resolved,
      { start: 2, end: 2 },
      {
        kind: 'align',
        value: 'right',
      },
    );
    expect(aligned.body.paragraphs[0].style).toEqual({ align: 'right' });
    const spaced = runTextCommand(
      content,
      resolved,
      { start: 0, end: 0 },
      {
        kind: 'paragraph',
        patch: { lineSpacing: 150 },
      },
    );
    expect(spaced.body.paragraphs[0].style).toEqual({ lineSpacing: 150 });
    const linked = runTextCommand(
      content,
      resolved,
      { start: 0, end: 5 },
      {
        kind: 'link',
        link: { kind: 'slide', slideId: 'slide-1' },
      },
    );
    expect(linked.body.paragraphs[0].runs[0]).toMatchObject({
      text: 'Hello',
      link: { kind: 'slide', slideId: 'slide-1' },
    });
  });
});

describe('text sessions', () => {
  const base = () =>
    startTextSession({
      kind: 'element',
      target: { kind: 'slide', id: 's' },
      elementId: 'e',
      body: { paragraphs: [] },
      selection: { anchor: 0, focus: 0 },
    });
  const text = (value: string): DeckRichText => ({
    paragraphs: [{ id: 'p', runs: [{ kind: 'text', text: value }] }],
  });

  it('groups a typing burst into one local undo step', () => {
    let session = base();
    session = editSession(session, text('a'), { anchor: 1, focus: 1 }, 'type', 1_000);
    session = editSession(session, text('ab'), { anchor: 2, focus: 2 }, 'type', 1_100);
    session = editSession(session, text('abc'), { anchor: 3, focus: 3 }, 'type', 5_000);
    const once = undoSession(session)!;
    expect(once.body).toEqual(text('ab'));
    const twice = undoSession(once)!;
    expect(twice.body).toEqual({ paragraphs: [] });
    expect(undoSession(twice)).toBeNull();
    expect(redoSession(twice)!.body).toEqual(text('ab'));
  });

  it('starts a new step when the kind of edit changes', () => {
    let session = base();
    session = editSession(session, text('ab'), { anchor: 2, focus: 2 }, 'type', 1_000);
    session = editSession(session, text('a'), { anchor: 1, focus: 1 }, 'delete', 1_100);
    expect(undoSession(session)!.body).toEqual(text('ab'));
  });
});
