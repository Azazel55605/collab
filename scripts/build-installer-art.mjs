#!/usr/bin/env node
// Renders every installer surface from its vector source.
//
// Run after editing any file under src-tauri/installer/ or src-tauri/dmg/:
//   pnpm installer:art
//
// Two different rules apply here:
//
//   macOS DMG  - the window is measured in points and the Finder scales the
//                image to it, so the PNG is rendered at 2x pixels and tagged
//                144 dpi to stay sharp on Retina. Tauri accepts png/jpg/gif,
//                so the classic 1x/2x .tiff is not an option.
//   Windows    - NSIS and WiX place bitmaps at fixed pixel sizes and accept
//                only BMP. Rendering above the target size does not help and a
//                mismatched size gets stretched, so these are rendered 1:1.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SURFACES = [
  {
    name: 'macOS DMG background',
    source: 'src-tauri/dmg/background.svg',
    output: 'src-tauri/dmg/background.png',
    width: 660,
    height: 400,
    scale: 2,
    format: 'png',
  },
  {
    name: 'NSIS header',
    source: 'src-tauri/installer/nsis-header.svg',
    output: 'src-tauri/installer/nsis-header.bmp',
    width: 150,
    height: 57,
    scale: 1,
    format: 'bmp',
  },
  {
    name: 'NSIS sidebar',
    source: 'src-tauri/installer/nsis-sidebar.svg',
    output: 'src-tauri/installer/nsis-sidebar.bmp',
    width: 164,
    height: 314,
    scale: 1,
    format: 'bmp',
  },
  {
    name: 'WiX banner',
    source: 'src-tauri/installer/wix-banner.svg',
    output: 'src-tauri/installer/wix-banner.bmp',
    width: 493,
    height: 58,
    scale: 1,
    format: 'bmp',
  },
  {
    name: 'WiX dialog',
    source: 'src-tauri/installer/wix-dialog.svg',
    output: 'src-tauri/installer/wix-dialog.bmp',
    width: 493,
    height: 312,
    scale: 1,
    format: 'bmp',
  },
];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : (result.stderr || '').trim();
    throw new Error(`${command} failed: ${detail}`);
  }
  return result.stdout;
}

export function renderSurface(surface) {
  const source = join(rootDir, surface.source);
  const output = join(rootDir, surface.output);
  if (!existsSync(source)) throw new Error(`Missing vector source: ${surface.source}`);

  const pixels = {
    width: surface.width * surface.scale,
    height: surface.height * surface.scale,
  };

  if (surface.format === 'bmp') {
    // rsvg-convert writes no BMP, so render a PNG beside the target and convert.
    const staging = `${output}.staging.png`;
    run('rsvg-convert', [
      '--width',
      String(pixels.width),
      '--height',
      String(pixels.height),
      '--background-color',
      'white',
      '--output',
      staging,
      source,
    ]);
    run('sips', ['-s', 'format', 'bmp', staging, '--out', output]);
    run('rm', ['-f', staging]);
    return { ...surface, pixels };
  }

  run('rsvg-convert', [
    '--width',
    String(pixels.width),
    '--height',
    String(pixels.height),
    '--output',
    output,
    source,
  ]);

  // Without a resolution tag the Finder treats the image as 72 dpi and draws it
  // at twice the intended size.
  const dpi = String(72 * surface.scale);
  run('sips', ['--setProperty', 'dpiWidth', dpi, '--setProperty', 'dpiHeight', dpi, output]);
  return { ...surface, pixels };
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  for (const surface of SURFACES) {
    const { pixels } = renderSurface(surface);
    console.log(`${surface.name}: ${surface.output} at ${pixels.width}x${pixels.height}px`);
  }
}
