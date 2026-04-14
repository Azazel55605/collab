import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Compartment, RangeSetBuilder } from '@codemirror/state';
import { useUiStore, EDITOR_FONTS, type ColorPreviewFormat } from '../../store/uiStore';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  dropCursor,
  highlightActiveLineGutter,
  Decoration,
  type DecorationSet,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { GFM } from '@lezer/markdown';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useEditorStore } from '../../store/editorStore';
import { createLivePreviewPlugin } from './livePreview';
import { tauriCommands } from '../../lib/tauri';
import { useVaultStore } from '../../store/vaultStore';
import { openUrl, openPath } from '@tauri-apps/plugin-opener';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { toast } from 'sonner';
import 'katex/dist/katex.min.css';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuTrigger,
} from '../ui/context-menu';

export interface MarkdownEditorHandle {
  /** Wrap selection with `before`/`after`; if no selection, insert `before + placeholder + after` and select placeholder. */
  insertAround: (before: string, after: string, placeholder: string) => void;
  /** Toggle a line prefix (e.g. `# `, `> `) on the current line. */
  insertLine: (prefix: string) => void;
  /** Insert arbitrary text at cursor / replace selection. Supports a single `<cursor>` marker. */
  insertSnippet: (text: string) => void;
  replaceRange: (from: number, to: number, text: string) => void;
  getTableAtCursor: () => { from: number; to: number; text: string } | null;
}

interface MarkdownEditorProps {
  content: string;
  onChange: (value: string) => void;
  onSave: (value: string) => Promise<void>;
  relativePath: string;
}

const IMAGE_DROP_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

function getFileExtension(path: string): string {
  const base = path.split(/[?#]/, 1)[0];
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function isImageLikePath(path: string): boolean {
  return IMAGE_DROP_EXTENSIONS.has(getFileExtension(path));
}

function buildImageMarkdown(relativePath: string): string {
  const fileName = relativePath.split('/').pop() ?? relativePath;
  const alt = fileName.replace(/\.[^.]+$/, '');
  return `![${alt}](${relativePath})`;
}

function getDroppedFilePaths(event: DragEvent): string[] {
  const fromFiles = Array.from(event.dataTransfer?.files ?? [])
    .map((file) => (file as File & { path?: string }).path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
  if (fromFiles.length > 0) return fromFiles;

  const uriList = event.dataTransfer?.getData('text/uri-list') ?? '';
  return uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      try {
        return line.startsWith('file://') ? decodeURIComponent(line.slice(7)) : '';
      } catch {
        return '';
      }
    })
    .filter((path) => path.length > 0);
}

function isMarkdownTableLine(text: string) {
  return /^\s*\|.*\|\s*$/.test(text);
}

function getTableRangeAtCursor(view: EditorView) {
  const { from } = view.state.selection.main;
  const currentLine = view.state.doc.lineAt(from);
  if (!isMarkdownTableLine(currentLine.text)) return null;

  let startLine = currentLine.number;
  let endLine = currentLine.number;

  while (startLine > 1 && isMarkdownTableLine(view.state.doc.line(startLine - 1).text)) {
    startLine -= 1;
  }
  while (endLine < view.state.doc.lines && isMarkdownTableLine(view.state.doc.line(endLine + 1).text)) {
    endLine += 1;
  }

  if (endLine - startLine + 1 < 2) return null;

  const firstLine = view.state.doc.line(startLine);
  const lastLine = view.state.doc.line(endLine);
  return {
    from: firstLine.from,
    to: lastLine.to,
    text: view.state.sliceDoc(firstLine.from, lastLine.to),
  };
}

// ─── Theme factory ────────────────────────────────────────────────────────────
// Uses CSS variables so the editor automatically tracks the active app theme.

function buildCollabTheme(dark: boolean, fontFamily: string, fontSize: number) {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: `${fontSize}px`,
        fontFamily,
        // Match --background (not --card) so the editor blends seamlessly with the app.
        backgroundColor: 'var(--background)',
      },
      // lineWrapping (EditorView.lineWrapping) normally sets overflow-x:hidden on
      // the scroller, but our explicit 'overflow: auto' was overriding that —
      // causing horizontal scrollbars to appear in AppImage where GDK scale
      // measurements drift slightly. Use per-axis values so vertical scroll is
      // preserved while horizontal is blocked (tables/math have their own wrappers).
      '.cm-scroller': { overflowX: 'hidden', overflowY: 'auto', lineHeight: '1.7', fontFamily },
      '.cm-content': {
        // Responsive column centering: pad inward until the text column reaches
        // ~860px, but cap the left/right padding at 48px so the gap between
        // line numbers and text stays small on wide viewports.
        // Because the padding is *inside* .cm-content (not on the element itself),
        // getBoundingClientRect() is unaffected and posAtCoords() stays accurate.
        padding: '16px max(16px, min(48px, calc(50% - 430px)))',
        caretColor: 'var(--primary)',
      },
      // --editor-selection / --editor-selection-dim are set from JS in App.tsx
      // alongside --primary, so they always track the active accent colour
      // without relying on color-mix() or relative-color syntax (both have
      // uneven WebKitGTK support).
      '&.cm-focused .cm-selectionBackground': {
        background: 'var(--editor-selection)',
        borderRadius: '3px',
      },
      '.cm-selectionBackground': {
        background: 'var(--editor-selection-dim)',
        borderRadius: '3px',
      },
      // When two selection segments are adjacent (multi-line), remove the shared-edge
      // radius so they form a continuous block — only the outermost corners stay rounded.
      '.cm-selectionBackground + .cm-selectionBackground': {
        borderTopLeftRadius: '0',
        borderTopRightRadius: '0',
      },
      '&.cm-focused .cm-selectionBackground + .cm-selectionBackground': {
        borderTopLeftRadius: '0',
        borderTopRightRadius: '0',
      },
      // :has() removes bottom radius from any selection that has a following sibling selection
      '.cm-selectionBackground:has(+ .cm-selectionBackground)': {
        borderBottomLeftRadius: '0',
        borderBottomRightRadius: '0',
      },
      '&.cm-focused .cm-selectionBackground:has(+ .cm-selectionBackground)': {
        borderBottomLeftRadius: '0',
        borderBottomRightRadius: '0',
      },
      '.cm-selectionMatch': {
        background: 'var(--editor-selection-dim)',
        outline: '1px solid var(--editor-selection)',
        borderRadius: '3px',
      },
      '&.cm-focused .cm-cursor': {
        borderLeftColor: 'var(--primary)',
        borderLeftWidth: '2px',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--background)',
        border: 'none',
        color: 'var(--muted-foreground)',
        // Nudge gutters rightward to sit just left of the text column.
        // Capped at 24px (≈ gutter element width) to match the content padding cap.
        paddingLeft: 'max(0px, min(24px, calc(50% - 454px)))',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 8px 0 4px',
        minWidth: '2.5em',
        textAlign: 'right',
        fontFamily: "ui-monospace, 'SFMono-Regular', 'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
      },
      '.cm-indent-marker': {
        color: 'var(--muted-foreground)',
        opacity: '0.45',
        pointerEvents: 'none',
        display: 'inline-block',
        whiteSpace: 'pre',
      },
      '.cm-indent-marker-space': {
        textAlign: 'center',
      },
      '.cm-indent-marker-tab': {
        textAlign: 'left',
      },
      '.cm-indent-guide-depth-0': { boxShadow: 'inset 2px 0 0 oklch(from var(--primary) l c h / 0.38)', backgroundColor: 'oklch(from var(--primary) l c h / 0.06)' },
      '.cm-indent-guide-depth-1': { boxShadow: 'inset 2px 0 0 oklch(0.82 0.17 210 / 0.42)', backgroundColor: 'oklch(0.82 0.17 210 / 0.06)' },
      '.cm-indent-guide-depth-2': { boxShadow: 'inset 2px 0 0 oklch(0.86 0.15 160 / 0.42)', backgroundColor: 'oklch(0.86 0.15 160 / 0.06)' },
      '.cm-indent-guide-depth-3': { boxShadow: 'inset 2px 0 0 oklch(0.83 0.19 40 / 0.42)', backgroundColor: 'oklch(0.83 0.19 40 / 0.06)' },
      '.cm-indent-guide-depth-4': { boxShadow: 'inset 2px 0 0 oklch(0.80 0.20 320 / 0.42)', backgroundColor: 'oklch(0.80 0.20 320 / 0.06)' },
      '.cm-indent-guide-depth-5': { boxShadow: 'inset 2px 0 0 oklch(0.88 0.12 80 / 0.42)', backgroundColor: 'oklch(0.88 0.12 80 / 0.06)' },
      '.cm-color-preview-swatch': {
        display: 'inline-block',
        width: '0.8em',
        height: '0.8em',
        borderRadius: '3px',
        border: '1px solid transparent',
        marginRight: '0.35em',
        verticalAlign: '-0.08em',
        boxShadow: '0 0 0 1px oklch(1 0 0 / 0.08), 0 1px 2px oklch(0 0 0 / 0.24)',
      },
      '.cm-color-preview-token': {
        border: '1px solid transparent',
        borderRadius: '4px',
        padding: '0 0.22em',
        boxDecorationBreak: 'clone',
        WebkitBoxDecorationBreak: 'clone',
      },
      // Ligatures on the active line break CodeMirror's cursor-position math
      // (a merged glyph like → is wider than the sum of its characters).
      // Disabling them only on the line being edited keeps ligatures visible
      // everywhere else while the cursor stays accurate where it matters.
      '.cm-activeLine': {
        backgroundColor: 'oklch(from var(--foreground) l c h / 4%)',
        fontVariantLigatures: 'none',
        fontFeatureSettings: '"liga" 0, "calt" 0',
      },
      '.cm-activeLineGutter': { backgroundColor: 'transparent' },
      '.cm-strong': { fontWeight: 'bold' },
      '.cm-em': { fontStyle: 'italic' },
      '.cm-link': { color: 'var(--primary)', textDecoration: 'underline' },
      '.cm-url':  { color: 'color-mix(in oklch, var(--primary) 70%, var(--muted-foreground))' },
      '.cm-code': { fontFamily: 'monospace' },
      '.cm-strikethrough': { textDecoration: 'line-through' },

      // ── Wikilink autocomplete popup ──────────────────────────────────────
      '.cm-tooltip': {
        border: '1px solid color-mix(in oklch, var(--border) 60%, transparent)',
        borderRadius: '8px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        overflow: 'hidden',
        backdropFilter: 'blur(12px)',
        backgroundColor: 'color-mix(in oklch, var(--popover) 92%, transparent)',
      },
      '.cm-tooltip-autocomplete': {
        fontFamily: "'Geist Variable', system-ui, sans-serif",
      },
      '.cm-tooltip-autocomplete ul': {
        margin: '0',
        padding: '4px',
        minWidth: '220px',
        maxWidth: '340px',
        maxHeight: '260px',
      },
      '.cm-tooltip-autocomplete ul li': {
        display: 'flex',
        alignItems: 'center',
        padding: '5px 8px',
        borderRadius: '5px',
        cursor: 'pointer',
        lineHeight: '1.4',
        gap: '8px',
      },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        background: 'color-mix(in oklch, var(--primary) 15%, transparent)',
        color: 'var(--foreground)',
      },
      '.cm-completionLabel': {
        fontSize: '13px',
        color: 'var(--foreground)',
        flex: '1',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      '.cm-completionDetail': {
        fontSize: '11px',
        color: 'var(--muted-foreground)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        maxWidth: '120px',
        textAlign: 'right',
        fontStyle: 'normal',
      },
      '.cm-completionIcon': {
        display: 'none',
      },
    },
    { dark },
  );
}

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

function buildIndentDecorations(
  view: EditorView,
  showMarkers: boolean,
  showColors: boolean,
  indentStyle: 'spaces' | 'tabs',
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

function indentVisualization(
  showMarkers: boolean,
  showColors: boolean,
  indentStyle: 'spaces' | 'tabs',
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

function indentationConfig(indentStyle: 'spaces' | 'tabs', tabWidth: number) {
  return [
    EditorState.tabSize.of(tabWidth),
    indentUnit.of(indentStyle === 'tabs' ? '\t' : ' '.repeat(tabWidth)),
  ];
}

class ColorSwatchWidget extends WidgetType {
  constructor(private readonly color: string) {
    super();
  }

  eq(other: ColorSwatchWidget) {
    return this.color === other.color;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-color-preview-swatch';
    span.setAttribute('aria-hidden', 'true');
    span.style.backgroundColor = this.color;
    span.style.borderColor = this.color;
    return span;
  }
}

type ParsedColor = {
  css: string;
  r: number;
  g: number;
  b: number;
  a: number;
};

type ColorPreviewMatch = {
  from: number;
  to: number;
  parsed: ParsedColor;
};

const COLOR_FORMAT_REGEXES: Record<ColorPreviewFormat, RegExp> = {
  hex: /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g,
  rgb: /\brgba?\(\s*[^()\n]{1,96}\)/gi,
  hsl: /\bhsla?\(\s*[^()\n]{1,96}\)/gi,
  oklch: /\boklch\(\s*[^()\n]{1,96}\)/gi,
  oklab: /\boklab\(\s*[^()\n]{1,96}\)/gi,
};

function tryParseColor(value: string): ParsedColor | null {
  if (!CSS.supports('color', value)) return null;
  const probe = document.createElement('span');
  probe.style.color = value;
  const css = probe.style.color;
  if (!css) return null;
  const rgba = css.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgba) return { css, r: 127, g: 127, b: 127, a: 1 };
  const parts = rgba[1].split(',').map((part) => part.trim());
  if (parts.length < 3) return null;
  const [r, g, b] = parts.slice(0, 3).map((part) => Number.parseFloat(part));
  const a = parts[3] != null ? Number.parseFloat(parts[3]) : 1;
  if ([r, g, b, a].some((part) => Number.isNaN(part))) return null;
  return { css, r, g, b, a };
}

function channelToLinear(value: number) {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function getReadableForeground(parsed: ParsedColor) {
  const luminance =
    0.2126 * channelToLinear(parsed.r) +
    0.7152 * channelToLinear(parsed.g) +
    0.0722 * channelToLinear(parsed.b);
  return luminance > 0.5 ? 'rgba(12, 14, 20, 0.92)' : 'rgba(255, 255, 255, 0.96)';
}

function findColorPreviewMatches(
  text: string,
  lineFrom: number,
  enabledFormats: Record<ColorPreviewFormat, boolean>,
): ColorPreviewMatch[] {
  const candidates: ColorPreviewMatch[] = [];

  for (const [format, regex] of Object.entries(COLOR_FORMAT_REGEXES) as [ColorPreviewFormat, RegExp][]) {
    if (!enabledFormats[format]) continue;
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const index = match.index ?? -1;
      if (index < 0) continue;
      const parsed = tryParseColor(match[0]);
      if (!parsed) continue;
      candidates.push({ from: lineFrom + index, to: lineFrom + index + match[0].length, parsed });
    }
  }

  candidates.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from));
  const accepted: ColorPreviewMatch[] = [];
  let lastEnd = -1;
  for (const candidate of candidates) {
    if (candidate.from < lastEnd) continue;
    accepted.push(candidate);
    lastEnd = candidate.to;
  }
  return accepted;
}

function colorPreviewDecorations(
  view: EditorView,
  options: {
    enabled: boolean;
    showSwatch: boolean;
    tintText: boolean;
    formats: Record<ColorPreviewFormat, boolean>;
  },
): DecorationSet {
  if (!options.enabled || (!options.showSwatch && !options.tintText)) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let linePos = from;
    while (linePos <= to) {
      const line = view.state.doc.lineAt(linePos);
      const matches = findColorPreviewMatches(line.text, line.from, options.formats);
      for (const match of matches) {
        const fg = getReadableForeground(match.parsed);
        if (options.showSwatch) {
          builder.add(
            match.from,
            match.from,
            Decoration.widget({ widget: new ColorSwatchWidget(match.parsed.css), side: -1 }),
          );
        }
        if (options.tintText) {
          builder.add(
            match.from,
            match.to,
            Decoration.mark({
              class: 'cm-color-preview-token',
              attributes: {
                style: [
                  `background-color: rgba(${match.parsed.r}, ${match.parsed.g}, ${match.parsed.b}, 0.18)`,
                  `border-color: rgba(${match.parsed.r}, ${match.parsed.g}, ${match.parsed.b}, 0.42)`,
                  `color: ${fg}`,
                ].join('; '),
              },
            }),
          );
        }
      }
      linePos = line.to + 1;
    }
  }
  return builder.finish();
}

function createColorPreviewExtension(options: {
  enabled: boolean;
  showSwatch: boolean;
  tintText: boolean;
  formats: Record<ColorPreviewFormat, boolean>;
}) {
  if (!options.enabled || (!options.showSwatch && !options.tintText)) return [];

  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = colorPreviewDecorations(view, options);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.decorations = colorPreviewDecorations(update.view, options);
      }
    }
  }, {
    decorations: (value) => value.decorations,
  });
}

// ─── Syntax highlight style ──────────────────────────────────────────────────
// A dark-mode-first palette (One Dark-ish) that switches to a light variant
// when the app theme is 'light'. Placed in a Compartment so it hot-swaps
// alongside the editor theme without rebuilding the entire editor.

function buildHighlightStyle(dark: boolean) {
  // ── Palette ────────────────────────────────────────────────────────────────
  const p = dark ? {
    keyword:    '#c678dd', // purple   — class, function, const, …
    control:    '#e06c75', // rose     — return, import, export, if, …
    string:     '#98c379', // green
    number:     '#d19a66', // orange
    bool:       '#d19a66',
    nil:        '#d19a66',
    type:       '#e5c07b', // gold     — type names, classes
    fn:         '#61afef', // blue     — function names at call/def site
    prop:       '#abb2bf', // near-fg  — obj.property
    variable:   '#abb2bf', // near-fg
    definition: '#e06c75', // rose     — declared names (let x =, function foo)
    operator:   '#56b6c2', // cyan
    punctuation:'#abb2bf',
    comment:    '#5c6370', // muted gray
    meta:       '#5c6370',
    tag:        '#e06c75', // rose     — HTML/JSX tag names
    attr:       '#d19a66', // orange   — HTML attributes
    attrVal:    '#98c379', // green    — attribute values / strings
    invalid:    '#f44747', // red
    // markdown tokens
    heading:    '#e5c07b', // gold — h1-h6
    link:       '#61afef', // blue
    url:        '#56b6c2', // cyan
    code:       '#abb2bf',
  } : {
    keyword:    '#a626a4',
    control:    '#a626a4',
    string:     '#50a14f',
    number:     '#986801',
    bool:       '#986801',
    nil:        '#986801',
    type:       '#c18401',
    fn:         '#4078f2',
    prop:       '#383a42',
    variable:   '#383a42',
    definition: '#e45649',
    operator:   '#0184bc',
    punctuation:'#383a42',
    comment:    '#a0a1a7',
    meta:       '#a0a1a7',
    tag:        '#e45649',
    attr:       '#986801',
    attrVal:    '#50a14f',
    invalid:    '#ca1243',
    heading:    '#c18401',
    link:       '#4078f2',
    url:        '#0184bc',
    code:       '#383a42',
  };

  return HighlightStyle.define([
    // ── Comments ──────────────────────────────────────────────────────────
    { tag: tags.comment,                   color: p.comment,    fontStyle: 'italic' },
    { tag: tags.lineComment,               color: p.comment,    fontStyle: 'italic' },
    { tag: tags.blockComment,              color: p.comment,    fontStyle: 'italic' },
    { tag: tags.docComment,                color: p.comment,    fontStyle: 'italic' },

    // ── Keywords ──────────────────────────────────────────────────────────
    { tag: tags.keyword,                   color: p.keyword },
    { tag: tags.modifier,                  color: p.keyword },
    { tag: tags.controlKeyword,            color: p.control },
    { tag: tags.operatorKeyword,           color: p.control },
    { tag: tags.definitionKeyword,         color: p.keyword },
    { tag: tags.moduleKeyword,             color: p.control },
    { tag: tags.self,                      color: p.keyword },
    { tag: tags.namespace,                 color: p.type },

    // ── Literals ──────────────────────────────────────────────────────────
    { tag: tags.string,                    color: p.string },
    { tag: tags.special(tags.string),      color: p.string },
    { tag: tags.regexp,                    color: p.string },
    { tag: tags.escape,                    color: p.number },
    { tag: tags.number,                    color: p.number },
    { tag: tags.integer,                   color: p.number },
    { tag: tags.float,                     color: p.number },
    { tag: tags.bool,                      color: p.bool,      fontWeight: 'bold' },
    { tag: tags.null,                      color: p.nil,       fontWeight: 'bold' },

    // ── Types & classes ───────────────────────────────────────────────────
    { tag: tags.typeName,                  color: p.type },
    { tag: tags.typeOperator,              color: p.type },
    { tag: tags.className,                 color: p.type },
    { tag: tags.definition(tags.typeName), color: p.type,      fontWeight: 'bold' },

    // ── Names ─────────────────────────────────────────────────────────────
    { tag: tags.variableName,              color: p.variable },
    { tag: tags.definition(tags.variableName), color: p.definition },
    { tag: tags.function(tags.variableName),   color: p.fn },
    { tag: tags.function(tags.propertyName),   color: p.fn },
    { tag: tags.propertyName,             color: p.prop },
    { tag: tags.definition(tags.propertyName), color: p.definition },
    { tag: tags.function(tags.name),       color: p.fn },
    { tag: tags.labelName,                 color: p.variable },

    // ── Operators & punctuation ───────────────────────────────────────────
    { tag: tags.operator,                  color: p.operator },
    { tag: tags.arithmeticOperator,        color: p.operator },
    { tag: tags.logicOperator,             color: p.operator },
    { tag: tags.bitwiseOperator,           color: p.operator },
    { tag: tags.compareOperator,           color: p.operator },
    { tag: tags.updateOperator,            color: p.operator },
    { tag: tags.definitionOperator,        color: p.operator },
    { tag: tags.punctuation,               color: p.punctuation },
    { tag: tags.separator,                 color: p.punctuation },
    { tag: tags.bracket,                   color: p.punctuation },
    { tag: tags.squareBracket,             color: p.punctuation },
    { tag: tags.paren,                     color: p.punctuation },
    { tag: tags.brace,                     color: p.punctuation },
    { tag: tags.derefOperator,             color: p.operator },

    // ── HTML / JSX / XML ─────────────────────────────────────────────────
    { tag: tags.tagName,                   color: p.tag },
    { tag: tags.attributeName,             color: p.attr },
    { tag: tags.attributeValue,            color: p.attrVal },
    { tag: tags.angleBracket,              color: p.punctuation },
    { tag: tags.documentMeta,              color: p.meta },
    { tag: tags.processingInstruction,     color: p.meta },

    // ── Meta / special ────────────────────────────────────────────────────
    { tag: tags.meta,                      color: p.meta },
    { tag: tags.atom,                      color: p.bool },
    { tag: tags.unit,                      color: p.number },
    { tag: tags.constant(tags.name),       color: p.number },
    { tag: tags.color,                     color: p.number },
    { tag: tags.invalid,                   color: p.invalid,   textDecoration: 'underline wavy' },

    // ── Markdown-specific ─────────────────────────────────────────────────
    { tag: tags.heading,                   color: p.heading,   fontWeight: 'bold' },
    { tag: tags.heading1,                  color: p.heading,   fontWeight: 'bold' },
    { tag: tags.heading2,                  color: p.heading,   fontWeight: 'bold' },
    { tag: tags.heading3,                  color: p.heading,   fontWeight: 'bold' },
    { tag: tags.heading4,                  color: p.heading,   fontWeight: 'bold' },
    { tag: tags.heading5,                  color: p.heading,   fontWeight: 'bold' },
    { tag: tags.heading6,                  color: p.heading,   fontWeight: 'bold' },
    { tag: tags.link,                      color: p.link },
    { tag: tags.url,                       color: p.url },
    { tag: tags.emphasis,                  fontStyle: 'italic' },
    { tag: tags.strong,                    fontWeight: 'bold' },
    { tag: tags.strikethrough,             textDecoration: 'line-through' },
    { tag: tags.monospace,                 fontFamily: 'monospace', color: p.code },
    { tag: tags.content,                   color: dark ? '#abb2bf' : '#383a42' },
  ]);
}

// ─── Component ───────────────────────────────────────────────────────────────

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor({ content, onChange, onSave, relativePath }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const contentRef = useRef(content);
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);
    const themeCompartment = useRef(new Compartment());
    const highlightCompartment = useRef(new Compartment());
    const indentationCompartment = useRef(new Compartment());
    const indentVisualCompartment = useRef(new Compartment());
    const colorPreviewCompartment = useRef(new Compartment());
    const {
      theme,
      editorFont,
      fontSize,
      indentStyle,
      tabWidth,
      showIndentMarkers,
      showColoredIndents,
      showInlineColorPreviews,
      colorPreviewShowSwatch,
      colorPreviewTintText,
      colorPreviewFormats,
    } = useUiStore();
    const fontFamily = EDITOR_FONTS[editorFont].css;

    onChangeRef.current = onChange;
    onSaveRef.current = onSave;

    // ─── Swap theme/font/size/highlight when settings change ──────────────
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const isDark = theme !== 'light';
      view.dispatch({
        effects: [
          themeCompartment.current.reconfigure(buildCollabTheme(isDark, fontFamily, fontSize)),
          highlightCompartment.current.reconfigure(syntaxHighlighting(buildHighlightStyle(isDark))),
          indentationCompartment.current.reconfigure(indentationConfig(indentStyle, tabWidth)),
          indentVisualCompartment.current.reconfigure(
            indentVisualization(showIndentMarkers, showColoredIndents, indentStyle, tabWidth),
          ),
          colorPreviewCompartment.current.reconfigure(createColorPreviewExtension({
            enabled: showInlineColorPreviews,
            showSwatch: colorPreviewShowSwatch,
            tintText: colorPreviewTintText,
            formats: colorPreviewFormats,
          })),
        ],
      });
    }, [theme, fontFamily, fontSize, indentStyle, tabWidth, showIndentMarkers, showColoredIndents, showInlineColorPreviews, colorPreviewShowSwatch, colorPreviewTintText, colorPreviewFormats]);

    // ─── Expose imperative handle ─────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      insertAround(before, after, placeholder) {
        const view = viewRef.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        const selected = view.state.sliceDoc(from, to);
        const text = selected.length ? before + selected + after : before + placeholder + after;
        const selStart = from + before.length;
        const selEnd = selStart + (selected.length || placeholder.length);
        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: selStart, head: selEnd },
        });
        view.focus();
      },

      insertLine(prefix) {
        const view = viewRef.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        const line = view.state.doc.lineAt(from);
        const existing = view.state.sliceDoc(line.from, line.from + prefix.length);
        if (existing === prefix) {
          // Toggle off
          const nextAnchor = Math.max(line.from, from - prefix.length);
          const nextHead = Math.max(line.from, to - prefix.length);
          view.dispatch({
            changes: { from: line.from, to: line.from + prefix.length },
            selection: { anchor: nextAnchor, head: nextHead },
          });
        } else {
          view.dispatch({
            changes: { from: line.from, insert: prefix },
            selection: { anchor: from + prefix.length, head: to + prefix.length },
          });
        }
        view.focus();
      },

      insertSnippet(text) {
        const view = viewRef.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        const cursorMarker = '<cursor>';
        const markerIndex = text.indexOf(cursorMarker);
        const insertText = markerIndex >= 0 ? text.replace(cursorMarker, '') : text;
        const cursorPos = markerIndex >= 0 ? from + markerIndex : from + insertText.length;
        view.dispatch({
          changes: { from, to, insert: insertText },
          selection: { anchor: cursorPos },
        });
        view.focus();
      },

      replaceRange(from, to, text) {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
        view.focus();
      },

      getTableAtCursor() {
        const view = viewRef.current;
        if (!view) return null;
        return getTableRangeAtCursor(view);
      },
    }));

    // ─── Build editor ─────────────────────────────────────────────────────

    useEffect(() => {
      if (!containerRef.current) return;

      const wrapBold = (view: EditorView) => {
        const { from, to } = view.state.selection.main;
        const selected = view.state.sliceDoc(from, to) || 'bold text';
        const insertion = `**${selected}**`;
        view.dispatch({
          changes: { from, to, insert: insertion },
          selection: { anchor: from + 2, head: from + 2 + (to > from ? to - from : 9) },
        });
        return true;
      };

      const wrapItalic = (view: EditorView) => {
        const { from, to } = view.state.selection.main;
        const selected = view.state.sliceDoc(from, to) || 'italic text';
        const insertion = `_${selected}_`;
        view.dispatch({
          changes: { from, to, insert: insertion },
          selection: { anchor: from + 1, head: from + 1 + (to > from ? to - from : 11) },
        });
        return true;
      };

      // ── Link click handler ────────────────────────────────────────────────
      // Uses mousedown (not click) so we can return true and prevent CM6 from
      // placing the cursor — CM's own cursor-placement also runs on mousedown,
      // and domEventHandlers run before the view's internal handlers.
      // livePreview.ts stores the URL/path in data-url / data-path attributes
      // on the decoration span, so we can read them directly.
      // Stores are accessed via .getState() (not hooks) since this runs outside React.
      const linkClickHandler = EditorView.domEventHandlers({
        mousedown(event, _view) {
          if (event.button !== 0) return false; // left-click only
          const target = event.target as Element;
          const wikiEl = target.closest('.cm-lp-wikilink') as HTMLElement | null;
          const linkEl = target.closest('.cm-lp-link')     as HTMLElement | null;
          if (!wikiEl && !linkEl) return false;

          event.preventDefault();

          if (wikiEl) {
            const path = wikiEl.dataset.path;
            if (!path) return true;
            const stem  = path.split('/').pop()!.replace(/\.md$/i, '');
            const notes = useNoteIndexStore.getState().notes;
            const found = notes.find(n => {
              const s = n.relativePath.split('/').pop()!.replace(/\.md$/i, '');
              return s.toLowerCase() === stem.toLowerCase();
            });
            if (found) {
              useEditorStore.getState().openTab(found.relativePath, found.title ?? stem, 'note');
              useUiStore.getState().setActiveView('editor');
            }
            return true;
          }

          if (linkEl) {
            const url = linkEl.dataset.url;
            if (!url) return true;
            if (/^https?:\/\//i.test(url)) void openUrl(url);
            else void openPath(url);
            return true;
          }

          return false;
        },
      });

      const saveKeymap = keymap.of([
        { key: 'Mod-s', run: (view) => { onSaveRef.current(view.state.doc.toString()); return true; } },
        { key: 'Mod-b', run: wrapBold },
        { key: 'Mod-i', run: wrapItalic },
      ]);

      const updateListener = EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const val = update.state.doc.toString();
          contentRef.current = val;
          onChangeRef.current(val);
        }
      });

      const uiState = useUiStore.getState();
      const isDark = uiState.theme !== 'light';
      const initialFont = EDITOR_FONTS[uiState.editorFont].css;
      const initialFontSize = uiState.fontSize;
      const initialTheme = themeCompartment.current.of(buildCollabTheme(isDark, initialFont, initialFontSize));
      const initialHighlight = highlightCompartment.current.of(syntaxHighlighting(buildHighlightStyle(isDark)));
      const initialIndentation = indentationCompartment.current.of(
        indentationConfig(uiState.indentStyle, uiState.tabWidth),
      );
      const initialIndentVisuals = indentVisualCompartment.current.of(
        indentVisualization(
          uiState.showIndentMarkers,
          uiState.showColoredIndents,
          uiState.indentStyle,
          uiState.tabWidth,
        ),
      );
      const initialColorPreviews = colorPreviewCompartment.current.of(createColorPreviewExtension({
        enabled: uiState.showInlineColorPreviews,
        showSwatch: uiState.colorPreviewShowSwatch,
        tintText: uiState.colorPreviewTintText,
        formats: uiState.colorPreviewFormats,
      }));

      let state: EditorState;
      try {
        state = EditorState.create({
          doc: content,
          extensions: [
            lineNumbers(),
            highlightActiveLineGutter(),
            highlightActiveLine(),
            highlightSelectionMatches(),
            history(),
            drawSelection(),
            dropCursor(),
            bracketMatching(),
            closeBrackets(),
            indentOnInput(),
            // Custom theme-aware highlight style (in a Compartment so it hot-swaps)
            initialHighlight,
            // Default style as fallback for any token types not covered above
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            // GFM adds strikethrough, tables, task lists, autolinks
            // codeLanguages enables syntax highlighting inside fenced code blocks
            markdown({ base: markdownLanguage, extensions: GFM, codeLanguages: languages }),
            // Obsidian-style live preview: renders markdown inline while editing
            createLivePreviewPlugin(relativePath),
            autocompletion({
              override: [
                (context) => {
                  const before = context.matchBefore(/\[\[[^\]]*$/);
                  if (!before) return null;
                  const noteList = useNoteIndexStore.getState().notes;
                  const from = before.from + 2;
                  return {
                    from,
                    filter: false,
                    options: noteList.map((n) => {
                      const stem = n.relativePath.split('/').pop()!.replace(/\.md$/, '');
                      const folder = n.relativePath.includes('/')
                        ? n.relativePath.split('/').slice(0, -1).join('/')
                        : undefined;
                      return {
                        label: stem,
                        detail: folder,
                        type: 'text',
                        apply: (view, _completion, applyFrom, applyTo) => {
                          // closeBrackets() auto-inserts "]]" after the opening "[[".
                          // Consume them so we don't end up with [[title]]]] double-closing.
                          const afterCursor = view.state.sliceDoc(applyTo, applyTo + 2);
                          const insertTo = afterCursor === ']]' ? applyTo + 2 : applyTo;
                          const insert = `${stem}]]`;
                          view.dispatch({
                            changes: { from: applyFrom, to: insertTo, insert },
                            selection: { anchor: applyFrom + insert.length },
                          });
                        },
                      };
                    }),
                  };
                },
              ],
            }),
            keymap.of([
              ...defaultKeymap,
              ...historyKeymap,
              ...completionKeymap,
              ...closeBracketsKeymap,
              ...searchKeymap,
              indentWithTab,
            ]),
            linkClickHandler,
            saveKeymap,
            updateListener,
            initialTheme,
            initialIndentation,
            initialIndentVisuals,
            initialColorPreviews,
            EditorView.lineWrapping,
          ],
        });
      } catch (err) {
        console.error('[MarkdownEditor] EditorState.create failed:', err);
        // Fall back to a state without the live preview plugin
        state = EditorState.create({
          doc: content,
          extensions: [
            lineNumbers(), highlightActiveLine(), history(),
            markdown({ base: markdownLanguage, extensions: GFM }),
            keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
            saveKeymap, updateListener, initialTheme, initialIndentation, initialIndentVisuals, initialColorPreviews, EditorView.lineWrapping,
          ],
        });
      }

      let view: EditorView;
      try {
        view = new EditorView({ state, parent: containerRef.current });
      } catch (err) {
        console.error('[MarkdownEditor] EditorView construction failed:', err);
        throw err; // re-throw so EditorErrorBoundary can display it
      }
      viewRef.current = view;

      async function importDroppedImages(sourcePaths: string[], dropPos: number) {
        const vault = useVaultStore.getState().vault;
        if (!vault) return;

        const imagePaths = sourcePaths.filter(isImageLikePath);
        if (imagePaths.length === 0) return;

        try {
          const insertedPaths: string[] = [];
          for (const sourcePath of imagePaths) {
            const imported = await tauriCommands.importAssetIntoVault(vault.path, sourcePath, 'Pictures');
            insertedPaths.push(imported);
          }

          const insertText = insertedPaths.map(buildImageMarkdown).join('\n');
          view.dispatch({
            changes: { from: dropPos, to: dropPos, insert: insertText },
            selection: { anchor: dropPos + insertText.length },
          });
          view.focus();
        } catch (err) {
          toast.error('Failed to import image: ' + err);
        }
      }

      async function handleImageDrop(event: DragEvent) {
        const sourcePaths = getDroppedFilePaths(event);
        if (sourcePaths.length === 0) return;

        event.preventDefault();

        const dropPos = view.state.selection.main.from;
        await importDroppedImages(sourcePaths, dropPos);
      }

      const editorDom = view.dom;
      const webview = getCurrentWebview();
      const appWindow = getCurrentWindow();
      let unlistenWebviewDragDrop: (() => void) | null = null;
      let unlistenWindowDragDrop: (() => void) | null = null;
      let lastDropKey = '';
      let lastDropAt = 0;

      const handleTauriDrop = (paths: string[], clientX: number, clientY: number) => {
        const rect = editorDom.getBoundingClientRect();
        const insideEditor =
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom;

        if (!insideEditor) return;

        const dropPos = view.state.selection.main.from;
        const dropKey = `${paths.join('\n')}@@${Math.round(clientX)}:${Math.round(clientY)}`;
        const now = Date.now();
        if (dropKey === lastDropKey && now - lastDropAt < 300) return;
        lastDropKey = dropKey;
        lastDropAt = now;
        void importDroppedImages(paths, dropPos);
      };

      const attachDropListener = (
        subscribe: (handler: (event: {
          payload: { type: 'enter' | 'over' | 'drop' | 'leave'; paths?: string[]; position?: { x: number; y: number } };
        }) => void) => Promise<() => void>,
        setUnlisten: (unlisten: (() => void) | null) => void,
        label: string,
      ) => {
        void subscribe((event) => {
          if (event.payload.type !== 'drop' || !event.payload.paths || !event.payload.position) return;
          const clientX = event.payload.position.x / window.devicePixelRatio;
          const clientY = event.payload.position.y / window.devicePixelRatio;
          handleTauriDrop(event.payload.paths, clientX, clientY);
        }).then((unlisten) => {
          setUnlisten(unlisten);
        }).catch((err) => {
          console.error(`[MarkdownEditor] failed to attach ${label} drag-drop listener:`, err);
        });
      };

      attachDropListener(
        (handler) => webview.onDragDropEvent(handler),
        (unlisten) => { unlistenWebviewDragDrop = unlisten; },
        'webview',
      );
      attachDropListener(
        (handler) => appWindow.onDragDropEvent(handler),
        (unlisten) => { unlistenWindowDragDrop = unlisten; },
        'window',
      );

      const handleDrop = (event: DragEvent) => { void handleImageDrop(event); };
      editorDom.addEventListener('drop', handleDrop);
      view.focus();

      return () => {
        editorDom.removeEventListener('drop', handleDrop);
        unlistenWebviewDragDrop?.();
        unlistenWindowDragDrop?.();
        view.destroy();
        viewRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [relativePath]);

    // Sync external content changes (e.g. file reloaded from disk)
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current !== content && content !== contentRef.current) {
        try {
          view.dispatch({ changes: { from: 0, to: current.length, insert: content } });
        } catch (err) {
          console.error('[MarkdownEditor] dispatch failed:', err);
        }
        contentRef.current = content;
      }
    }, [content]);

    function cutSelection() {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      const text = view.state.sliceDoc(from, to);
      if (!text) return;
      navigator.clipboard.writeText(text);
      view.dispatch({ changes: { from, to, insert: '' } });
      view.focus();
    }

    function copySelection() {
      const view = viewRef.current;
      if (!view) return;
      const { from, to } = view.state.selection.main;
      navigator.clipboard.writeText(view.state.sliceDoc(from, to));
    }

    function pasteAtCursor() {
      const view = viewRef.current;
      if (!view) return;
      navigator.clipboard.readText().then(text => {
        const { from, to } = view.state.selection.main;
        view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
        view.focus();
      });
    }

    function selectAll() {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      view.focus();
    }

    // Absolutely fill the position:relative wrapper in NoteView.
    // Using position:absolute with inset:0 gives a deterministic height/width
    // without relying on CSS percentage resolution inside flex containers, which
    // is buggy in WebKitGTK (height:100% on a flex-1/flex-basis:0% child resolves
    // to 0, not the flex-grown size). The absolute element's getBoundingClientRect()
    // is always correct, so CodeMirror's posAtCoords() maps clicks accurately.
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={containerRef} className="absolute inset-0 cm-editor-container" />
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem className="text-xs" onSelect={cutSelection}>
            Cut <span className="ml-auto text-muted-foreground">⌘X</span>
          </ContextMenuItem>
          <ContextMenuItem className="text-xs" onSelect={copySelection}>
            Copy <span className="ml-auto text-muted-foreground">⌘C</span>
          </ContextMenuItem>
          <ContextMenuItem className="text-xs" onSelect={pasteAtCursor}>
            Paste <span className="ml-auto text-muted-foreground">⌘V</span>
          </ContextMenuItem>
          <ContextMenuItem className="text-xs" onSelect={selectAll}>
            Select all <span className="ml-auto text-muted-foreground">⌘A</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem className="text-xs" onSelect={() => {
            const view = viewRef.current; if (!view) return;
            const { from, to } = view.state.selection.main;
            const sel = view.state.sliceDoc(from, to) || 'bold text';
            view.dispatch({ changes: { from, to, insert: `**${sel}**` }, selection: { anchor: from + 2, head: from + 2 + sel.length } });
            view.focus();
          }}>
            Bold <span className="ml-auto text-muted-foreground">⌘B</span>
          </ContextMenuItem>
          <ContextMenuItem className="text-xs" onSelect={() => {
            const view = viewRef.current; if (!view) return;
            const { from, to } = view.state.selection.main;
            const sel = view.state.sliceDoc(from, to) || 'italic text';
            view.dispatch({ changes: { from, to, insert: `_${sel}_` }, selection: { anchor: from + 1, head: from + 1 + sel.length } });
            view.focus();
          }}>
            Italic <span className="ml-auto text-muted-foreground">⌘I</span>
          </ContextMenuItem>
          <ContextMenuItem className="text-xs" onSelect={() => {
            const view = viewRef.current; if (!view) return;
            const { from, to } = view.state.selection.main;
            const sel = view.state.sliceDoc(from, to) || 'strikethrough';
            view.dispatch({ changes: { from, to, insert: `~~${sel}~~` }, selection: { anchor: from + 2, head: from + 2 + sel.length } });
            view.focus();
          }}>
            Strikethrough
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem className="text-xs" onSelect={() => {
            window.dispatchEvent(new CustomEvent('tag:add-tags-line'));
          }}>
            Add tags line
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }
);
