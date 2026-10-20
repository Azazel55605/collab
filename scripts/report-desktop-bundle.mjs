import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { assetDigest } from './prepare-ocr-assets.mjs';

export const OCR_ASSETS = [
  'worker.min.js',
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-lstm.wasm',
  'eng.traineddata.gz',
];

async function inventory(directory, prefix = '') {
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) return inventory(directory, relative);
      return [{ file: relative, bytes: (await stat(path.join(directory, relative))).size }];
    }),
  );
  return files.flat();
}

export async function verifyOcrAssets(directory) {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(directory, 'ocr-assets/manifest.json'), 'utf8'),
    );
    if (
      manifest.version !== 1 ||
      !Array.isArray(manifest.assets) ||
      manifest.assets.length !== OCR_ASSETS.length
    )
      return false;
    if (!manifest.assets.every((asset) => asset && typeof asset.file === 'string')) return false;
    if (new Set(manifest.assets.map((asset) => asset.file)).size !== OCR_ASSETS.length)
      return false;
    for (const asset of manifest.assets) {
      if (!OCR_ASSETS.includes(asset.file)) return false;
      const actual = await assetDigest(path.join(directory, 'ocr-assets', asset.file));
      if (actual.bytes !== asset.bytes || actual.sha256 !== asset.sha256) return false;
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return false;
    throw error;
  }
}

export function enforceBundleBudgets(report, manifest, initialKeys, policy) {
  for (const [metric, maximum] of Object.entries(policy.maximums)) {
    if (
      !Number.isFinite(maximum) ||
      maximum < 0 ||
      !Number.isFinite(report[metric]) ||
      report[metric] > maximum
    )
      throw new Error(
        `Bundle budget exceeded: ${metric} = ${report[metric]} (maximum ${maximum}).`,
      );
  }
  for (const key of policy.deferredEntries) {
    if (!manifest[key]?.isDynamicEntry || initialKeys.has(key))
      throw new Error(`Required deferred entry missing or eager: ${key}`);
  }
  const fullHighlighter = Object.keys(manifest).find((key) =>
    key.endsWith('/highlight.js/es/index.js'),
  );
  if (!fullHighlighter || initialKeys.has(fullHighlighter))
    throw new Error('Uncommon syntax catalog must remain deferred.');
  if (!report.ocrIntegrityValid)
    throw new Error('Bundled offline English OCR assets are missing or corrupt.');
}

/** Static imports only: dynamic entries are paid for when their view is opened. */
export function initialBundleFiles(manifest) {
  const visited = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    const entry = manifest[key];
    if (!entry) throw new Error(`Missing manifest dependency: ${key}`);
    visited.add(key);
    for (const dependency of entry.imports ?? []) visit(dependency);
  }
  for (const [key, entry] of Object.entries(manifest)) if (entry.isEntry) visit(key);
  if (!visited.size) throw new Error('No application entry found in manifest.');
  return { keys: visited, files: [...new Set([...visited].map((key) => manifest[key].file))] };
}

export async function reportDesktopBundle(directory, assertLazy = false, policy) {
  const manifest = JSON.parse(await readFile(path.join(directory, '.vite/manifest.json'), 'utf8'));
  const initial = initialBundleFiles(manifest);
  const scripts = initial.files.filter((file) => file.endsWith('.js'));
  const data = await Promise.all(scripts.map((file) => readFile(path.join(directory, file))));
  const workers = (await readdir(path.join(directory, 'assets'))).filter((file) =>
    /^pdf\.worker-.*\.mjs$/.test(file),
  );
  if (assertLazy) {
    const views = Object.keys(manifest).filter((key) =>
      /^src\/views\/.*(?:View|Page)\.tsx$/.test(key),
    );
    if (!views.length) throw new Error('No deferred view entries found.');
    for (const key of [...views, 'src/lib/pdfRuntime.ts']) {
      if (!manifest[key]?.isDynamicEntry || initial.keys.has(key)) {
        throw new Error(`Startup eagerly loads a deferred view/runtime: ${key}`);
      }
    }
    if (workers.length !== 1)
      throw new Error(`Expected one PDF worker asset, found ${workers.length}.`);
  }
  const workerData = await Promise.all(
    workers.map((file) => readFile(path.join(directory, 'assets', file))),
  );
  const allFiles = await inventory(directory);
  const initialCss = [...new Set([...initial.keys].flatMap((key) => manifest[key].css ?? []))];
  const report = {
    initialJsFiles: scripts.length,
    initialJsBytes: data.reduce((total, bytes) => total + bytes.length, 0),
    initialJsGzipBytes: data.reduce((total, bytes) => total + gzipSync(bytes).length, 0),
    pdfWorkerFiles: workers.length,
    pdfWorkerBytes: workerData.reduce((total, bytes) => total + bytes.length, 0),
    initialCssBytes: (
      await Promise.all(initialCss.map((file) => stat(path.join(directory, file))))
    ).reduce((sum, file) => sum + file.size, 0),
    cssBytes: allFiles
      .filter(({ file }) => file.endsWith('.css'))
      .reduce((sum, file) => sum + file.bytes, 0),
    fontBytes: allFiles
      .filter(({ file }) => /\.(woff2?|ttf|otf)$/i.test(file))
      .reduce((sum, file) => sum + file.bytes, 0),
    legacyFontBytes: allFiles
      .filter(({ file }) => /\.(woff|ttf|otf)$/i.test(file))
      .reduce((sum, file) => sum + file.bytes, 0),
    ocrAssetBytes: allFiles
      .filter(({ file }) => file.startsWith(`ocr-assets${path.sep}`))
      .reduce((sum, file) => sum + file.bytes, 0),
    packagedBytes: allFiles.reduce((sum, file) => sum + file.bytes, 0),
    ocrIntegrityValid: await verifyOcrAssets(directory),
    largestChunks: allFiles
      .filter(({ file }) => file.startsWith(`assets${path.sep}`) && file.endsWith('.js'))
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 12)
      .map(({ file, bytes }) => ({
        file,
        bytes,
        initial: initial.files.includes(file.split(path.sep).join('/')),
      })),
  };
  if (policy) enforceBundleBudgets(report, manifest, initial.keys, policy);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2])
      throw new Error('Usage: node scripts/report-desktop-bundle.mjs <build-dir> [--assert-lazy]');
    const checkBudgets = process.argv.includes('--check-budgets');
    const policy = checkBudgets
      ? JSON.parse(
          await readFile(
            new URL('../docs/desktop/startup-bundle-budgets.json', import.meta.url),
            'utf8',
          ),
        )
      : undefined;
    console.log(
      JSON.stringify(
        await reportDesktopBundle(
          process.argv[2],
          checkBudgets || process.argv.includes('--assert-lazy'),
          policy,
        ),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
