import { foldable } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { expect, it } from 'vitest';

import { SOURCE_FILE_EXTENSIONS, sourceLanguageForPath } from '../../lib/sourceFiles';
import { getVaultDocumentTabType } from '../../lib/vaultLinks';

import { loadCodeLanguageSupport } from './codeBlockUtils';
import { sourceSymbols, sourceSyntaxDiagnostics } from './sourceEditorTools';

it.each(SOURCE_FILE_EXTENSIONS)(
  'routes .%s and loads its configured grammar',
  async (extension) => {
    const path = `Folder/file.${extension.toUpperCase()}`;
    const language = sourceLanguageForPath(path);
    expect(getVaultDocumentTabType(path)).toBe('source');
    expect(language).toBeDefined();
    const support = await loadCodeLanguageSupport(language!);
    if (extension === 'txt') expect(support).toBeNull();
    else expect(support?.language).toBeDefined();
  },
);

it.each([
  ['typescript', 'interface Job {\n title: string;\n}', 'Job'],
  ['python', 'def greet():\n    print("hi")\n    return\n', 'greet'],
  ['rust', 'fn task() {\n let value = 1;\n}', 'task'],
  ['go', 'package main\nfunc work() {\n return\n}', 'work'],
  ['java', 'class App {\n int test() { return 1; }\n}', 'App'],
  ['cpp', 'int example() {\n return 0;\n}', 'example'],
])('finds %s symbols with source positions and language folding', async (language, doc, symbol) => {
  const support = await loadCodeLanguageSupport(language);
  const state = EditorState.create({ doc, extensions: support! });
  const from = doc.indexOf(symbol);
  const start = state.doc.lineAt(from);
  expect(sourceSymbols(state)[0]).toMatchObject({ name: symbol, from, line: start.number });
  expect(foldable(state, start.from, start.to)).not.toBeNull();
});

it('surfaces syntax errors without changing the JSON draft', async () => {
  const support = await loadCodeLanguageSupport('json');
  const doc = '{ "draft":';
  const state = EditorState.create({ doc, extensions: support! });
  expect(sourceSyntaxDiagnostics({ state })).toEqual([
    expect.objectContaining({ severity: 'error', source: 'Syntax' }),
  ]);
  expect(state.doc.toString()).toBe(doc);
});
