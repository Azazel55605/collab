// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const vendor = new URL('vendor/tauri-plugin-updater/', root);
const provenance = JSON.parse(readFileSync(new URL('upstream-checksums.json', vendor), 'utf8')) as {
  version: string;
  files: Record<string, string>;
};

describe('updater ZIP security backport', () => {
  it('preserves the upstream runtime, build script, permissions and licenses', () => {
    for (const [path, expected] of Object.entries(provenance.files)) {
      const actual = createHash('sha256')
        .update(readFileSync(new URL(path, vendor)))
        .digest('hex');
      expect(actual, path).toBe(expected);
    }
  });

  it('keeps the matching updater while removing every vulnerable ZIP version', () => {
    const manifest = readFileSync(new URL('Cargo.toml', root), 'utf8');
    expect(manifest).toMatch(
      /\[patch\.crates-io\][\s\S]*tauri-plugin-updater = \{ path = "vendor\/tauri-plugin-updater" \}/,
    );
    const patched = readFileSync(new URL('Cargo.toml', vendor), 'utf8');
    expect(patched).toContain(`version = "${provenance.version}"`);
    expect(patched).toMatch(
      /\[target\.'cfg\(target_os = "windows"\)'\.dependencies\.zip\]\s+version = "9"/,
    );
    const blocks = readFileSync(new URL('Cargo.lock', root), 'utf8').split('[[package]]');
    const zip = blocks.filter((block) => /^\s*name = "zip"$/m.test(block));
    expect(zip).toHaveLength(1);
    expect(Number(zip[0].match(/^version = "(\d+)\./m)?.[1])).toBeGreaterThanOrEqual(9);
    const updater = blocks.filter((block) => /^\s*name = "tauri-plugin-updater"$/m.test(block));
    expect(updater).toHaveLength(1);
    expect(updater[0]).toContain(`version = "${provenance.version}"`);
    expect(updater[0]).not.toContain('source =');
  });
});
