import { useEffect, useMemo, useRef, useState } from 'react';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentMore } from '@codemirror/commands';
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { bracketMatching, defaultHighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap } from '@codemirror/search';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { useUiStore, EDITOR_FONTS } from '../../store/uiStore';
import { asciiArrowLigatures, buildHighlightStyle, indentationConfig, indentVisualization } from './MarkdownEditor';
import {
  CODE_BLOCK_LANGUAGE_OPTIONS,
  detectCodeLanguage,
  findLanguageOption,
  getLanguageLabel,
  loadCodeLanguageSupport,
} from './codeBlockUtils';
import { FileCode2, Sparkles } from 'lucide-react';

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
      fontFamily: "ui-monospace, 'SFMono-Regular', 'JetBrains Mono', Menlo, Monaco, Consolas, monospace",
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
    '.cm-indent-guide-depth-0': { boxShadow: 'inset 2px 0 0 oklch(from var(--primary) l c h / 0.38)', backgroundColor: 'oklch(from var(--primary) l c h / 0.06)' },
    '.cm-indent-guide-depth-1': { boxShadow: 'inset 2px 0 0 oklch(0.82 0.17 210 / 0.42)', backgroundColor: 'oklch(0.82 0.17 210 / 0.06)' },
    '.cm-indent-guide-depth-2': { boxShadow: 'inset 2px 0 0 oklch(0.86 0.15 160 / 0.42)', backgroundColor: 'oklch(0.86 0.15 160 / 0.06)' },
    '.cm-indent-guide-depth-3': { boxShadow: 'inset 2px 0 0 oklch(0.83 0.19 40 / 0.42)', backgroundColor: 'oklch(0.83 0.19 40 / 0.06)' },
    '.cm-indent-guide-depth-4': { boxShadow: 'inset 2px 0 0 oklch(0.80 0.20 320 / 0.42)', backgroundColor: 'oklch(0.80 0.20 320 / 0.06)' },
    '.cm-indent-guide-depth-5': { boxShadow: 'inset 2px 0 0 oklch(0.88 0.12 80 / 0.42)', backgroundColor: 'oklch(0.88 0.12 80 / 0.06)' },
    '.cm-activeLine': {
      backgroundColor: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.035)',
      fontVariantLigatures: 'none',
      fontFeatureSettings: '"liga" 0, "calt" 0',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
    },
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
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(buildHighlightStyle(isDark)),
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
        themeCompartment.current.reconfigure(buildCodeEditorTheme(isDark, fontFamily, editorFontSize)),
        indentationCompartment.current.reconfigure(indentationConfig(indentStyle, tabWidth)),
        indentVisualCompartment.current.reconfigure(
          indentVisualization(showIndentMarkers, showColoredIndents, indentStyle, tabWidth),
        ),
      ],
    });
  }, [theme, fontFamily, editorFontSize, indentStyle, tabWidth, showIndentMarkers, showColoredIndents]);

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-6xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="border-b border-border/40 px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <FileCode2 size={16} />
            {mode === 'edit' ? 'Edit code block' : 'Insert code block'}
          </DialogTitle>
          <DialogDescription>
            Choose a fence language and edit the code in a dedicated editor before inserting it into the note.
          </DialogDescription>
        </DialogHeader>

        <div className="border-b border-border/30 px-5 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[220px]">
              <div className="mb-1 text-xs font-medium text-muted-foreground">Language</div>
              <Select
                value={language || PLAIN_TEXT_SELECT_VALUE}
                onValueChange={(value) => {
                  setLanguage(value === PLAIN_TEXT_SELECT_VALUE ? '' : value);
                  setLanguageTouched(true);
                }}
              >
                <SelectTrigger className="w-full">
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
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-5">
              <Badge variant="outline">{currentLanguageLabel}</Badge>
              {detected ? (
                <Badge variant={showDetectionHint ? 'secondary' : 'outline'} className="gap-1">
                  <Sparkles size={12} />
                  {showDetectionHint ? `Detected ${detectedLabel}` : `Looks like ${detectedLabel}`}
                </Badge>
              ) : null}
              {showDetectionHint ? (
                <span className="text-xs text-muted-foreground">
                  Suggestion only: {detected?.reason}
                </span>
              ) : detected ? (
                <span className="text-xs text-muted-foreground">
                  Detection: {detected.reason}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="h-[68vh] min-h-[420px] overflow-hidden">
          <CodeEditorSurface value={code} language={language} onChange={setCode} />
        </div>

        <DialogFooter className="border-t border-border/30 px-5 py-4 gap-2 sm:justify-between">
          <div className="text-xs text-muted-foreground">
            Auto-detection suggests a language, but you stay in control of the final fence.
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={applyDialog}>
              {mode === 'edit' ? 'Update code block' : 'Insert code block'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
