import { useEffect, useRef } from 'react';

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentMore } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Transaction,
} from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';

import { EDITOR_FONTS, useUiStore } from '../../store/uiStore';

import { loadCodeLanguageSupport } from './codeBlockUtils';
import { editorCompletionOptions } from './editorCompletionIcons';
import { editorCompletionTheme } from './editorCompletionTheme';
import { asciiArrowLigatures, indentationConfig, indentVisualization } from './indentationPlugins';
import { buildMarkdownHighlightStyle } from './markdownEditorTheme';

function buildCodeEditorTheme(dark: boolean, fontFamily: string, fontSize: number) {
  return EditorView.theme({
    '&': {
      height: '100%',
      fontSize: `${fontSize}px`,
      fontFamily,
      backgroundColor: 'var(--background)',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily:
        "ui-monospace, 'SFMono-Regular', 'JetBrains Mono', Menlo, Monaco, Consolas, monospace",
      lineHeight: '1.6',
    },
    '.cm-content': {
      minHeight: '100%',
      padding: '14px 16px',
      caretColor: 'var(--primary)',
    },
    '.cm-focused': {
      outline: 'none',
    },
    '.cm-cursor': {
      borderLeftColor: 'var(--primary)',
      borderLeftWidth: '2px',
    },
    '.cm-focused .cm-cursor': {
      borderLeftColor: 'var(--primary)',
      borderLeftWidth: '2px',
    },
    '&.cm-focused .cm-selectionBackground': {
      background: 'var(--editor-selection)',
    },
    '.cm-selectionBackground': {
      background: 'var(--editor-selection-dim)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--background)',
      borderRight: '1px solid var(--border)',
      color: 'var(--muted-foreground)',
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
    '.cm-indent-guide-depth-0': {
      boxShadow: 'inset 2px 0 0 oklch(from var(--primary) l c h / 0.38)',
      backgroundColor: 'oklch(from var(--primary) l c h / 0.06)',
    },
    '.cm-indent-guide-depth-1': {
      boxShadow: 'inset 2px 0 0 oklch(0.82 0.17 210 / 0.42)',
      backgroundColor: 'oklch(0.82 0.17 210 / 0.06)',
    },
    '.cm-indent-guide-depth-2': {
      boxShadow: 'inset 2px 0 0 oklch(0.86 0.15 160 / 0.42)',
      backgroundColor: 'oklch(0.86 0.15 160 / 0.06)',
    },
    '.cm-indent-guide-depth-3': {
      boxShadow: 'inset 2px 0 0 oklch(0.83 0.19 40 / 0.42)',
      backgroundColor: 'oklch(0.83 0.19 40 / 0.06)',
    },
    '.cm-indent-guide-depth-4': {
      boxShadow: 'inset 2px 0 0 oklch(0.80 0.20 320 / 0.42)',
      backgroundColor: 'oklch(0.80 0.20 320 / 0.06)',
    },
    '.cm-indent-guide-depth-5': {
      boxShadow: 'inset 2px 0 0 oklch(0.88 0.12 80 / 0.42)',
      backgroundColor: 'oklch(0.88 0.12 80 / 0.06)',
    },
    '.cm-activeLine': {
      backgroundColor: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.035)',
      fontVariantLigatures: 'none',
      fontFeatureSettings: '"liga" 0, "calt" 0',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
    },
    ...editorCompletionTheme,
  });
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

function handleCodeTabKey(view: EditorView) {
  if (view.state.readOnly) return false;
  if (view.state.selection.ranges.some((range) => !range.empty)) {
    return indentMore(view);
  }
  return insertIndentUnitAtCursor(view);
}

function sourceAccess(readOnly: boolean) {
  return readOnly
    ? [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ tabindex: '0' }),
      ]
    : [];
}

export function CodeEditorSurface({
  value,
  language,
  onChange,
  wrap = false,
  readOnly = false,
  onReady,
  onViewChange,
  extensions,
}: {
  value: string;
  language: string;
  onChange: (value: string) => void;
  wrap?: boolean;
  readOnly?: boolean;
  onReady?: (view: EditorView) => void;
  onViewChange?: (view: EditorView) => void;
  extensions?: Extension;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onReady, onViewChange });
  const accessCompartment = useRef(new Compartment());
  const toolsCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const themeCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());
  const indentationCompartment = useRef(new Compartment());
  const indentVisualCompartment = useRef(new Compartment());
  const {
    theme,
    editorFont,
    editorFontSize,
    indentStyle,
    tabWidth,
    showIndentMarkers,
    showColoredIndents,
  } = useUiStore();
  const fontFamily = EDITOR_FONTS[editorFont]?.css ?? EDITOR_FONTS.codingMono.css;

  const initial = useRef({
    value,
    theme,
    fontFamily,
    editorFontSize,
    indentStyle,
    tabWidth,
    showIndentMarkers,
    showColoredIndents,
    wrap,
    documentFocus: !!onReady,
    readOnly,
  });

  callbacks.current = { onChange, onReady, onViewChange };

  useEffect(() => {
    if (!containerRef.current) return;
    const {
      value,
      theme,
      fontFamily,
      editorFontSize,
      indentStyle,
      tabWidth,
      showIndentMarkers,
      showColoredIndents,
      wrap,
      documentFocus,
      readOnly,
    } = initial.current;
    const isDark = theme !== 'light';

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        autocompletion(editorCompletionOptions),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(buildMarkdownHighlightStyle(isDark)),
        themeCompartment.current.of(buildCodeEditorTheme(isDark, fontFamily, editorFontSize)),
        languageCompartment.current.of([]),
        indentationCompartment.current.of(indentationConfig(indentStyle, tabWidth)),
        indentVisualCompartment.current.of(
          indentVisualization(showIndentMarkers, showColoredIndents, indentStyle, tabWidth),
        ),
        asciiArrowLigatures(),
        wrapCompartment.current.of(wrap ? EditorView.lineWrapping : []),
        accessCompartment.current.of(sourceAccess(readOnly)),
        toolsCompartment.current.of([]),
        documentFocus ? EditorView.contentAttributes.of({ 'data-document-focus': '' }) : [],
        EditorView.domEventHandlers({
          scroll: (_event, view) => callbacks.current.onViewChange?.(view),
        }),
        EditorView.updateListener.of((update) => {
          if (
            update.docChanged &&
            !update.state.readOnly &&
            !update.transactions.some((tr) => tr.isUserEvent('input.remote'))
          ) {
            callbacks.current.onChange(update.state.doc.toString());
          }
          if (
            update.docChanged ||
            update.selectionSet ||
            syntaxTree(update.startState) !== syntaxTree(update.state)
          )
            callbacks.current.onViewChange?.(update.view);
        }),
        keymap.of([
          { key: 'Tab', run: handleCodeTabKey },
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          ...closeBracketsKeymap,
          ...searchKeymap,
        ]),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;
    callbacks.current.onReady?.(view);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const isDark = theme !== 'light';
    view.dispatch({
      effects: [
        themeCompartment.current.reconfigure(
          buildCodeEditorTheme(isDark, fontFamily, editorFontSize),
        ),
        indentationCompartment.current.reconfigure(indentationConfig(indentStyle, tabWidth)),
        indentVisualCompartment.current.reconfigure(
          indentVisualization(showIndentMarkers, showColoredIndents, indentStyle, tabWidth),
        ),
      ],
    });
  }, [
    theme,
    fontFamily,
    editorFontSize,
    indentStyle,
    tabWidth,
    showIndentMarkers,
    showColoredIndents,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    let cancelled = false;
    void loadCodeLanguageSupport(language).then((support) => {
      if (cancelled || !viewRef.current) return;
      viewRef.current.dispatch({
        effects: languageCompartment.current.reconfigure(support ? [support] : []),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: [Transaction.userEvent.of('input.remote'), Transaction.addToHistory.of(false)],
    });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: accessCompartment.current.reconfigure(sourceAccess(readOnly)),
    });
  }, [readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: toolsCompartment.current.reconfigure(extensions ?? []),
    });
  }, [extensions]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}
