// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies: Record<string, string>;
};
const packages = Object.keys(manifest.dependencies).filter(
  (name) => name === '@tauri-apps/api' || name.startsWith('@tauri-apps/plugin-'),
);
const rustPackages = readFileSync(new URL('../Cargo.lock', import.meta.url), 'utf8')
  .split(/\r?\n\[\[package\]\]\r?\n/)
  .map((block) => ({
    name: block.match(/^name = "([^"]+)"$/m)?.[1],
    version: block.match(/^version = "([^"]+)"$/m)?.[1],
  }));

describe('Tauri dependency compatibility', () => {
  it.each(packages)('%s matches its Rust crate major/minor version', (name) => {
    // Check installed versions, as the packaging CLI does, rather than semver
    // ranges that might resolve to a different version after an update.
    const installed = JSON.parse(
      readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'),
    ) as { version: string };
    const rustName =
      name === '@tauri-apps/api' ? 'tauri' : name.replace('@tauri-apps/plugin-', 'tauri-plugin-');
    const versions = rustPackages.filter((pkg) => pkg.name === rustName);
    expect(versions, `Expected one locked version of ${rustName}`).toHaveLength(1);
    expect(
      installed.version.split('.').slice(0, 2).join('.'),
      `${name} ${installed.version} must match ${rustName} ${versions[0].version}`,
    ).toBe(versions[0].version?.split('.').slice(0, 2).join('.'));
  });
});
