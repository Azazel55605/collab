/**
 * Phase 0 evaluation: can Lexical edit `.deck` rich text without its state
 * becoming the format?
 *
 * This is an evaluation, not an adapter. `lexical` and `@lexical/headless` are
 * devDependencies used only here. The conclusions are recorded in
 * `docs/plans/presentation-phase0-contract.md`.
 */
import { createHeadlessEditor } from '@lexical/headless';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getState,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  $setState,
  createState,
} from 'lexical';
import type { ElementFormatType, LexicalEditor } from 'lexical';
import { describe, expect, it } from 'vitest';

import type {
  DeckLink,
  DeckParagraphStyle,
  DeckRichText,
  DeckRun,
  DeckRunStyle,
} from '../../types/deck';

import { buildFixtureDeck, paragraph, richText } from './fixture';

// Deck data rides on Lexical nodes as NodeState, so nothing is lost to
// Lexical's own, narrower model. Lexical's format bits and CSS style mirror it
// only for display.
const paragraphId = createState('deckParagraphId', {
  parse: (value) => (typeof value === 'string' ? value : ''),
});
const paragraphStyle = createState('deckParagraphStyle', {
  parse: (value) => (value && typeof value === 'object' ? (value as DeckParagraphStyle) : null),
});
const runData = createState('deckRun', {
  parse: (value) =>
    value && typeof value === 'object' ? (value as { style?: DeckRunStyle; link?: DeckLink }) : {},
});

const ALIGN: Record<string, ElementFormatType> = {
  left: 'left',
  center: 'center',
  right: 'right',
  justify: 'justify',
};

function editor(): LexicalEditor {
  return createHeadlessEditor({
    namespace: 'deck-eval',
    onError: (error) => {
      throw error;
    },
  });
}

function load(target: LexicalEditor, text: DeckRichText): void {
  target.update(
    () => {
      const root = $getRoot();
      root.clear();
      for (const source of text.paragraphs) {
        const node = $createParagraphNode();
        $setState(node, paragraphId, source.id);
        if (source.style) {
          $setState(node, paragraphStyle, source.style);
          if (source.style.align) node.setFormat(ALIGN[source.style.align]);
          if (source.style.level) node.setIndent(source.style.level);
        }
        for (const run of source.runs) {
          if (run.kind === 'break') {
            node.append($createLineBreakNode());
            continue;
          }
          if (run.text === '') continue;
          const textNode = $createTextNode(run.text);
          if (run.style?.bold) textNode.toggleFormat('bold');
          if (run.style?.italic) textNode.toggleFormat('italic');
          if (run.style?.underline) textNode.toggleFormat('underline');
          if (run.style?.strike) textNode.toggleFormat('strikethrough');
          // Every run carries state, even an empty one. Lexical's merge check
          // skips the state comparison when the first node's state is null, so
          // an adapter should never leave it null.
          $setState(textNode, runData, {
            ...(run.style ? { style: run.style } : {}),
            ...(run.link ? { link: run.link } : {}),
          });
          node.append(textNode);
        }
        root.append(node);
      }
    },
    { discrete: true },
  );
}

function read(target: LexicalEditor): DeckRichText {
  return target.getEditorState().read(() => ({
    paragraphs: $getRoot()
      .getChildren()
      .filter($isParagraphNode)
      .map((node) => {
        const runs: DeckRun[] = [];
        for (const child of node.getChildren()) {
          if ($isLineBreakNode(child)) runs.push({ kind: 'break' });
          else if ($isTextNode(child)) {
            const data = $getState(child, runData);
            runs.push({ kind: 'text', text: child.getTextContent(), ...data });
          }
        }
        const style = $getState(node, paragraphStyle);
        return { id: $getState(node, paragraphId), runs, ...(style ? { style } : {}) };
      }),
  }));
}

describe('Lexical as a .deck text editing adapter', () => {
  it('holds every fixture body losslessly through NodeState', () => {
    const deck = buildFixtureDeck();
    const bodies: DeckRichText[] = [];
    for (const slide of Object.values(deck.slides)) {
      for (const element of Object.values(slide.elements)) {
        if ((element.type === 'text' || element.type === 'shape') && element.text)
          bodies.push(element.text.content);
      }
    }
    for (const body of bodies) {
      const target = editor();
      load(target, body);
      const expected = {
        paragraphs: body.paragraphs.map(({ endStyle: _end, ...rest }) => ({
          ...rest,
          runs: rest.runs.filter((run) => run.kind === 'break' || run.text !== ''),
        })),
      };
      expect(read(target)).toEqual(expected);
    }
  });

  it('keeps adjacent runs apart when only deck-only style differs', () => {
    // Same Lexical format and CSS, different theme colour: must not merge.
    const target = editor();
    load(
      target,
      richText(
        paragraph('p', [
          { kind: 'text', text: 'accent ', style: { color: { kind: 'theme', token: 'accent1' } } },
          { kind: 'text', text: 'dark', style: { color: { kind: 'theme', token: 'dark1' } } },
        ]),
      ),
    );
    target.update(() => $getRoot().getFirstDescendant()?.markDirty(), { discrete: true });
    expect(read(target).paragraphs[0].runs).toHaveLength(2);
  });
});
