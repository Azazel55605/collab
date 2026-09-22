#!/usr/bin/env node
// Renders the DMG installer background from its vector source.
//
// The DMG window is 660x400 points. macOS scales the background image to that
// window, so the PNG is rendered at 2x pixels and tagged 144 dpi: the Finder
// maps pixels to points through the resolution tag, which is what keeps the
// artwork sharp on Retina displays. Tauri only accepts png/jpg/gif, so the
// classic 1x/2x .tiff trick is not available here.
//
// Run after editing background.svg:
//   node scripts/build-dmg-background.mjs
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(rootDir, 'src-tauri/dmg/background.svg');
const output = join(rootDir, 'src-tauri/dmg/background.png');

export const WINDOW_POINTS = { width: 660, height: 400 };
export const SCALE = 2;
export const DPI = 72 * SCALE;

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : (result.stderr || '').trim();
    throw new Error(`${command} failed: ${detail}`);
  }
  return result.stdout;
}

export function renderBackground() {
  if (!existsSync(source)) throw new Error(`Missing vector source: ${source}`);

  run('rsvg-convert', [
    '--width', String(WINDOW_POINTS.width * SCALE),
    '--height', String(WINDOW_POINTS.height * SCALE),
    '--output', output,
    source,
  ]);

  // rsvg-convert writes no resolution tag; without it the Finder treats the
  // image as 72 dpi and renders it at twice the intended size.
  run('sips', ['--setProperty', 'dpiWidth', String(DPI), '--setProperty', 'dpiHeight', String(DPI), output]);

  return output;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const written = renderBackground();
  console.log(`Wrote ${written} at ${WINDOW_POINTS.width * SCALE}x${WINDOW_POINTS.height * SCALE}px, ${DPI} dpi.`);
}
