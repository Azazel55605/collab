// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

const vendor = new URL('../vendor/sqlx-sqlite/', import.meta.url);
const provenance = JSON.parse(readFileSync(new URL('upstream-checksums.json', vendor), 'utf8')) as {
  files: Record<string, string>;
};

it('preserves SQLx driver source and licenses with only the SQLite dependency requirement changed', () => {
  for (const [path, expected] of Object.entries(provenance.files)) {
    let content = readFileSync(new URL(path, vendor));
    if (path === 'Cargo.toml') {
      const patched = content.toString('utf8');
      const fixed = '[dependencies.libsqlite3-sys]\nversion = ">=0.39.0, <0.40.0"';
      expect(patched).toContain(fixed);
      content = Buffer.from(
        patched.replace(fixed, '[dependencies.libsqlite3-sys]\nversion = ">=0.30.1, <0.38.0"'),
      );
    }
    expect(createHash('sha256').update(content).digest('hex'), path).toBe(expected);
  }
});
