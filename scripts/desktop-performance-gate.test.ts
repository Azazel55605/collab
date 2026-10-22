// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import budgets from './desktop-performance-budgets.json';
import { checkReports } from './desktop-performance-gate.mjs';

function report() {
  const native = { enabled: true, rssBytes: 10000000, peakRssBytes: 20000000 };
  return {
    schemaVersion: 1,
    appVersion: '0.8.7',
    platform: 'linux-webkitgtk',
    scenarios: [
      ...Array.from({ length: 5 }, () => ({
        name: 'cold-start',
        durationMs: 1000,
        nativeStart: native,
        nativeEnd: { ...native, runId: crypto.randomUUID() },
        events: [],
      })),
      ...Array.from({ length: 5 }, () => ({
        name: 'warm-start',
        durationMs: 500,
        nativeStart: native,
        nativeEnd: { ...native, runId: crypto.randomUUID() },
        events: [],
      })),
      {
        name: 'idle',
        durationMs: 60000,
        nativeStart: native,
        nativeEnd: { ...native, runId: crypto.randomUUID() },
        events: [],
      },
      {
        name: 'interaction',
        durationMs: 10000,
        nativeStart: native,
        nativeEnd: { ...native, runId: crypto.randomUUID() },
        events: Array.from({ length: 100 }, () => ({ kind: 'interaction', millis: 30 })),
      },
      {
        name: 'open-close-soak',
        durationMs: 120000,
        nativeStart: native,
        nativeEnd: { ...native, runId: crypto.randomUUID() },
        events: [],
      },
    ],
  };
}
it('requires actual platform evidence, complete scenarios and bounded measured costs', () => {
  const fixture = report();
  expect(checkReports([fixture], budgets, ['linux-webkitgtk'])).toEqual([]);
  expect(checkReports([fixture], budgets)).toContain('windows-webview2: missing native report');
  fixture.scenarios[0].nativeEnd = { enabled: true, rssBytes: 1, peakRssBytes: 2 ** 31 };
  expect(checkReports([fixture], budgets, ['linux-webkitgtk']).join()).toContain('RSS budget');
  fixture.scenarios[1].durationMs = 10000;
  expect(checkReports([fixture], budgets, ['linux-webkitgtk']).join()).toContain('startup p95');
});
it('rejects missing native memory and truncated/insufficient telemetry', () => {
  const fixture = report();
  Object.assign(fixture.scenarios[0], { nativeEnd: { enabled: false }, droppedEvents: 1 });
  expect(checkReports([fixture], budgets, ['linux-webkitgtk']).join()).toContain(
    'incomplete native evidence',
  );
  expect(checkReports([fixture], budgets, ['linux-webkitgtk']).join()).toContain('overflowed');
  fixture.scenarios = fixture.scenarios.filter((s) => s.name !== 'interaction');
  expect(checkReports([fixture], budgets, ['linux-webkitgtk']).join()).toContain(
    'missing interaction',
  );
});

it('release qualification rejects reports from another app version', () => {
  expect(checkReports([report()], budgets, ['linux-webkitgtk'], '0.8.8').join()).toContain(
    'does not match release',
  );
});

it('explicit qualification fails clearly when a release has no committed reports', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'collab-performance-missing-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./desktop-performance-gate.mjs', import.meta.url)),
        '--release-tag',
        'desktop-v0.8.8',
      ],
      { cwd, encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing native performance evidence');
    expect(result.stderr).toContain('desktop-v0.8.8');
    expect(result.stderr).not.toContain('ENOENT');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
