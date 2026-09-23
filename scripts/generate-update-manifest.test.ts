import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildManifest } from './generate-update-manifest.mjs';

/**
 * Lays out an artifacts directory the way actions/download-artifact does:
 * one subdirectory per artifact name, each holding that job's bundle files.
 */
function writeArtifacts(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'collab-manifest-'));
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return root;
}

describe('update manifest generation', () => {
  it('publishes a separate entry for each macOS architecture', () => {
    const artifactsDir = writeArtifacts({
      'mac-intel/collab-mac-intel.app.tar.gz': 'intel bundle',
      'mac-intel/collab-mac-intel.app.tar.gz.sig': 'intel-signature\n',
      'mac-apple-silicon/collab-mac-apple-silicon.app.tar.gz': 'arm bundle',
      'mac-apple-silicon/collab-mac-apple-silicon.app.tar.gz.sig': 'arm-signature\n',
    });

    const manifest = buildManifest({
      artifactsDir,
      tag: 'desktop-v0.7.1',
      repository: 'Azazel55605/collab',
    });

    // Both Mac families must be reachable: an Intel user whose platform key is
    // missing from latest.json never receives an update at all.
    expect(Object.keys(manifest.platforms).sort()).toEqual(['darwin-aarch64', 'darwin-x86_64']);
    expect(manifest.platforms['darwin-x86_64']).toEqual({
      url: 'https://github.com/Azazel55605/collab/releases/download/desktop-v0.7.1/collab-mac-intel.app.tar.gz',
      signature: 'intel-signature',
    });
    expect(manifest.platforms['darwin-aarch64'].url).toMatch(
      /collab-mac-apple-silicon\.app\.tar\.gz$/,
    );
  });

  it('keeps publishing the Windows installer alongside the macOS bundles', () => {
    const artifactsDir = writeArtifacts({
      'windows-x86_64/collab_0.7.1_x64-setup.exe': 'installer',
      'windows-x86_64/collab_0.7.1_x64-setup.exe.sig': 'windows-signature\n',
    });

    const manifest = buildManifest({
      artifactsDir,
      tag: 'desktop-v0.7.1',
      repository: 'Azazel55605/collab',
    });

    expect(manifest.platforms['windows-x86_64']).toEqual({
      url: 'https://github.com/Azazel55605/collab/releases/download/desktop-v0.7.1/collab_0.7.1_x64-setup.exe',
      signature: 'windows-signature',
    });
  });

  it('omits a platform whose signature is missing rather than publishing an unverifiable update', () => {
    const artifactsDir = writeArtifacts({
      // Bundle present, .sig absent -- the updater would reject this download,
      // so it must never reach latest.json in the first place.
      'mac-intel/collab-mac-intel.app.tar.gz': 'intel bundle',
    });

    const manifest = buildManifest({
      artifactsDir,
      tag: 'desktop-v0.7.1',
      repository: 'Azazel55605/collab',
    });

    expect(manifest.platforms).toEqual({});
  });

  it('derives the version from the desktop tag', () => {
    const artifactsDir = writeArtifacts({});

    expect(buildManifest({ artifactsDir, tag: 'desktop-v1.2.3', repository: 'o/r' }).version).toBe(
      '1.2.3',
    );
    expect(buildManifest({ artifactsDir, tag: 'v1.2.3', repository: 'o/r' }).version).toBe('1.2.3');
  });

  it('refuses to build a manifest without a tag or repository', () => {
    const artifactsDir = writeArtifacts({});

    // Without these, every url would read ".../undefined/..." and the updater
    // would chase a 404 for the whole release.
    expect(() => buildManifest({ artifactsDir, repository: 'o/r' })).toThrow(/tag/i);
    expect(() => buildManifest({ artifactsDir, tag: 'desktop-v1.0.0' })).toThrow(/repository/i);
  });
});

describe('update manifest cli', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'generate-update-manifest.mjs');

  function runCli(cwd: string) {
    return execFileSync(process.execPath, [script], {
      cwd,
      env: { ...process.env, TAG: 'desktop-v0.7.1', GITHUB_REPOSITORY: 'Azazel55605/collab' },
      encoding: 'utf8',
    });
  }

  it('writes a latest.json covering both macOS architectures', () => {
    const cwd = writeArtifacts({
      'artifacts/mac-intel/collab-mac-intel.app.tar.gz': 'intel bundle',
      'artifacts/mac-intel/collab-mac-intel.app.tar.gz.sig': 'intel-signature',
      'artifacts/mac-apple-silicon/collab-mac-apple-silicon.app.tar.gz': 'arm bundle',
      'artifacts/mac-apple-silicon/collab-mac-apple-silicon.app.tar.gz.sig': 'arm-signature',
    });

    const output = runCli(cwd);
    const manifest = JSON.parse(readFileSync(join(cwd, 'latest.json'), 'utf8'));

    expect(Object.keys(manifest.platforms).sort()).toEqual(['darwin-aarch64', 'darwin-x86_64']);
    // The run log is the only place a maintainer sees which platforms shipped.
    expect(output).toContain('darwin-x86_64');
    expect(output).toContain('darwin-aarch64');
  });

  it('fails instead of publishing a manifest that would update nobody', () => {
    const cwd = writeArtifacts({});

    expect(() => runCli(cwd)).toThrow();
  });
});
