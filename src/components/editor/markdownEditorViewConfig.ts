import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
  type CompletionSource,
} from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { GFM } from '@lezer/markdown';

import { asciiArrowLigatures, handleTabKey } from './indentationPlugins';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useVaultStore } from '../../store/vaultStore';
import { getVaultWikilinkAutocompleteItems } from '../../lib/vaultLinks';

export type MarkdownEditorCompartments = {
  theme: Compartment;
  highlight: Compartment;
  indentation: Compartment;
  indentVisual: Compartment;
  colorPreview: Compartment;
  contentAttrs: Compartment;
};

export type MarkdownEditorCompartmentExtensions = {
  themeExtension: Extension;
  highlightExtension: Extension;
  indentationExtension: Extension;
  indentVisualExtension: Extension;
  colorPreviewExtension: Extension;
  contentAttrsExtension: Extension;
};

type CreateMarkdownEditorStateOptions = {
  content: string;
  compartments: MarkdownEditorCompartments;
  compartmentExtensions: MarkdownEditorCompartmentExtensions;
  wikiAutocompleteOverride: readonly CompletionSource[];
  linkClickHandler: Extension;
  saveKeymap: Extension;
  updateListener: Extension;
  livePreviewExtension: Extension;
  slashCommandOverride: CompletionSource;
};

export function createMarkdownEditorCompartments(): MarkdownEditorCompartments {
  return {
    theme: new Compartment(),
    highlight: new Compartment(),
    indentation: new Compartment(),
    indentVisual: new Compartment(),
    colorPreview: new Compartment(),
    contentAttrs: new Compartment(),
  };
}

export function buildMarkdownEditorInitialExtensions(
  compartments: MarkdownEditorCompartments,
  extensions: MarkdownEditorCompartmentExtensions,
): Extension[] {
  return [
    compartments.theme.of(extensions.themeExtension),
    compartments.highlight.of(extensions.highlightExtension),
    compartments.indentation.of(extensions.indentationExtension),
    compartments.indentVisual.of(extensions.indentVisualExtension),
    compartments.colorPreview.of(extensions.colorPreviewExtension),
    compartments.contentAttrs.of(extensions.contentAttrsExtension),
  ];
}

export function buildMarkdownEditorReconfigureEffects(
  compartments: MarkdownEditorCompartments,
  extensions: MarkdownEditorCompartmentExtensions,
) {
  return [
    compartments.theme.reconfigure(extensions.themeExtension),
    compartments.highlight.reconfigure(extensions.highlightExtension),
    compartments.indentation.reconfigure(extensions.indentationExtension),
    compartments.indentVisual.reconfigure(extensions.indentVisualExtension),
    compartments.colorPreview.reconfigure(extensions.colorPreviewExtension),
    compartments.contentAttrs.reconfigure(extensions.contentAttrsExtension),
  ];
}

export function createMarkdownEditorState({
  content,
  compartments,
  compartmentExtensions,
  wikiAutocompleteOverride,
  linkClickHandler,
  saveKeymap,
  updateListener,
  livePreviewExtension,
  slashCommandOverride,
}: CreateMarkdownEditorStateOptions) {
  const initialCompartmentExtensions = buildMarkdownEditorInitialExtensions(compartments, compartmentExtensions);

  try {
    return EditorState.create({
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
        ...initialCompartmentExtensions,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        markdown({ base: markdownLanguage, extensions: GFM, codeLanguages: languages }),
        livePreviewExtension,
        autocompletion({
          override: [slashCommandOverride, ...wikiAutocompleteOverride],
        }),
        keymap.of([
          { key: 'Tab', run: handleTabKey, shift: indentLess },
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          ...closeBracketsKeymap,
          ...searchKeymap,
        ]),
        linkClickHandler,
        saveKeymap,
        updateListener,
        asciiArrowLigatures(),
        EditorView.lineWrapping,
      ],
    });
  } catch (err) {
    console.error('[MarkdownEditor] EditorState.create failed:', err);
    return EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        markdown({ base: markdownLanguage, extensions: GFM }),
        keymap.of([{ key: 'Tab', run: handleTabKey, shift: indentLess }, ...defaultKeymap, ...historyKeymap]),
        ...initialCompartmentExtensions,
        saveKeymap,
        updateListener,
        asciiArrowLigatures(),
        EditorView.lineWrapping,
      ],
    });
  }
}

export function createMarkdownWikiAutocompleteOverride() {
  return [
    ((context) => {
      const before = context.matchBefore(/\[\[[^\]]*$/);
      if (!before) return null;
      const noteList = useNoteIndexStore.getState().notes;
      const fileItems = getVaultWikilinkAutocompleteItems(useVaultStore.getState().fileTree)
        .filter((item) => item.insertText.includes('.') && !item.insertText.toLowerCase().endsWith('.md'));
      const from = before.from + 2;
      return {
        from,
        filter: false,
        options: [
          ...noteList.map((n) => {
            const stem = n.relativePath.split('/').pop()!.replace(/\.md$/, '');
            const folder = n.relativePath.includes('/')
              ? n.relativePath.split('/').slice(0, -1).join('/')
              : undefined;
            return {
              label: stem,
              detail: folder,
              type: 'text',
              apply: (view: EditorView, _completion: unknown, applyFrom: number, applyTo: number) => {
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
          ...fileItems.map((item) => ({
            label: item.label,
            detail: item.detail,
            type: item.type,
            apply: (view: EditorView, _completion: unknown, applyFrom: number, applyTo: number) => {
              const afterCursor = view.state.sliceDoc(applyTo, applyTo + 2);
              const insertTo = afterCursor === ']]' ? applyTo + 2 : applyTo;
              const insert = `${item.insertText}]]`;
              view.dispatch({
                changes: { from: applyFrom, to: insertTo, insert },
                selection: { anchor: applyFrom + insert.length },
              });
            },
          })),
        ],
      };
    }) satisfies CompletionSource,
  ] satisfies readonly CompletionSource[];
}
