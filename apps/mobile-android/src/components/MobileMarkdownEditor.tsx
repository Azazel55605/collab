import { useEffect, useMemo, useRef } from 'react';

import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { HighlightStyle } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { GFM } from '@lezer/markdown';

import { createColorPreviewExtension } from '../../../../src/components/editor/colorPreview';
import {
  asciiArrowLigatures,
  handleTabKey,
  indentationConfig,
} from '../../../../src/components/editor/indentationPlugins';
import type { ThemePrefs } from '../lib/theme';

const MOBILE_EDITOR_FONT =
  "'Fira Code', 'JetBrains Mono', 'Pure Nerd Font', PureNerdFont, 'FiraCode Nerd Font', 'Symbols Nerd Font Mono', monospace";

function buildMobileEditorTheme(prefs: ThemePrefs): Extension {
  return EditorView.theme({
    '&': {
      height: '100%',
      minHeight: 'calc(100vh - 240px - var(--safe-bottom))',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)',
      backgroundColor: 'var(--surface)',
      color: 'var(--foreground)',
      overflow: 'hidden',
      fontSize: '0.9rem',
    },
    '&.cm-focused': {
      outline: 'none',
      borderColor: 'var(--primary)',
      boxShadow: '0 0 0 3px var(--glow)',
    },
    '.cm-scroller': {
      minHeight: 'calc(100vh - 240px - var(--safe-bottom))',
      overflow: 'auto',
      lineHeight: '1.55',
      fontFamily: MOBILE_EDITOR_FONT,
      fontVariantLigatures: 'contextual common-ligatures',
      fontFeatureSettings: '"liga" 1, "calt" 1',
    },
    '.cm-content': {
      minHeight: 'calc(100vh - 240px - var(--safe-bottom))',
      padding: '14px 14px 28px 8px',
      caretColor: 'var(--primary)',
      fontFamily: MOBILE_EDITOR_FONT,
      fontVariantLigatures: 'contextual common-ligatures',
      fontFeatureSettings: '"liga" 1, "calt" 1',
      tabSize: String(prefs.tabWidth),
    },
    '.cm-line': {
      fontFamily: MOBILE_EDITOR_FONT,
      fontVariantLigatures: 'contextual common-ligatures',
      fontFeatureSettings: '"liga" 1, "calt" 1',
    },
    '.cm-gutters': {
      border: '0',
      backgroundColor: 'color-mix(in oklch, var(--surface) 92%, var(--background))',
      color: 'var(--muted-foreground)',
      fontFamily: MOBILE_EDITOR_FONT,
      fontVariantLigatures: 'none',
      fontFeatureSettings: '"liga" 0, "calt" 0',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      minWidth: '2.2em',
      padding: '0 7px 0 5px',
      textAlign: 'right',
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: 'var(--primary)',
      borderLeftWidth: '2px',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      background: 'color-mix(in oklch, var(--primary) 24%, transparent)',
    },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in oklch, var(--foreground) 4%, transparent)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'color-mix(in oklch, var(--foreground) 4%, transparent)',
    },
    '.cm-color-preview-swatch': {
      appearance: 'none',
      display: 'inline-block',
      width: '0.8em',
      height: '0.8em',
      borderRadius: '3px',
      border: '1px solid transparent',
      marginRight: '0.35em',
      verticalAlign: '-0.08em',
      boxShadow: '0 0 0 1px oklch(1 0 0 / 0.10), 0 1px 2px oklch(0 0 0 / 0.22)',
      padding: '0',
    },
    '.cm-color-preview-token': {
      border: '1px solid transparent',
      borderRadius: '4px',
      padding: '0 0.22em',
      boxDecorationBreak: 'clone',
      WebkitBoxDecorationBreak: 'clone',
    },
    '.cm-ascii-arrow-ligature': {
      display: 'inline-block',
      width: '2ch',
      textAlign: 'center',
      pointerEvents: 'none',
    },
  });
}

function buildMobileHighlightStyle() {
  return HighlightStyle.define([
    { tag: tags.heading, color: '#e5c07b', fontWeight: '700' },
    { tag: tags.heading1, color: '#e5c07b', fontWeight: '700' },
    { tag: tags.heading2, color: '#e5c07b', fontWeight: '700' },
    { tag: tags.heading3, color: '#e5c07b', fontWeight: '700' },
    { tag: tags.heading4, color: '#e5c07b', fontWeight: '700' },
    { tag: tags.heading5, color: '#e5c07b', fontWeight: '700' },
    { tag: tags.heading6, color: '#e5c07b', fontWeight: '700' },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.link, color: 'var(--primary)', textDecoration: 'underline' },
    { tag: tags.url, color: 'color-mix(in oklch, var(--primary) 76%, var(--muted-foreground))' },
    { tag: tags.monospace, color: 'oklch(0.72 0.18 145)' },
    { tag: tags.processingInstruction, color: 'var(--muted-foreground)' },
  ]);
}

export function MobileMarkdownEditor({
  value,
  prefs,
  onChange,
  onSave,
  collabExtension = null,
}: {
  value: string;
  prefs: ThemePrefs;
  onChange: (value: string) => void;
  onSave: () => void;
  collabExtension?: Extension | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  valueRef.current = value;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  const extensions = useMemo(() => {
    const saveKeymap = keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          onSaveRef.current();
          return true;
        },
      },
    ]);
    const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
      if (!update.docChanged) return;
      const next = update.state.doc.toString();
      valueRef.current = next;
      onChangeRef.current(next);
    });

    return [
      lineNumbers(),
      history(),
      drawSelection(),
      dropCursor(),
      highlightActiveLine(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      buildMobileEditorTheme(prefs),
      syntaxHighlighting(buildMobileHighlightStyle()),
      markdown({ base: markdownLanguage, extensions: GFM }),
      ...indentationConfig(prefs.indentStyle, prefs.tabWidth),
      createColorPreviewExtension({
        enabled: prefs.showInlineColorPreviews,
        showSwatch: prefs.colorPreviewShowSwatch,
        tintText: prefs.colorPreviewTintText,
        formats: prefs.colorPreviewFormats,
      }),
      keymap.of([
        { key: 'Tab', run: handleTabKey, shift: indentLess },
        ...defaultKeymap,
        ...historyKeymap,
        ...closeBracketsKeymap,
      ]),
      saveKeymap,
      updateListener,
      asciiArrowLigatures(),
      collabExtension ?? [],
      EditorView.lineWrapping,
    ];
  }, [collabExtension, prefs]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: valueRef.current,
      extensions,
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [extensions]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (collabExtension) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [collabExtension, value]);

  return <div ref={hostRef} className="mobile-codemirror-editor" />;
}
