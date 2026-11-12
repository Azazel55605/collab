import { useEffect, useRef } from 'react';

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { MariaSQL, MSSQL, sql, SQLite, type SQLNamespace } from '@codemirror/lang-sql';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';

import { useUiStore } from '../../store/uiStore';
import type { DatabaseEngine } from '../../types/database';
import { editorCompletionOptions } from '../editor/editorCompletionIcons';
import { editorCompletionTheme } from '../editor/editorCompletionTheme';
import { buildMarkdownHighlightStyle } from '../editor/markdownEditorTheme';

function buildSqlTheme(dark: boolean) {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'var(--background)',
        color: 'var(--foreground)',
      },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono,monospace)' },
      '.cm-gutters': {
        backgroundColor: 'var(--muted)',
        color: 'var(--muted-foreground)',
        border: 'none',
      },
      '.cm-content': { minHeight: '160px' },
      '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
      '.cm-tooltip': {
        backgroundColor: 'var(--popover)',
        color: 'var(--popover-foreground)',
        borderColor: 'var(--border)',
      },
      ...editorCompletionTheme,
      '&.cm-focused': { outline: 'none' },
    },
    { dark },
  );
}
export interface SqlEditorHandle {
  selection: () => { start_utf16: number; end_utf16: number } | undefined;
  focusRange: (from: number, to: number) => void;
}
export type SqlSchema = Record<string, Record<string, string[]>>;
function sqlEditorLanguage(schema: SqlSchema, engine: DatabaseEngine) {
  const maria = engine === 'maria_db';
  const quote = maria ? '`' : '"';
  const quoteIdentifier = (label: string) => quote + label.split(quote).join(quote + quote) + quote;
  const namespace = (
    label: string,
    type: 'namespace' | 'table',
    children: SQLNamespace,
  ): SQLNamespace => ({
    self: {
      label,
      type,
      apply: !maria && /^[a-z_][a-z_0-9]*$/.test(label) ? undefined : quoteIdentifier(label),
    },
    children,
  });
  return sql({
    dialect: engine === 'sqlite' ? SQLite : engine === 'maria_db' ? MariaSQL : MSSQL,
    schema: Object.fromEntries(
      Object.entries(schema).map(([name, tables]) => [
        name,
        namespace(
          name,
          'namespace',
          Object.fromEntries(
            Object.entries(tables).map(([table, columns]) => [
              table,
              namespace(
                table,
                'table',
                maria
                  ? columns.map((label) => ({
                      label,
                      type: 'property',
                      apply: quoteIdentifier(label),
                    }))
                  : columns,
              ),
            ]),
          ),
        ),
      ]),
    ),
  });
}

export default function SqlEditor({
  value,
  schema,
  engine = 'sql_server',
  onChange,
  onRun,
  onSave,
  handle,
  readOnly,
}: {
  value: string;
  readOnly: boolean;
  schema: SqlSchema;
  engine?: DatabaseEngine;
  onChange: (value: string) => void;
  onRun: () => void;
  onSave?: () => void;
  handle: React.RefObject<SqlEditorHandle | null>;
}) {
  const isDark = useUiStore((state) => state.theme !== 'light');
  const theme = useRef(new Compartment());
  const external = useRef(false);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onRun, onSave });
  callbacks.current = { onChange, onRun, onSave };
  const language = useRef(new Compartment());
  const editable = useRef(new Compartment());
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          editable.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          lineNumbers(),
          history(),
          bracketMatching(),
          closeBrackets(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          language.current.of(sqlEditorLanguage(schema, engine)),
          autocompletion(editorCompletionOptions),
          EditorView.contentAttributes.of({ 'aria-label': 'SQL editor', spellcheck: 'false' }),
          EditorState.transactionFilter.of((transaction) =>
            transaction.newDoc.length > 1024 * 1024 ? [] : transaction,
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !external.current)
              callbacks.current.onChange(update.state.doc.toString());
          }),
          Prec.high(
            keymap.of([
              {
                key: 'Mod-s',
                run: () => {
                  callbacks.current.onSave?.();
                  return true;
                },
              },
              {
                key: 'Mod-Enter',
                run: () => {
                  callbacks.current.onRun();
                  return true;
                },
              },
            ]),
          ),
          keymap.of([
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            ...closeBracketsKeymap,
            indentWithTab,
          ]),
          theme.current.of([
            buildSqlTheme(isDark),
            syntaxHighlighting(buildMarkdownHighlightStyle(isDark)),
          ]),
        ],
      }),
    });
    view.current = editor;
    handle.current = {
      selection: () => {
        const s = editor.state.selection.main;
        return s.empty ? undefined : { start_utf16: s.from, end_utf16: s.to };
      },
      focusRange: (from, to) => {
        editor.dispatch({
          selection: {
            anchor: Math.min(from, editor.state.doc.length),
            head: Math.min(to, editor.state.doc.length),
          },
          scrollIntoView: true,
        });
        editor.focus();
      },
    };
    return () => {
      editor.destroy();
      view.current = null;
      handle.current = null;
    };
    // Editor instances follow the owning tab; callbacks and schema reconfigure in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      external.current = true;
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
      external.current = false;
    }
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({
      effects: language.current.reconfigure(sqlEditorLanguage(schema, engine)),
    });
  }, [schema, engine]);
  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);
  useEffect(() => {
    view.current?.dispatch({
      effects: theme.current.reconfigure([
        buildSqlTheme(isDark),
        syntaxHighlighting(buildMarkdownHighlightStyle(isDark)),
      ]),
    });
  }, [isDark]);
  return <div ref={host} className="min-h-0 flex-1 overflow-hidden border-y border-border/50" />;
}
