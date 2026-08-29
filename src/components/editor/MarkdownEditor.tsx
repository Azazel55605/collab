import { forwardRef, useEffect, useRef, useState } from 'react';

import { createPortal } from 'react-dom';

import { syntaxHighlighting } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import 'katex/dist/katex.min.css';

import { dispatchEditorToolbarAction } from '../../lib/editorToolbarActions';
import type { EditorToolbarAction } from '../../lib/editorToolbarActions';
import { getMarkdownImageTarget } from '../../lib/noteAssets';
import { EDITOR_FONTS, useUiStore } from '../../store/uiStore';
import { PdfLinkPreviewPopover } from '../previews/PdfLinkPreviewPopover';
import { WebLinkPreviewPopover } from '../previews/WebLinkPreviewPopover';

import { type ParsedCodeBlockAtCursor, parseFenceInfoLanguage } from './codeBlockUtils';
import { createColorPreviewExtension } from './colorPreview';
import { handleEditorToolbarShortcutKeydown } from './editorToolbarShortcuts';
import { indentationConfig, indentVisualization } from './indentationPlugins';
import { createLivePreviewPlugin } from './livePreview';
import { MarkdownEditorContextMenu } from './MarkdownEditorContextMenu';
import { handleFormattingShortcutKeydown } from './MarkdownEditorContextMenu';
import { buildMarkdownEditorTheme, buildMarkdownHighlightStyle } from './markdownEditorTheme';
import {
  buildMarkdownEditorReconfigureEffects,
  createMarkdownEditorCompartments,
  createMarkdownEditorState,
  createMarkdownWikiAutocompleteOverride,
} from './markdownEditorViewConfig';
import { openNonVaultMarkdownPreviewLink } from './markdownLinkOpen';
import {
  handleMathBlockShortcutKeydown,
  MATH_SOLVER_ACTION_EVENT,
  type MathSolverActionDetail,
} from './mathBlockCommands';
import { solveMathInput } from './mathSolver';
import type { MathSolveMode } from './mathSolver';
import { createSlashCommandSource } from './slashCommands';
import { createSnippetSessionExtension } from './snippetEngine';
import { useMarkdownEditorHandle } from './useMarkdownEditorHandle';
import type { MarkdownEditorViewState } from './useMarkdownEditorHandle';
import { captureEditorViewState, restoreEditorViewState } from './useMarkdownEditorHandle';
import {
  handleEditorDocumentLinkMouseDown,
  useMarkdownEditorIntegrations,
} from './useMarkdownEditorIntegrations';

export interface MarkdownEditorHandle {
  /** Wrap selection with `before`/`after`; if no selection, insert `before + placeholder + after` and select placeholder. */
  insertAround: (before: string, after: string, placeholder: string) => void;
  /** Toggle a line prefix (e.g. `# `, `> `) on the current line. */
  insertLine: (prefix: string) => void;
  /** Insert arbitrary text at cursor / replace selection. Supports a single `<cursor>` marker. */
  insertSnippet: (text: string) => void;
  insertFootnote: () => void;
  focus: () => void;
  replaceRange: (from: number, to: number, text: string) => void;
  moveCursorToEnd: () => void;
  revealRange: (from: number, to?: number) => void;
  getViewState: () => MarkdownEditorViewState | null;
  restoreViewState: (editorViewState: MarkdownEditorViewState) => void;
  getTableAtCursor: () => { from: number; to: number; text: string } | null;
  getMathBlockAtCursor: () => { from: number; to: number; text: string } | null;
  getCodeBlockAtCursor: () => ParsedCodeBlockAtCursor | null;
}

interface MarkdownEditorProps {
  content: string;
  onChange: (value: string) => void;
  onSave: (value: string) => Promise<void>;
  relativePath: string;
  initialViewState?: MarkdownEditorViewState | null;
  onViewStateChange?: (editorViewState: MarkdownEditorViewState) => void;
  /** Render the note as non-editable (viewer access to a hosted vault). */
  readOnly?: boolean;
  /**
   * When set, a `y-codemirror.next` binding for a live hosted session. The Yjs
   * document drives the editor content, so the controlled `content` prop is only
   * used to seed the initial doc and the external-content sync is disabled.
   */
  collabExtension?: Extension | null;
}

type MathSolverActionState = MathSolverActionDetail;

const IMAGE_DROP_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'avif',
]);

function getFileExtension(path: string): string {
  const base = path.split(/[?#]/, 1)[0];
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function isImageLikePath(path: string): boolean {
  return IMAGE_DROP_EXTENSIONS.has(getFileExtension(path));
}

function buildImageMarkdown(relativePath: string, currentDocumentRelativePath: string): string {
  const fileName = relativePath.split('/').pop() ?? relativePath;
  const alt = fileName.replace(/\.[^.]+$/, '');
  const target = getMarkdownImageTarget(currentDocumentRelativePath, relativePath);
  return `![${alt}](${target})`;
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

function isMathDelimiterLine(text: string) {
  return text.trim() === '$$';
}

function getFenceLineMatch(text: string) {
  return text.match(/^(`{3,}|~{3,})(.*)$/);
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
  while (
    endLine < view.state.doc.lines &&
    isMarkdownTableLine(view.state.doc.line(endLine + 1).text)
  ) {
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

function getMathBlockRangeAtCursor(view: EditorView) {
  const { from } = view.state.selection.main;
  const currentLineNumber = view.state.doc.lineAt(from).number;
  const delimiterLines: number[] = [];

  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
    if (isMathDelimiterLine(view.state.doc.line(lineNumber).text)) {
      delimiterLines.push(lineNumber);
    }
  }

  for (let index = 0; index < delimiterLines.length - 1; index += 2) {
    const startLineNumber = delimiterLines[index];
    const endLineNumber = delimiterLines[index + 1];
    if (currentLineNumber < startLineNumber || currentLineNumber > endLineNumber) continue;

    const startLine = view.state.doc.line(startLineNumber);
    const endLine = view.state.doc.line(endLineNumber);
    const textStart =
      startLineNumber < endLineNumber
        ? view.state.doc.line(startLineNumber + 1).from
        : startLine.to;
    const textEnd =
      endLineNumber > startLineNumber ? view.state.doc.line(endLineNumber - 1).to : startLine.to;

    return {
      from: startLine.from,
      to: endLine.to,
      text: textStart <= textEnd ? view.state.sliceDoc(textStart, textEnd) : '',
    };
  }

  return null;
}

function getCodeBlockRangeAtCursor(view: EditorView): ParsedCodeBlockAtCursor | null {
  const { from } = view.state.selection.main;
  const currentLineNumber = view.state.doc.lineAt(from).number;
  let activeFence: { marker: string; lineNumber: number; language: string } | null = null;

  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
    const line = view.state.doc.line(lineNumber);
    const match = getFenceLineMatch(line.text);
    if (!match) continue;

    const marker = match[1];
    if (!activeFence) {
      activeFence = {
        marker,
        lineNumber,
        language: parseFenceInfoLanguage(match[2]),
      };
      continue;
    }

    const isClosingFence =
      marker[0] === activeFence.marker[0] &&
      marker.length >= activeFence.marker.length &&
      match[2].trim().length === 0;

    if (!isClosingFence) {
      activeFence = {
        marker,
        lineNumber,
        language: parseFenceInfoLanguage(match[2]),
      };
      continue;
    }

    if (currentLineNumber >= activeFence.lineNumber && currentLineNumber <= lineNumber) {
      const startLine = view.state.doc.line(activeFence.lineNumber);
      const endLine = view.state.doc.line(lineNumber);
      const textStart =
        activeFence.lineNumber < lineNumber
          ? view.state.doc.line(activeFence.lineNumber + 1).from
          : startLine.to;
      const textEnd =
        lineNumber > activeFence.lineNumber ? view.state.doc.line(lineNumber - 1).to : startLine.to;

      return {
        from: startLine.from,
        to: endLine.to,
        language: activeFence.language,
        code: textStart <= textEnd ? view.state.sliceDoc(textStart, textEnd) : '',
      };
    }

    activeFence = null;
  }

  return null;
}

function openToolbarAction(action: EditorToolbarAction) {
  return () => {
    dispatchEditorToolbarAction(action);
    return true;
  };
}

function buildMathSolverInsertion(
  mode: MathSolveMode,
  result: NonNullable<ReturnType<typeof solveMathInput>>,
) {
  if (result.kind === 'equation') return `\n\\Rightarrow ${result.latex}`;
  return mode === 'approximate' ? ` \\approx ${result.latex}` : ` = ${result.latex}`;
}

function MathSolverActionPopover({
  action,
  onSelect,
  onClose,
}: {
  action: MathSolverActionState | null;
  onSelect: (variable: string) => void;
  onClose: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const firstButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setActiveIndex(0);
    window.requestAnimationFrame(() => {
      firstButtonRef.current?.focus();
    });
  }, [action]);

  if (!action || !action.anchorRect || typeof document === 'undefined') return null;

  const width = 260;
  const left = Math.min(
    Math.max(12, action.anchorRect.left),
    Math.max(12, window.innerWidth - width - 12),
  );
  const top = Math.min(action.anchorRect.bottom + 10, window.innerHeight - 24 - 170);

  return createPortal(
    <div className="fixed z-[130] w-[260px]" style={{ left, top }}>
      <div
        className="overflow-hidden rounded-lg border border-border/60 bg-popover/96 p-2 shadow-2xl ring-1 ring-foreground/10 backdrop-blur-sm-webkit"
        role="dialog"
        aria-label={
          action.mode === 'approximate'
            ? 'Choose variable to approximate'
            : 'Choose variable to solve'
        }
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((index) => (index + 1) % action.variables.length);
            return;
          }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex(
              (index) => (index - 1 + action.variables.length) % action.variables.length,
            );
            return;
          }
          if (event.key === 'Home') {
            event.preventDefault();
            setActiveIndex(0);
            return;
          }
          if (event.key === 'End') {
            event.preventDefault();
            setActiveIndex(action.variables.length - 1);
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            onSelect(action.variables[activeIndex]);
          }
        }}
      >
        <div className="px-2 pb-1.5">
          <div className="text-xs font-medium text-foreground">
            {action.mode === 'approximate' ? 'Approximate for' : 'Solve for'}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{action.source}</div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {action.variables.map((variable, index) => (
            <button
              key={variable}
              ref={index === 0 ? firstButtonRef : undefined}
              type="button"
              tabIndex={index === activeIndex ? 0 : -1}
              aria-selected={index === activeIndex}
              onClick={() => onSelect(variable)}
              onFocus={() => setActiveIndex(index)}
              className={[
                'rounded-md border px-2.5 py-1.5 font-mono text-xs text-foreground transition-colors app-motion-fast',
                index === activeIndex
                  ? 'border-primary/65 bg-primary/16 ring-1 ring-primary/35'
                  : 'border-border/50 bg-background/55 hover:border-primary/50 hover:bg-primary/12',
              ].join(' ')}
            >
              {variable}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-2 w-full rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors app-motion-fast hover:bg-accent/35 hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      content,
      onChange,
      onSave,
      relativePath,
      initialViewState = null,
      onViewStateChange,
      readOnly = false,
      collabExtension = null,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [editorView, setEditorView] = useState<EditorView | null>(null);
    const [hoveredUrl, setHoveredUrl] = useState<string | null>(null);
    const [hoveredPdfRelativePath, setHoveredPdfRelativePath] = useState<string | null>(null);
    const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
    const [mathSolverAction, setMathSolverAction] = useState<MathSolverActionState | null>(null);
    const contentRef = useRef(content);
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);
    const onViewStateChangeRef = useRef(onViewStateChange);
    const compartmentsRef = useRef(createMarkdownEditorCompartments());
    const {
      theme,
      editorFont,
      editorFontSize,
      indentStyle,
      tabWidth,
      showIndentMarkers,
      showColoredIndents,
      showInlineColorPreviews,
      colorPreviewShowSwatch,
      colorPreviewTintText,
      colorPreviewFormats,
      webPreviewsEnabled,
      hoverWebLinkPreviewsEnabled,
    } = useUiStore();
    const fontFamily = EDITOR_FONTS[editorFont]?.css ?? EDITOR_FONTS.codingMono.css;

    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    onViewStateChangeRef.current = onViewStateChange;

    useMarkdownEditorIntegrations({
      view: editorView,
      webPreviewsEnabled,
      hoverWebLinkPreviewsEnabled,
      setHoveredUrl,
      setHoveredPdfRelativePath,
      setHoverRect,
      getDroppedFilePaths,
      isImageLikePath,
      buildImageMarkdown: (nextRelativePath) => buildImageMarkdown(nextRelativePath, relativePath),
      currentDocumentRelativePath: relativePath,
      readOnly,
    });

    // ─── Swap theme/font/size/highlight when settings change ──────────────
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const isDark = theme !== 'light';
      view.dispatch({
        effects: buildMarkdownEditorReconfigureEffects(compartmentsRef.current, {
          themeExtension: buildMarkdownEditorTheme(isDark, fontFamily, editorFontSize),
          highlightExtension: syntaxHighlighting(buildMarkdownHighlightStyle(isDark)),
          indentationExtension: indentationConfig(indentStyle, tabWidth),
          indentVisualExtension: indentVisualization(
            showIndentMarkers,
            showColoredIndents,
            indentStyle,
            tabWidth,
          ),
          colorPreviewExtension: createColorPreviewExtension({
            enabled: showInlineColorPreviews,
            showSwatch: colorPreviewShowSwatch,
            tintText: colorPreviewTintText,
            formats: colorPreviewFormats,
          }),
          contentAttrsExtension: [],
        }),
      });
    }, [
      theme,
      fontFamily,
      editorFontSize,
      indentStyle,
      tabWidth,
      showIndentMarkers,
      showColoredIndents,
      showInlineColorPreviews,
      colorPreviewShowSwatch,
      colorPreviewTintText,
      colorPreviewFormats,
    ]);

    useMarkdownEditorHandle({
      ref,
      viewRef,
      getTableAtCursor: getTableRangeAtCursor,
      getMathBlockAtCursor: getMathBlockRangeAtCursor,
      getCodeBlockAtCursor: getCodeBlockRangeAtCursor,
    });

    useEffect(() => {
      const handleDocumentKeydown = (event: KeyboardEvent) => {
        const view = viewRef.current;
        const container = containerRef.current;
        if (!view || !container) return;

        const active = document.activeElement;
        if (!(active instanceof Node) || !container.contains(active)) return;

        if (
          handleEditorToolbarShortcutKeydown(event) ||
          handleMathBlockShortcutKeydown(event, view) ||
          handleFormattingShortcutKeydown(event, view)
        ) {
          event.stopPropagation();
        }
      };

      document.addEventListener('keydown', handleDocumentKeydown, { capture: true });
      return () => {
        document.removeEventListener('keydown', handleDocumentKeydown, { capture: true });
      };
    }, []);

    useEffect(() => {
      const handleMathSolverAction = (event: Event) => {
        const detail = (event as CustomEvent<MathSolverActionDetail>).detail;
        if (!detail) return;
        setMathSolverAction(detail);
      };
      window.addEventListener(MATH_SOLVER_ACTION_EVENT, handleMathSolverAction);
      return () => window.removeEventListener(MATH_SOLVER_ACTION_EVENT, handleMathSolverAction);
    }, []);

    const applyMathSolverAction = (variable: string) => {
      const action = mathSolverAction;
      const view = viewRef.current;
      if (!action || !view) return;

      const result = solveMathInput(action.source, action.mode, variable);
      if (!result) {
        setMathSolverAction(null);
        view.focus();
        return;
      }

      const insert = buildMathSolverInsertion(action.mode, result);
      view.dispatch({
        changes: { from: action.range.to, insert },
        selection: { anchor: action.range.to + insert.length },
        scrollIntoView: true,
      });
      setMathSolverAction(null);
      view.focus();
    };

    // ─── Build editor ─────────────────────────────────────────────────────

    useEffect(() => {
      if (!containerRef.current) return;

      // ── Link click handler ────────────────────────────────────────────────
      // Uses mousedown (not click) so we can return true and prevent CM6 from
      // placing the cursor — CM's own cursor-placement also runs on mousedown,
      // and domEventHandlers run before the view's internal handlers.
      // livePreview.ts stores the URL/path in data-url / data-path attributes
      // on the decoration span, so we can read them directly.
      // Stores are accessed via .getState() (not hooks) since this runs outside React.
      const linkClickHandler = EditorView.domEventHandlers({
        mousedown(event: MouseEvent, _view: EditorView) {
          if (handleEditorDocumentLinkMouseDown(event, relativePath)) return true;
          if (event.button !== 0) return false;

          const target = event.target as Element;
          const linkEl = target.closest('.cm-lp-link') as HTMLElement | null;
          if (!linkEl) return false;

          event.preventDefault();
          if (linkEl) {
            const url = linkEl.dataset.url;
            if (!url) return true;
            return openNonVaultMarkdownPreviewLink(url);
          }

          return false;
        },
        keydown(event: KeyboardEvent, view: EditorView) {
          return (
            handleEditorToolbarShortcutKeydown(event) ||
            handleMathBlockShortcutKeydown(event, view) ||
            handleFormattingShortcutKeydown(event, view)
          );
        },
      });

      const saveKeymap = keymap.of([
        {
          key: 'Mod-s',
          run: (view: EditorView) => {
            onSaveRef.current(view.state.doc.toString());
            return true;
          },
        },
        { key: 'Mod-Alt-s', run: openToolbarAction('icon') },
        { key: 'Mod-Alt-t', run: openToolbarAction('table') },
        { key: 'Mod-Alt-l', run: openToolbarAction('link') },
        { key: 'Mod-Alt-i', run: openToolbarAction('image') },
        { key: 'Mod-Alt-k', run: openToolbarAction('taskList') },
        { key: 'Mod-Alt-m', run: openToolbarAction('math') },
        { key: 'Mod-Alt-c', run: openToolbarAction('code') },
        { key: 'Mod-Alt-n', run: openToolbarAction('snippets') },
      ]);

      const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) {
          const val = update.state.doc.toString();
          contentRef.current = val;
          onChangeRef.current(val);
        }
        if ((update.selectionSet || update.docChanged) && onViewStateChangeRef.current) {
          onViewStateChangeRef.current(captureEditorViewState(update.view));
        }
      });

      const uiState = useUiStore.getState();
      const isDark = uiState.theme !== 'light';
      const initialFont = EDITOR_FONTS[uiState.editorFont]?.css ?? EDITOR_FONTS.codingMono.css;
      const initialFontSize = uiState.editorFontSize;

      const state: EditorState = createMarkdownEditorState({
        content,
        compartments: compartmentsRef.current,
        compartmentExtensions: {
          themeExtension: buildMarkdownEditorTheme(isDark, initialFont, initialFontSize),
          highlightExtension: syntaxHighlighting(buildMarkdownHighlightStyle(isDark)),
          indentationExtension: indentationConfig(uiState.indentStyle, uiState.tabWidth),
          indentVisualExtension: indentVisualization(
            uiState.showIndentMarkers,
            uiState.showColoredIndents,
            uiState.indentStyle,
            uiState.tabWidth,
          ),
          colorPreviewExtension: createColorPreviewExtension({
            enabled: uiState.showInlineColorPreviews,
            showSwatch: uiState.colorPreviewShowSwatch,
            tintText: uiState.colorPreviewTintText,
            formats: uiState.colorPreviewFormats,
          }),
          contentAttrsExtension: [],
        },
        wikiAutocompleteOverride: createMarkdownWikiAutocompleteOverride(),
        slashCommandOverride: createSlashCommandSource(relativePath),
        linkClickHandler,
        saveKeymap,
        updateListener,
        livePreviewExtension: [
          createLivePreviewPlugin(relativePath),
          createSnippetSessionExtension(),
        ],
        readOnly,
        extraExtensions: collabExtension ?? [],
      });

      let view: EditorView;
      try {
        view = new EditorView({ state, parent: containerRef.current });
      } catch (err) {
        console.error('[MarkdownEditor] EditorView construction failed:', err);
        throw err; // re-throw so EditorErrorBoundary can display it
      }
      viewRef.current = view;
      setEditorView(view);
      view.focus();

      let frame: number | null = null;
      const emitViewState = () => {
        if (!onViewStateChangeRef.current) return;
        if (frame !== null) window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(() => {
          frame = null;
          if (!viewRef.current) return;
          onViewStateChangeRef.current?.(captureEditorViewState(viewRef.current));
        });
      };

      const handleScroll = () => {
        emitViewState();
      };

      view.scrollDOM.addEventListener('scroll', handleScroll, { passive: true });

      if (initialViewState) {
        window.requestAnimationFrame(() => {
          if (!viewRef.current) return;
          restoreEditorViewState(viewRef.current, initialViewState);
          emitViewState();
        });
      } else {
        emitViewState();
      }

      return () => {
        view.scrollDOM.removeEventListener('scroll', handleScroll);
        if (frame !== null) window.cancelAnimationFrame(frame);
        view.destroy();
        viewRef.current = null;
        setEditorView(null);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [relativePath, readOnly, collabExtension]);

    // Sync external content changes (e.g. file reloaded from disk). Disabled when
    // a live collaboration binding owns the document — Yjs drives content there
    // and a controlled overwrite would fight the CRDT.
    useEffect(() => {
      if (collabExtension) return;
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

    // Absolutely fill the position:relative wrapper in NoteView.
    // Using position:absolute with inset:0 gives a deterministic height/width
    // without relying on CSS percentage resolution inside flex containers, which
    // is buggy in WebKitGTK (height:100% on a flex-1/flex-basis:0% child resolves
    // to 0, not the flex-grown size). The absolute element's getBoundingClientRect()
    // is always correct, so CodeMirror's posAtCoords() maps clicks accurately.
    return (
      <>
        <MarkdownEditorContextMenu containerRef={containerRef} viewRef={viewRef} />
        <WebLinkPreviewPopover
          anchorRect={hoverRect}
          url={hoveredUrl}
          enabled={webPreviewsEnabled && hoverWebLinkPreviewsEnabled}
        />
        <PdfLinkPreviewPopover
          anchorRect={hoverRect}
          relativePath={hoveredPdfRelativePath}
          enabled={hoverWebLinkPreviewsEnabled}
        />
        <MathSolverActionPopover
          action={mathSolverAction}
          onSelect={applyMathSolverAction}
          onClose={() => {
            setMathSolverAction(null);
            viewRef.current?.focus();
          }}
        />
      </>
    );
  },
);
