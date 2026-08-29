#!/usr/bin/env node
// Starts the Vite dev server for `tauri dev` WITHOUT spawning a nested `pnpm`.
//
// Tauri's `beforeDevCommand` runs this instead of `pnpm dev`. Spawning `pnpm` as
// a child of the outer `pnpm tauri` process hangs in this environment: the inner
// pnpm blocks before it ever runs its script (no banner, no child, stuck in
// sigsuspend), so Vite never binds :1420 and Tauri loads a blank window. Running
// the frontend through `node` directly avoids that entirely. The `build` path in
// tauri-command.mjs already sidesteps nested pnpm the same way.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveNodeTool } from './tauri-command.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 1. Prepare OCR assets (the same pre-step the `pnpm dev` script runs).
const prep = spawnSync(process.execPath, [join(rootDir, 'scripts', 'prepare-ocr-assets.mjs')], {
  cwd: rootDir,
  env: process.env,
  stdio: 'inherit',
});
if (prep.error) {
  console.error(prep.error.message);
  process.exit(1);
}
if (prep.status !== 0) {
  process.exit(prep.status ?? 1);
}

// 2. Run Vite directly (node executes Vite's entry point; no nested pnpm).
const vite = resolveNodeTool('vite', rootDir);
const child = spawn(vite.command, [...vite.prefixArgs], {
  cwd: rootDir,
  env: process.env,
  stdio: 'inherit',
});

// Forward termination so stopping `tauri dev` cleanly shuts Vite down.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
