import { useEffect, useMemo, useRef, useState } from 'react';

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
} from '@codemirror/language';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { FileCode2, Sparkles } from 'lucide-react';

import { EDITOR_FONTS, useUiStore } from '../../store/uiStore';
import { Badge } from '../ui/badge';
import { FormDialog, FormField } from '../ui/form-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

import {
  CODE_BLOCK_LANGUAGE_OPTIONS,
  detectCodeLanguage,
  findLanguageOption,
  getLanguageLabel,
  loadCodeLanguageSupport,
} from './codeBlockUtils';
import { editorCompletionOptions } from './editorCompletionIcons';
import { editorCompletionTheme } from './editorCompletionTheme';
import { asciiArrowLigatures, indentationConfig, indentVisualization } from './indentationPlugins';
import { buildMarkdownHighlightStyle } from './markdownEditorTheme';

const PLAIN_TEXT_SELECT_VALUE = '__plain_text__';

interface CodeBlockEditorDialogProps {
  open: boolean;
  mode: 'insert' | 'edit';
  initialLanguage: string;
  initialCode: string;
  onOpenChange: (open: boolean) => void;
  onApply: (value: { language: string; code: string }) => void;
}

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
  if (view.state.selection.ranges.some((range) => !range.empty)) {
    return indentMore(view);
  }
  return insertIndentUnitAtCursor(view);
}

function CodeEditorSurface({
  value,
  language,
  onChange,
}: {
  value: string;
  language: string;
  onChange: (value: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const docRef = useRef(value);
  const onChangeRef = useRef(onChange);
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

  docRef.current = value;
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;
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
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const nextValue = update.state.doc.toString();
            docRef.current = nextValue;
            onChangeRef.current(nextValue);
          }
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
    });
  }, [value]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}

export function CodeBlockEditorDialog({
  open,
  mode,
  initialLanguage,
  initialCode,
  onOpenChange,
  onApply,
}: CodeBlockEditorDialogProps) {
  const [language, setLanguage] = useState(findLanguageOption(initialLanguage).value);
  const [code, setCode] = useState(initialCode);
  const [languageTouched, setLanguageTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    const normalized = findLanguageOption(initialLanguage).value;
    setLanguage(normalized);
    setCode(initialCode);
    setLanguageTouched(normalized.length > 0);
  }, [initialCode, initialLanguage, open]);

  const detected = useMemo(() => detectCodeLanguage(code), [code]);

  useEffect(() => {
    if (!open || languageTouched) return;
    if (!detected?.language) return;
    setLanguage(findLanguageOption(detected.language).value);
  }, [detected, languageTouched, open]);

  const applyDialog = () => {
    onApply({
      language,
      code,
    });
  };

  const currentLanguageLabel = getLanguageLabel(language);
  const detectedLabel = detected ? getLanguageLabel(detected.language) : '';
  const showDetectionHint = Boolean(
    detected &&
    detected.language &&
    findLanguageOption(detected.language).value !== findLanguageOption(language).value,
  );

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="l"
      className="h-[min(820px,calc(100vh-2rem))] sm:max-w-6xl"
      bodyClassName="gap-3"
      icon={<FileCode2 />}
      title={mode === 'edit' ? 'Edit code block' : 'Insert code block'}
      description="Choose the fence language and edit the code before it goes into the note."
      submitLabel={mode === 'edit' ? 'Update code block' : 'Insert code block'}
      onSubmit={applyDialog}
    >
      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Language" className="w-60">
          <Select
            value={language || PLAIN_TEXT_SELECT_VALUE}
            onValueChange={(value) => {
              setLanguage(value === PLAIN_TEXT_SELECT_VALUE ? '' : value);
              setLanguageTouched(true);
            }}
          >
            <SelectTrigger className="w-full" aria-label="Language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CODE_BLOCK_LANGUAGE_OPTIONS.map((option) => (
                <SelectItem
                  key={option.label || 'plain-text'}
                  value={option.value || PLAIN_TEXT_SELECT_VALUE}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        {detected ? (
          <div className="flex min-h-8 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant={showDetectionHint ? 'secondary' : 'outline'} className="gap-1">
              <Sparkles size={12} />
              {showDetectionHint ? `Detected ${detectedLabel}` : `Looks like ${detectedLabel}`}
            </Badge>
            <span>
              {showDetectionHint ? `Suggestion only: ${detected.reason}` : detected.reason}
            </span>
          </div>
        ) : (
          <Badge variant="outline" className="mb-1.5">
            {currentLanguageLabel}
          </Badge>
        )}
      </div>
      <div className="min-h-[360px] flex-1 overflow-hidden rounded-[10px] border border-border/60">
        <CodeEditorSurface value={code} language={language} onChange={setCode} />
      </div>
    </FormDialog>
  );
}
