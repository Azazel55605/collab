import { expect, it, vi } from 'vitest';

import type { NoteFile } from '../types/vault';

import { MAX_SOURCE_EDIT_BYTES } from './sourceFiles';
import { searchSourceFiles } from './sourceSearch';
import type { VaultClient } from './vaultClient';

function file(path: string, size = 32): NoteFile {
  return {
    name: path.split('/').pop()!,
    relativePath: path,
    extension: path.split('.').pop()!,
    isFolder: false,
    modifiedAt: 0,
    size,
  };
}

it('searches literal text in eligible source files and reports inaccessible or oversized files', async () => {
  const read = vi.fn(async (path: string) => {
    if (path === 'unreadable.rs') throw new Error('Access denied');
    return { content: '\uFEFFfirst\r\n  Value[3]\r\n\r\nvalue3', version: '1' };
  });
  const client = {
    listFiles: async () => [
      file('large.ts', MAX_SOURCE_EDIT_BYTES + 100),
      file('notes.md'),
      file('.hidden/private.py'),
      file('image.pdf-sidecar.json'),
      file('unreadable.rs'),
      file('scripts/run.SQL'),
    ],
    readSourceFile: read,
  } as unknown as VaultClient;

  await expect(
    searchSourceFiles(client, 'value[3]', new AbortController().signal),
  ).resolves.toEqual({
    results: [{ relativePath: 'scripts/run.SQL', line: 2, excerpt: '  Value[3]' }],
    partial: true,
  });
  expect(read.mock.calls).toEqual([['unreadable.rs'], ['scripts/run.SQL']]);
});

it('stops reading when the result cap is reached or a vault search is cancelled', async () => {
  const ctl = new AbortController();
  const read = vi.fn(async () => ({ content: 'test\n'.repeat(201), version: '1' }));
  const client = {
    listFiles: async () => [file('one.py'), file('two.py')],
    readSourceFile: read,
  } as unknown as VaultClient;

  const page = await searchSourceFiles(client, 'test', ctl.signal);
  expect(page.results).toHaveLength(100);
  expect(page.partial).toBe(true);
  expect(read).toHaveBeenCalledTimes(1);
  read.mockImplementationOnce(async () => {
    ctl.abort();
    return { content: 'test', version: '1' };
  });
  expect(await searchSourceFiles(client, 'test', ctl.signal)).toEqual({
    results: [],
    partial: false,
  });
  expect(read).toHaveBeenCalledTimes(2);
});
