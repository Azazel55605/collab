#!/usr/bin/env node

import fs from 'node:fs';

const args = process.argv.slice(2);
let target = 'all';
let tag = process.env.GITHUB_REF_NAME;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--target') {
    target = args[index + 1] ?? '';
    index += 1;
  } else if (arg.startsWith('--target=')) {
    target = arg.slice('--target='.length);
  } else if (!tag) {
    tag = arg;
  } else {
    tag = arg;
  }
}

if (!tag) {
  console.error(
    'Usage: node scripts/check-release-version.mjs [--target all|server|desktop|mobile|admin-web] v<major>.<minor>.<patch>',
  );
  process.exit(64);
}

const tagMatch =
  /^(?:(server|desktop|mobile|admin-web)-)?v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)$/.exec(
    tag,
  );
if (!tagMatch) {
  console.error(
    `Release tag must be v<major>.<minor>.<patch> or <target>-v<major>.<minor>.<patch>: ${tag}`,
  );
  process.exit(1);
}
if (target === 'all' && tagMatch[1]) {
  target = tagMatch[1];
}
if (tagMatch[1] && target !== 'all' && target !== tagMatch[1]) {
  console.error(`Release tag target "${tagMatch[1]}" does not match --target ${target}.`);
  process.exit(1);
}

const version = tagMatch[2];
const packageVersion = (path) => JSON.parse(fs.readFileSync(path, 'utf8')).version;
const versionsManifest = () => JSON.parse(fs.readFileSync('versions.json', 'utf8'));
const cargoVersion = (path, workspace = false) => {
  const source = fs.readFileSync(path, 'utf8');
  const section = workspace ? '\\[workspace\\.package\\]' : '\\[package\\]';
  const match = new RegExp(`${section}[\\s\\S]*?^version\\s*=\\s*"([^"]+)"`, 'm').exec(source);
  if (!match) throw new Error(`Could not find a concrete version in ${path}`);
  return match[1];
};

const manifest = versionsManifest();
const allVersions = {
  server: new Map([
    ['versions.json server', manifest.server],
    ['Cargo.toml workspace', cargoVersion('Cargo.toml', true)],
  ]),
  desktop: new Map([
    ['versions.json desktop', manifest.desktop],
    ['package.json', packageVersion('package.json')],
    ['src-tauri/Cargo.toml', cargoVersion('src-tauri/Cargo.toml')],
  ]),
  mobile: new Map([['versions.json mobile.versionName', manifest.mobile?.versionName]]),
  'admin-web': new Map([
    ['versions.json adminWeb', manifest.adminWeb],
    ['apps/admin-web/package.json', packageVersion('apps/admin-web/package.json')],
  ]),
};

if (target === 'all') {
  allVersions.all = new Map(Object.values(allVersions).flatMap((entries) => [...entries]));
}

const versions = allVersions[target];
if (!versions) {
  console.error(
    `Unknown release target "${target}". Expected all, server, desktop, mobile, or admin-web.`,
  );
  process.exit(64);
}

if ([...versions.values()].some((actual) => actual !== version)) {
  console.error(`Release tag ${tag} does not match ${target} project version:`);
  for (const [source, actual] of versions) console.error(`  ${source}: ${actual}`);
  process.exit(1);
}

console.log(`Release version ${version} is consistent for ${target}.`);
