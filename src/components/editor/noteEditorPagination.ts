import { type Extension, StateEffect, StateField } from '@codemirror/state';
import {
  type BlockInfo,
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';

import { NOTE_PAGE_GAP, notePageGeometry, type NotePageSettings } from '../../lib/notePageLayout';

export type PageBreak = { from: number; height: number; page: number };
type LayoutBlock = { from: number; to: number; height: number };

/** Layout-only gaps. No whitespace or page markers are inserted into Markdown. */
export function planEditorPages(
  blocks: LayoutBlock[],
  contentHeight: number,
  margin: number,
  text: (from: number, to: number) => string,
): PageBreak[] {
  const breaks: PageBreak[] = [];
  let used = 0;
  let page = 1;
  for (const block of blocks) {
    let from = block.from;
    let height = block.height;
    if (height <= 0) continue;
    if (used > 0 && height <= contentHeight && height > contentHeight - used + 0.5) {
      breaks.push({
        from,
        height: Math.max(0, contentHeight - used) + 2 * margin + NOTE_PAGE_GAP,
        page: page++,
      });
      used = 0;
    }
    // Very long wrapped source lines can span several sheets. Place a visual
    // break at a word boundary, then let the measured height map refine it.
    while (height > contentHeight - used + 0.5 && block.to - from > 1) {
      const available = Math.max(1, contentHeight - used);
      const fraction = available / height;
      let length = Math.max(1, Math.floor((block.to - from) * fraction));
      const prefix = text(from, from + length);
      const word = prefix.lastIndexOf(' ');
      if (word > length / 2) length = word + 1;
      // Never place a decoration between UTF-16 surrogate pairs.
      if (/[\uD800-\uDBFF]$/.test(text(from, from + length))) length--;
      if (length <= 0) break;
      from += length;
      breaks.push({ from, height: 2 * margin + NOTE_PAGE_GAP, page: page++ });
      height -= available;
      used = 0;
    }
    used += height;
  }
  return breaks;
}

class PageGap extends WidgetType {
  constructor(readonly gap: PageBreak) {
    super();
  }
  eq(other: PageGap) {
    return this.gap.page === other.gap.page && Math.abs(this.gap.height - other.gap.height) < 0.5;
  }
  get estimatedHeight() {
    return this.gap.height;
  }
  toDOM() {
    const gap = document.createElement('div');
    gap.className = 'note-editor-page-gap';
    gap.style.height = `${this.gap.height}px`;
    const label = document.createElement('span');
    label.textContent = `Page ${this.gap.page + 1}`;
    gap.append(label);
    gap.setAttribute('aria-hidden', 'true');
    return gap;
  }
  ignoreEvent() {
    return true;
  }
}

export function noteEditorPagination(settings: NotePageSettings): Extension {
  const geometry = notePageGeometry(settings);
  const setBreaks = StateEffect.define<PageBreak[]>();
  const field = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
      value = value.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (effect.is(setBreaks)) {
          value = Decoration.set(
            effect.value.map((gap) =>
              Decoration.widget({ widget: new PageGap(gap), block: true, side: -1 }).range(
                gap.from,
              ),
            ),
            true,
          );
        }
      }
      return value;
    },
    provide: (value) => EditorView.decorations.from(value),
  });

  return [
    field,
    EditorView.editorAttributes.of({ class: 'note-editor-paged' }),
    EditorView.theme({
      '&.note-editor-paged': {
        '--note-page-width': `${geometry.width}px`,
        '--note-page-height': `${geometry.height}px`,
        '--note-page-margin': `${geometry.margin}px`,
        '--note-page-content-height': `${geometry.contentHeight}px`,
      },
    }),
    ViewPlugin.fromClass(
      class {
        destroyed = false;
        passes = 0;
        constructor(readonly view: EditorView) {
          this.measure();
        }
        update(update: import('@codemirror/view').ViewUpdate) {
          const externalTransaction = update.transactions.some(
            (transaction) => !transaction.effects.some((effect) => effect.is(setBreaks)),
          );
          if (externalTransaction || update.viewportChanged) this.passes = 0;
          if (update.docChanged || update.geometryChanged || update.viewportChanged) this.measure();
        }
        measure() {
          if (this.passes++ > 12) return;
          this.view.requestMeasure({
            key: this,
            read: (view) => {
              const blocks: LayoutBlock[] = [];
              const add = (block: BlockInfo) => {
                if (Array.isArray(block.type)) {
                  for (const child of block.type) add(child);
                } else if (!(block.widget instanceof PageGap)) {
                  blocks.push({ from: block.from, to: block.to, height: block.height });
                }
              };
              for (let pos = 0; pos <= view.state.doc.length;) {
                const block = view.lineBlockAt(pos);
                add(block);
                if (block.to >= view.state.doc.length) break;
                pos = block.to + 1;
              }
              return planEditorPages(blocks, geometry.contentHeight, geometry.margin, (from, to) =>
                view.state.sliceDoc(from, to),
              );
            },
            write: (breaks, view) => {
              if (this.destroyed) return;
              const previous: PageBreak[] = [];
              view.state.field(field).between(0, view.state.doc.length, (from, _to, value) => {
                const widget = value.spec.widget as PageGap;
                previous.push({ ...widget.gap, from });
              });
              const same =
                breaks.length === previous.length &&
                breaks.every(
                  (gap, i) =>
                    gap.from === previous[i].from &&
                    Math.abs(gap.height - previous[i].height) < 0.5,
                );
              view.contentDOM.style.minHeight = `${(breaks.length + 1) * (geometry.height + NOTE_PAGE_GAP) - NOTE_PAGE_GAP}px`;
              if (!same) {
                const document = view.state.doc;
                // Measurement writes run inside CodeMirror's view update. A
                // transaction must wait until that update has completed.
                queueMicrotask(() => {
                  if (!this.destroyed && view.state.doc === document) {
                    view.dispatch({ effects: setBreaks.of(breaks) });
                  }
                });
              }
            },
          });
        }
        destroy() {
          this.destroyed = true;
          this.view.contentDOM.style.minHeight = '';
        }
      },
    ),
  ];
}
