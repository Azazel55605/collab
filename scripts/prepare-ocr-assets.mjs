import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, 'public', 'ocr-assets');

const assets = [
  [
    join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js'),
    join(publicDir, 'worker.min.js'),
  ],
  [
    join(root, 'node_modules', 'tesseract.js-core', 'tesseract-core-lstm.wasm.js'),
    join(publicDir, 'tesseract-core-lstm.wasm.js'),
  ],
  [
    // The .wasm.js glue fetches this binary at runtime; without it the WASM
    // engine fails to initialize and OCR falls back to the native CLI (which
    // returns plain text only, with no word bounding boxes for the overlay).
    join(root, 'node_modules', 'tesseract.js-core', 'tesseract-core-lstm.wasm'),
    join(publicDir, 'tesseract-core-lstm.wasm'),
  ],
  [
    join(root, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0', 'eng.traineddata.gz'),
    join(publicDir, 'eng.traineddata.gz'),
  ],
];

export async function assetDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return { bytes: (await stat(file)).size, sha256: hash.digest('hex') };
}

/** Avoid rewriting 17 MiB on every dev start, but detect same-size corruption. */
export async function copyAssetIfChanged(from, to) {
  const expected = await assetDigest(from);
  try {
    const existing = await assetDigest(to);
    if (existing.bytes === expected.bytes && existing.sha256 === expected.sha256)
      return { ...expected, changed: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(to), { recursive: true });
  const staged = `${to}.${randomUUID()}.tmp`;
  try {
    await copyFile(from, staged);
    const copied = await assetDigest(staged);
    if (copied.sha256 !== expected.sha256)
      throw new Error('OCR source asset changed during preparation. Retry the build.');
    await rename(staged, to);
  } finally {
    await rm(staged, { force: true });
  }
  return { ...expected, changed: true };
}

export async function prepareOcrAssets() {
  await mkdir(publicDir, { recursive: true });
  const records = await Promise.all(
    assets.map(async ([from, to]) => {
      const { bytes, sha256 } = await copyAssetIfChanged(from, to);
      return { file: to.slice(publicDir.length + 1), bytes, sha256 };
    }),
  );
  const content = JSON.stringify({ version: 1, assets: records }, null, 2) + '\n';
  const manifest = join(publicDir, 'manifest.json');
  let previous;
  try {
    previous = await readFile(manifest, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous !== content) {
    const staged = `${manifest}.${randomUUID()}.tmp`;
    try {
      await writeFile(staged, content);
      await rename(staged, manifest);
    } finally {
      await rm(staged, { force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await prepareOcrAssets();
