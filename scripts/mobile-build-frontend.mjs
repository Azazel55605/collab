#!/usr/bin/env node
// Builds the Android companion frontend without spawning a nested pnpm process.
//
// Tauri runs this as `beforeBuildCommand` while the outer command is usually
// already `pnpm android:build:*`. Spawning `pnpm mobile:build` from there can
// hang in the package-manager layer before Vite/tsc ever run. Execute the local
// CLIs directly instead.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveNodeTool } from './tauri-command.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeOptions = process.env.NODE_OPTIONS ?? '';
const heapOption = '--max-old-space-size=8192';
const childEnv = {
  ...process.env,
  NODE_OPTIONS: nodeOptions.includes('--max-old-space-size')
    ? nodeOptions
    : `${nodeOptions} ${heapOption}`.trim(),
};

function run(toolName, args) {
  const tool = resolveNodeTool(toolName, rootDir);
  console.log(`Running ${toolName} ${args.join(' ')}...`);
  const result = spawnSync(tool.command, [...tool.prefixArgs, ...args], {
    cwd: rootDir,
    env: childEnv,
    shell: tool.shell,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('Building Android companion frontend...');
run('tsc', ['--noEmit', '-p', 'apps/mobile-android/tsconfig.json']);
run('vite', ['build', '--config', 'apps/mobile-android/vite.config.ts']);
