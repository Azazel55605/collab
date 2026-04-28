import { forwardRef, useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { useUiStore, EDITOR_FONTS } from '../../store/uiStore';
import {
  EditorView,
  keymap,
  type ViewUpdate,
} from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { createLivePreviewPlugin } from './livePreview';
import { openUrl, openPath } from '@tauri-apps/plugin-opener';
import 'katex/dist/katex.min.css';
import { parseFenceInfoLanguage, type ParsedCodeBlockAtCursor } from './codeBlockUtils';
import { dispatchEditorToolbarAction } from '../../lib/editorToolbarActions';
import { WebLinkPreviewPopover } from '../previews/WebLinkPreviewPopover';
import { createColorPreviewExtension } from './colorPreview';
import { createSnippetSessionExtension } from './snippetEngine';
import {
  indentationConfig,
  indentVisualization,
} from './indentationPlugins';
import {
  buildMarkdownEditorReconfigureEffects,
  createMarkdownEditorCompartments,
  createMarkdownEditorState,
  createMarkdownWikiAutocompleteOverride,
} from './markdownEditorViewConfig';
import { createSlashCommandSource } from './slashCommands';
import { buildMarkdownEditorTheme, buildMarkdownHighlightStyle } from './markdownEditorTheme';
import { handleEditorDocumentLinkMouseDown, useMarkdownEditorIntegrations } from './useMarkdownEditorIntegrations';
import { useMarkdownEditorHandle } from './useMarkdownEditorHandle';
import { MarkdownEditorContextMenu } from './MarkdownEditorContextMenu';
import { getFrontmatterField } from '../../lib/frontmatter';

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
  getTableAtCursor: () => { from: number; to: number; text: string } | null;
  getMathBlockAtCursor: () => { from: number; to: number; text: string } | null;
  getCodeBlockAtCursor: () => ParsedCodeBlockAtCursor | null;
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
    const textStart = startLineNumber < endLineNumber ? view.state.doc.line(startLineNumber + 1).from : startLine.to;
    const textEnd = endLineNumber > startLineNumber ? view.state.doc.line(endLineNumber - 1).to : startLine.to;

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

    const isClosingFence = (
      marker[0] === activeFence.marker[0] &&
      marker.length >= activeFence.marker.length &&
      match[2].trim().length === 0
    );

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
      const textStart = activeFence.lineNumber < lineNumber ? view.state.doc.line(activeFence.lineNumber + 1).from : startLine.to;
      const textEnd = lineNumber > activeFence.lineNumber ? view.state.doc.line(lineNumber - 1).to : startLine.to;

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

function openToolbarAction(action: 'icon' | 'table' | 'link' | 'image' | 'taskList' | 'math' | 'code' | 'snippets') {
  return () => {
    dispatchEditorToolbarAction(action);
    return true;
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor({ content, onChange, onSave, relativePath }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const [editorView, setEditorView] = useState<EditorView | null>(null);
    const [hoveredUrl, setHoveredUrl] = useState<string | null>(null);
    const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
    const contentRef = useRef(content);
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);
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
      spellcheckEnabled,
      spellcheckLanguage,
      respectNoteSpellcheckLanguage,
    } = useUiStore();
    const fontFamily = EDITOR_FONTS[editorFont]?.css ?? EDITOR_FONTS.codingMono.css;
    const noteSpellcheckLanguage = respectNoteSpellcheckLanguage
      ? getFrontmatterField(content, 'spellcheckLanguage') ?? getFrontmatterField(content, 'language')
      : null;
    const effectiveSpellcheckLanguage = (noteSpellcheckLanguage ?? spellcheckLanguage ?? 'en').trim() || 'en';

    onChangeRef.current = onChange;
    onSaveRef.current = onSave;

    useMarkdownEditorIntegrations({
      view: editorView,
      webPreviewsEnabled,
      hoverWebLinkPreviewsEnabled,
      setHoveredUrl,
      setHoverRect,
      getDroppedFilePaths,
      isImageLikePath,
      buildImageMarkdown,
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
          indentVisualExtension: indentVisualization(showIndentMarkers, showColoredIndents, indentStyle, tabWidth),
          colorPreviewExtension: createColorPreviewExtension({
            enabled: showInlineColorPreviews,
            showSwatch: colorPreviewShowSwatch,
            tintText: colorPreviewTintText,
            formats: colorPreviewFormats,
          }),
          contentAttrsExtension: EditorView.contentAttributes.of({
            spellcheck: spellcheckEnabled ? 'true' : 'false',
            lang: effectiveSpellcheckLanguage,
          }),
        }),
      });
    }, [theme, fontFamily, editorFontSize, indentStyle, tabWidth, showIndentMarkers, showColoredIndents, showInlineColorPreviews, colorPreviewShowSwatch, colorPreviewTintText, colorPreviewFormats, spellcheckEnabled, effectiveSpellcheckLanguage]);

    useMarkdownEditorHandle({
      ref,
      viewRef,
      getTableAtCursor: getTableRangeAtCursor,
      getMathBlockAtCursor: getMathBlockRangeAtCursor,
      getCodeBlockAtCursor: getCodeBlockRangeAtCursor,
    });

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

      const wrapStrikethrough = (view: EditorView) => {
        const { from, to } = view.state.selection.main;
        const selected = view.state.sliceDoc(from, to) || 'strikethrough';
        const insertion = `~~${selected}~~`;
        view.dispatch({
          changes: { from, to, insert: insertion },
          selection: { anchor: from + 2, head: from + 2 + (to > from ? to - from : 13) },
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
            if (/^https?:\/\//i.test(url)) void openUrl(url);
            else void openPath(url);
            return true;
          }

          return false;
        },
      });

      const saveKeymap = keymap.of([
        { key: 'Mod-s', run: (view: EditorView) => { onSaveRef.current(view.state.doc.toString()); return true; } },
        { key: 'Mod-b', run: wrapBold },
        { key: 'Mod-i', run: wrapItalic },
        { key: 'Mod-Shift-x', run: wrapStrikethrough },
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
          contentAttrsExtension: EditorView.contentAttributes.of({
            spellcheck: uiState.spellcheckEnabled ? 'true' : 'false',
            lang: effectiveSpellcheckLanguage,
          }),
        },
        wikiAutocompleteOverride: createMarkdownWikiAutocompleteOverride(),
        slashCommandOverride: createSlashCommandSource(),
        linkClickHandler,
        saveKeymap,
        updateListener,
        livePreviewExtension: [createLivePreviewPlugin(relativePath), createSnippetSessionExtension()],
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

      return () => {
        view.destroy();
        viewRef.current = null;
        setEditorView(null);
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
      </>
    );
  }
);
