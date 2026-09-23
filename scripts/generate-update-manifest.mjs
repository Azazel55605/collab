#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Tauri platform key -> the build artifact holding that platform's updater
// bundle, plus how to recognise the bundle and its detached signature.
//
// Linux is intentionally omitted: the in-app updater's only Linux target was the
// AppImage, which is no longer built. Linux updates are handled by the system
// package manager (.deb/.rpm) or Flathub (Flatpak).
const PLATFORMS = {
  'windows-x86_64': {
    artifact: 'windows-x86_64',
    file: /-setup\.exe$|\.msi$/,
    sig: /-setup\.exe\.sig$|\.msi\.sig$/,
  },
  'darwin-x86_64': {
    artifact: 'mac-intel',
    file: /\.app\.tar\.gz$/,
    sig: /\.app\.tar\.gz\.sig$/,
  },
  'darwin-aarch64': {
    artifact: 'mac-apple-silicon',
    file: /\.app\.tar\.gz$/,
    sig: /\.app\.tar\.gz\.sig$/,
  },
};

/** Finds the first file under `dir` whose path matches `pattern`. */
function findFile(dir, pattern) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { recursive: true })) {
    if (pattern.test(String(entry))) return join(dir, String(entry));
  }
  return null;
}

/**
 * Builds the tauri-plugin-updater manifest from the downloaded build artifacts.
 *
 * A platform is included only when both its bundle and its signature are
 * present: the updater verifies every download against the bundled minisign
 * public key, so an entry without a signature would fail for every user that
 * followed it.
 */
export function buildManifest({ artifactsDir, tag, repository, pubDate = new Date(), onSkip }) {
  if (!tag) throw new Error('A release tag is required to build the update manifest.');
  if (!repository)
    throw new Error('A repository (owner/name) is required to build the update manifest.');

  const version = tag.replace(/^desktop-v/, '').replace(/^v/, '');
  const baseUrl = `https://github.com/${repository}/releases/download/${tag}`;
  const platforms = {};

  for (const [platform, config] of Object.entries(PLATFORMS)) {
    const dir = join(artifactsDir, config.artifact);
    const bundle = findFile(dir, config.file);
    const signature = findFile(dir, config.sig);

    if (!bundle) {
      onSkip?.(platform, `no installer found under ${dir}`);
      continue;
    }
    if (!signature) {
      onSkip?.(platform, `no .sig found under ${dir} (installer: ${basename(bundle)})`);
      continue;
    }

    platforms[platform] = {
      url: `${baseUrl}/${basename(bundle)}`,
      signature: readFileSync(signature, 'utf8').trim(),
    };
  }

  return { version, notes: '', pub_date: pubDate.toISOString(), platforms };
}

function main() {
  const manifest = buildManifest({
    artifactsDir: 'artifacts',
    tag: process.env.TAG,
    repository: process.env.GITHUB_REPOSITORY,
    onSkip: (platform, reason) => console.warn(`  skipped ${platform}: ${reason}`),
  });

  for (const [platform, entry] of Object.entries(manifest.platforms)) {
    console.log(`  ${platform}: ${basename(entry.url)}`);
  }

  // An empty manifest is worse than a failed job: it publishes successfully and
  // silently strands every installed client on its current version.
  if (Object.keys(manifest.platforms).length === 0) {
    console.error(
      'No platform produced a verifiable update artifact; refusing to write latest.json.',
    );
    process.exit(1);
  }

  writeFileSync('latest.json', JSON.stringify(manifest, null, 2));
  console.log('latest.json written.');
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
