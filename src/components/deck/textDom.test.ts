import { beforeEach, describe, expect, it } from 'vitest';

import { buildFixtureDeck } from '../../lib/deck/fixture';
import { resolveSlide } from '../../lib/deck/resolve';
import type { ResolvedTextBody } from '../../lib/deck/resolve';

import {
  domFromOffset,
  offsetFromDom,
  readSelection,
  renderEditorContent,
  renderedLength,
  writeSelection,
} from './textDom';

function body(): ResolvedTextBody {
  const deck = buildFixtureDeck();
  const element = deck.slides['slide-2'].elements['s2-body'];
  if (element.type !== 'text') throw new Error('fixture changed');
  // A soft break inside the first paragraph, and an empty last paragraph.
  element.text.content.paragraphs[0].runs.push({ kind: 'break' }, { kind: 'text', text: 'tail' });
  element.text.content.paragraphs.push({ id: 'empty', runs: [] });
  const item = resolveSlide(deck, 'slide-2').items.find((entry) => entry.id === 's2-body');
  if (item?.kind !== 'shape' || !item.text) throw new Error('fixture changed');
  return item.text;
}

describe('editor DOM', () => {
  let root: HTMLDivElement;
  let resolved: ResolvedTextBody;

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    root.contentEditable = 'true';
    document.body.appendChild(root);
    resolved = body();
    renderEditorContent(root, resolved, { pxPerUnit: 0.01 });
  });

  const modelLength = () =>
    resolved.paragraphs.reduce(
      (total, paragraph) =>
        total +
        paragraph.runs.reduce((sum, run) => sum + (run.kind === 'break' ? 1 : run.text.length), 0),
      0,
    ) +
    resolved.paragraphs.length -
    1;

  it('renders text as text nodes, labels outside the addressable text', () => {
    expect(root.querySelectorAll('[data-p]')).toHaveLength(resolved.paragraphs.length);
    expect(root.querySelector('[data-skip="label"]')?.textContent).toBe(
      resolved.paragraphs[0].label,
    );
    expect(root.querySelector('script')).toBeNull();
    expect(renderedLength(root)).toBe(modelLength());
  });

  it('round-trips every offset through the DOM', () => {
    for (let offset = 0; offset <= modelLength(); offset += 1) {
      const point = domFromOffset(root, offset);
      expect(offsetFromDom(root, point.node, point.offset), `offset ${offset}`).toBe(offset);
    }
  });

  it('maps element-level points, labels, and the root itself', () => {
    const first = root.querySelector('[data-p]')!;
    expect(offsetFromDom(root, first, 0)).toBe(0);
    const label = first.querySelector('[data-skip="label"]')!;
    expect(offsetFromDom(root, label.firstChild!, 1)).toBe(0);
    expect(offsetFromDom(root, root, root.childNodes.length)).toBe(modelLength());
    expect(offsetFromDom(root, document.body, 0)).toBeNull();
  });

  it('writes and reads a selection, keeping its direction', () => {
    root.focus();
    writeSelection(root, { anchor: 12, focus: 3 });
    expect(readSelection(root)).toEqual({ anchor: 12, focus: 3 });
    writeSelection(root, { anchor: modelLength(), focus: modelLength() });
    expect(readSelection(root)).toEqual({ anchor: modelLength(), focus: modelLength() });
  });
});
