import { EditorSelection, EditorState, RangeSetBuilder } from '@codemirror/state';
import { indentMore } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
} from '@codemirror/view';

export type EditorIndentStyle = 'spaces' | 'tabs';

class IndentMarkerWidget extends WidgetType {
  constructor(
    private readonly symbol: string,
    private readonly widthCh: number,
    private readonly className: string,
  ) {
    super();
  }

  eq(other: IndentMarkerWidget) {
    return this.symbol === other.symbol && this.widthCh === other.widthCh && this.className === other.className;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = this.className;
    span.textContent = this.symbol;
    span.setAttribute('aria-hidden', 'true');
    span.style.width = `${this.widthCh}ch`;
    return span;
  }
}

class AsciiArrowLigatureWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly symbol: string,
  ) {
    super();
  }

  eq(other: AsciiArrowLigatureWidget) {
    return this.source === other.source && this.symbol === other.symbol;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ascii-arrow-ligature';
    span.textContent = this.symbol;
    span.setAttribute('aria-hidden', 'true');
    span.dataset.ligatureSource = this.source;
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

export const ASCII_LIGATURE_PAIRS: Record<string, string> = {
  '/\\': '↑',
  '\\/': '↓',
  '<=': '≤',
  '>=': '≥',
};

function buildAsciiArrowLigatureDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const selectionLines = new Set<number>();

  for (const range of view.state.selection.ranges) {
    const fromLine = view.state.doc.lineAt(range.from).number;
    const toLine = view.state.doc.lineAt(range.to).number;
    for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
      selectionLines.add(lineNumber);
    }
  }

  for (const { from, to } of view.visibleRanges) {
    let linePos = from;
    while (linePos <= to) {
      const line = view.state.doc.lineAt(linePos);
      linePos = line.to + 1;

      if (selectionLines.has(line.number)) continue;

      for (let index = 0; index < line.text.length - 1; index += 1) {
        const pair = line.text.slice(index, index + 2);
        const symbol = ASCII_LIGATURE_PAIRS[pair] ?? null;
        if (!symbol) continue;

        builder.add(
          line.from + index,
          line.from + index + 2,
          Decoration.replace({ widget: new AsciiArrowLigatureWidget(pair, symbol) }),
        );
        index += 1;
      }
    }
  }

  return builder.finish();
}

export function asciiArrowLigatures() {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildAsciiArrowLigatureDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged) {
        this.decorations = buildAsciiArrowLigatureDecorations(update.view);
      }
    }
  }, {
    decorations: (value) => value.decorations,
  });
}

function buildIndentDecorations(
  view: EditorView,
  showMarkers: boolean,
  showColors: boolean,
  indentStyle: EditorIndentStyle,
  indentWidth: number,
): DecorationSet {
  if (!showMarkers && !showColors) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const tabWidth = view.state.tabSize;

  for (const { from, to } of view.visibleRanges) {
    let linePos = from;
    while (linePos <= to) {
      const line = view.state.doc.lineAt(linePos);
      let visualDepth = 0;
      let pendingSpaceRunStart: number | null = null;
      let pendingSpaceRunLength = 0;

      const flushSpaceRun = () => {
        if (pendingSpaceRunStart == null || pendingSpaceRunLength === 0) return;
        const unitSize = Math.max(1, indentStyle === 'spaces' ? indentWidth : tabWidth);
        const fullUnits = Math.floor(pendingSpaceRunLength / unitSize);
        const baseDepth = Math.floor((visualDepth - pendingSpaceRunLength) / unitSize);

        for (let unitIndex = 0; unitIndex < fullUnits; unitIndex++) {
          const fromPos = line.from + pendingSpaceRunStart + unitIndex * unitSize;
          const toPos = fromPos + unitSize;
          const depthClass = `cm-indent-guide-depth-${(baseDepth + unitIndex) % 6}`;

          if (showMarkers) {
            builder.add(
              fromPos,
              toPos,
              Decoration.replace({
                widget: new IndentMarkerWidget(
                  '·'.repeat(unitSize),
                  unitSize,
                  showColors
                    ? `cm-indent-marker cm-indent-marker-space ${depthClass}`
                    : 'cm-indent-marker cm-indent-marker-space',
                ),
              }),
            );
          } else if (showColors) {
            builder.add(fromPos, toPos, Decoration.mark({ class: depthClass }));
          }
        }

        const remainder = pendingSpaceRunLength % unitSize;
        if (remainder > 0) {
          const fromPos = line.from + pendingSpaceRunStart + fullUnits * unitSize;
          const toPos = fromPos + remainder;
          const depthClass = `cm-indent-guide-depth-${(baseDepth + fullUnits) % 6}`;
          if (showMarkers) {
            builder.add(
              fromPos,
              toPos,
              Decoration.replace({
                widget: new IndentMarkerWidget(
                  '·'.repeat(remainder),
                  remainder,
                  showColors
                    ? `cm-indent-marker cm-indent-marker-space ${depthClass}`
                    : 'cm-indent-marker cm-indent-marker-space',
                ),
              }),
            );
          } else if (showColors) {
            builder.add(fromPos, toPos, Decoration.mark({ class: depthClass }));
          }
        }
        pendingSpaceRunStart = null;
        pendingSpaceRunLength = 0;
      };

      for (let index = 0; index < line.text.length; index++) {
        const char = line.text[index];
        if (char !== ' ' && char !== '\t') {
          flushSpaceRun();
          break;
        }

        const fromPos = line.from + index;
        const toPos = fromPos + 1;
        const widthCh = char === '\t' ? tabWidth : 1;

        if (char === ' ') {
          if (pendingSpaceRunStart == null) {
            pendingSpaceRunStart = index;
          }
          pendingSpaceRunLength += 1;
        } else {
          flushSpaceRun();
          if (showColors) {
            const depthClass = `cm-indent-guide-depth-${Math.floor(visualDepth / Math.max(1, tabWidth)) % 6}`;
            if (showMarkers) {
              builder.add(
                fromPos,
                toPos,
                Decoration.replace({
                  widget: new IndentMarkerWidget('→', widthCh, `cm-indent-marker cm-indent-marker-tab ${depthClass}`),
                }),
              );
            } else {
              builder.add(fromPos, toPos, Decoration.mark({ class: depthClass }));
            }
          } else if (showMarkers) {
            builder.add(
              fromPos,
              toPos,
              Decoration.replace({
                widget: new IndentMarkerWidget('→', widthCh, 'cm-indent-marker cm-indent-marker-tab'),
              }),
            );
          }
        }
        visualDepth += widthCh;
      }

      flushSpaceRun();

      linePos = line.to + 1;
    }
  }

  return builder.finish();
}

export function indentVisualization(
  showMarkers: boolean,
  showColors: boolean,
  indentStyle: EditorIndentStyle,
  indentWidth: number,
) {
  if (!showMarkers && !showColors) return [];

  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildIndentDecorations(view, showMarkers, showColors, indentStyle, indentWidth);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.decorations = buildIndentDecorations(update.view, showMarkers, showColors, indentStyle, indentWidth);
      }
    }
  }, {
    decorations: (value) => value.decorations,
  });
}

export function indentationConfig(indentStyle: EditorIndentStyle, tabWidth: number) {
  return [
    EditorState.tabSize.of(tabWidth),
    indentUnit.of(indentStyle === 'tabs' ? '\t' : ' '.repeat(tabWidth)),
  ];
}

function insertIndentUnitAtCursor(view: EditorView) {
  const unit = view.state.facet(indentUnit);
  const transaction = view.state.changeByRange((range) => ({
    changes: { from: range.from, to: range.to, insert: unit },
    range: EditorSelection.cursor(range.from + unit.length),
  }));

  view.dispatch(transaction);
  return true;
}

export function handleTabKey(view: EditorView) {
  if (view.state.selection.ranges.some((range) => !range.empty)) {
    return indentMore(view);
  }

  return insertIndentUnitAtCursor(view);
}
