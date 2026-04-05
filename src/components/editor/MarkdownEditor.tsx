import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { useUiStore, EDITOR_FONTS } from '../../store/uiStore';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  dropCursor,
  highlightActiveLineGutter,
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
  syntaxHighlighting,
  defaultHighlightStyle,
} from '@codemirror/language';
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
import { livePreviewPlugin } from './livePreview';
import { openUrl, openPath } from '@tauri-apps/plugin-opener';
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
  /** Insert arbitrary text at cursor / replace selection. */
  insertSnippet: (text: string) => void;
}

interface MarkdownEditorProps {
  content: string;
  onChange: (value: string) => void;
  onSave: (value: string) => Promise<void>;
  relativePath: string;
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

// ─── Component ───────────────────────────────────────────────────────────────

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor({ content, onChange, onSave, relativePath }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const contentRef = useRef(content);
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);
    const themeCompartment = useRef(new Compartment());
    const { theme, editorFont, fontSize } = useUiStore();
    const fontFamily = EDITOR_FONTS[editorFont].css;

    onChangeRef.current = onChange;
    onSaveRef.current = onSave;

    // ─── Swap theme/font/size when settings change ─────────────────────────
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const isDark = theme !== 'light';
      view.dispatch({
        effects: themeCompartment.current.reconfigure(buildCollabTheme(isDark, fontFamily, fontSize)),
      });
    }, [theme, fontFamily, fontSize]);

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
        const { from } = view.state.selection.main;
        const line = view.state.doc.lineAt(from);
        const existing = view.state.sliceDoc(line.from, line.from + prefix.length);
        if (existing === prefix) {
          // Toggle off
          view.dispatch({ changes: { from: line.from, to: line.from + prefix.length } });
        } else {
          view.dispatch({ changes: { from: line.from, insert: prefix } });
        }
        view.focus();
      },

      insertSnippet(text) {
        const view = viewRef.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({ changes: { from, to, insert: text } });
        view.focus();
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
            syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
            // GFM adds strikethrough, tables, task lists, autolinks
            // codeLanguages enables syntax highlighting inside fenced code blocks
            markdown({ base: markdownLanguage, extensions: GFM, codeLanguages: languages }),
            // Obsidian-style live preview: renders markdown inline while editing
            livePreviewPlugin,
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
            saveKeymap, updateListener, initialTheme, EditorView.lineWrapping,
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
      view.focus();

      return () => {
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
        </ContextMenuContent>
      </ContextMenu>
    );
  }
);
