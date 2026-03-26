import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { useUiStore } from '../../store/uiStore';
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
import { livePreviewPlugin } from './livePreview';
import 'katex/dist/katex.min.css';

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

function buildCollabTheme(dark: boolean) {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: '14px',
        fontFamily: "'Geist Mono Variable', 'Geist Variable', monospace",
        // Match --background (not --card) so the editor blends seamlessly with the app.
        backgroundColor: 'var(--background)',
      },
      '.cm-scroller': { overflow: 'auto', lineHeight: '1.7' },
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
      '.cm-activeLine': { backgroundColor: 'oklch(from var(--foreground) l c h / 4%)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent' },
      '.cm-strong': { fontWeight: 'bold' },
      '.cm-em': { fontStyle: 'italic' },
      '.cm-link': { color: 'var(--primary)', textDecoration: 'underline' },
      '.cm-url': { color: 'var(--muted-foreground)' },
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
    const { theme } = useUiStore();

    onChangeRef.current = onChange;
    onSaveRef.current = onSave;

    // ─── Swap theme when the app theme changes ─────────────────────────────
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const isDark = theme !== 'light';
      view.dispatch({
        effects: themeCompartment.current.reconfigure(buildCollabTheme(isDark)),
      });
    }, [theme]);

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

      const isDark = useUiStore.getState().theme !== 'light';
      const initialTheme = themeCompartment.current.of(buildCollabTheme(isDark));

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
            markdown({ base: markdownLanguage, extensions: GFM }),
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

    // Absolutely fill the position:relative wrapper in NoteView.
    // Using position:absolute with inset:0 gives a deterministic height/width
    // without relying on CSS percentage resolution inside flex containers, which
    // is buggy in WebKitGTK (height:100% on a flex-1/flex-basis:0% child resolves
    // to 0, not the flex-grown size). The absolute element's getBoundingClientRect()
    // is always correct, so CodeMirror's posAtCoords() maps clicks accurately.
    return (
      <div ref={containerRef} className="absolute inset-0 cm-editor-container" />
    );
  }
);
