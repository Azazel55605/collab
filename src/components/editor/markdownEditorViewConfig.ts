import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
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

import { getVaultWikilinkAutocompleteItems } from '../../lib/vaultLinks';
import { useVaultStore } from '../../store/vaultStore';

import { asciiArrowLigatures, handleTabKey } from './indentationPlugins';
import { createMarkdownSearchPanel } from './MarkdownSearchPanel';
import { createMathBlockShortcutExtension } from './mathBlockCommands';

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
  /** When true the document is not editable (viewer access to a hosted vault). */
  readOnly?: boolean;
  /**
   * Extra extensions appended last, e.g. the `y-codemirror.next` collaboration
   * binding when a live hosted session is active. Empty for the normal path.
   */
  extraExtensions?: Extension;
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
  readOnly = false,
  extraExtensions = [],
}: CreateMarkdownEditorStateOptions) {
  const initialCompartmentExtensions = buildMarkdownEditorInitialExtensions(
    compartments,
    compartmentExtensions,
  );
  // `readOnly` blocks document transactions; `editable.of(false)` also drops the
  // contenteditable affordance and caret so a viewer cannot type into the note.
  const readOnlyExtension = readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
    : [];

  try {
    return EditorState.create({
      doc: content,
      extensions: [
        ...readOnlyExtension,
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ createPanel: createMarkdownSearchPanel, top: true }),
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
        createMathBlockShortcutExtension(),
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
        extraExtensions,
      ],
    });
  } catch (err) {
    console.error('[MarkdownEditor] EditorState.create failed:', err);
    return EditorState.create({
      doc: content,
      extensions: [
        ...readOnlyExtension,
        lineNumbers(),
        highlightActiveLine(),
        search({ createPanel: createMarkdownSearchPanel, top: true }),
        history(),
        markdown({ base: markdownLanguage, extensions: GFM }),
        keymap.of([
          { key: 'Tab', run: handleTabKey, shift: indentLess },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        ...initialCompartmentExtensions,
        saveKeymap,
        updateListener,
        asciiArrowLigatures(),
        EditorView.lineWrapping,
        extraExtensions,
      ],
    });
  }
}

export function createMarkdownWikiAutocompleteOverride() {
  return [
    ((context) => {
      const before = context.matchBefore(/\[\[[^\]]*$/);
      if (!before) return null;
      const from = before.from + 2;
      const options = getVaultWikilinkAutocompleteItems(useVaultStore.getState().fileTree).map(
        (item) => ({
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
        }),
      );
      return {
        from,
        options,
      };
    }) satisfies CompletionSource,
  ] satisfies readonly CompletionSource[];
}
