#!/usr/bin/env node
import { spawn } from 'node:child_process';

import { resolveNodeTool } from './tauri-command.mjs';

const vite = resolveNodeTool('vite');
const child = spawn(
  vite.command,
  [...vite.prefixArgs, '--config', 'apps/mobile-android/vite.config.ts'],
  {
    env: process.env,
    shell: vite.shell,
    stdio: 'inherit',
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
