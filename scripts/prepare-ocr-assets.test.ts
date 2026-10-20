import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { copyAssetIfChanged } from './prepare-ocr-assets.mjs';

it('leaves identical OCR assets untouched and repairs same-size corruption atomically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'collab-ocr-prepare-'));
  try {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'nested/asset');
    await writeFile(source, 'valid data');
    expect((await copyAssetIfChanged(source, destination)).changed).toBe(true);
    const before = (await stat(destination)).mtimeMs;
    expect((await copyAssetIfChanged(source, destination)).changed).toBe(false);
    expect((await stat(destination)).mtimeMs).toBe(before);
    await writeFile(destination, 'wrong data');
    expect((await copyAssetIfChanged(source, destination)).changed).toBe(true);
    expect(await readFile(destination, 'utf8')).toBe('valid data');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
