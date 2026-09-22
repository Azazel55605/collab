#!/usr/bin/env node

import fs from 'node:fs';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const write = !checkOnly;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  writeFile(path, next);
}

function writeFile(path, next) {
  const current = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
  if (current === next) return;
  if (checkOnly) {
    console.error(`${path} is not synced with versions.json`);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(path, next);
}

function assertVersion(name, value) {
  if (typeof value !== 'string' || !SEMVER.test(value)) {
    throw new Error(`versions.json ${name} must be a semantic version string.`);
  }
}

function replaceTomlVersion(path, section, version) {
  const source = fs.readFileSync(path, 'utf8');
  const pattern = new RegExp(`(${section}[\\s\\S]*?^version\\s*=\\s*")[^"]+(")`, 'm');
  if (!pattern.test(source)) throw new Error(`Could not find ${section} version in ${path}`);
  writeFile(path, source.replace(pattern, `$1${version}$2`));
}

function replaceMetainfoRelease(path, version) {
  const source = fs.readFileSync(path, 'utf8');
  const pattern = /(<release\s+version=")([^"]+)("\s+date=")([^"]+)(")/;
  const match = source.match(pattern);
  if (!match) throw new Error(`Could not find a release entry in ${path}`);

  // Software centres show this version, so it must track versions.json. The
  // release date cannot be derived from a version number; it is only rewritten
  // when the version actually changes, which keeps --check deterministic.
  if (match[2] === version) return;

  const today = new Date().toISOString().slice(0, 10);
  writeFile(path, source.replace(pattern, `$1${version}$3${today}$5`));
}

function replacePkgbuildValue(path, name, value) {
  const source = fs.readFileSync(path, 'utf8');
  const pattern = new RegExp(`(^${name}=).*`, 'm');
  if (!pattern.test(source)) throw new Error(`Could not find ${name} in ${path}`);
  writeFile(path, source.replace(pattern, `$1${value}`));
}

const versions = readJson('versions.json');
assertVersion('server', versions.server);
assertVersion('adminWeb', versions.adminWeb);
assertVersion('desktop', versions.desktop);
if (!versions.mobile || typeof versions.mobile !== 'object') {
  throw new Error('versions.json mobile must be an object.');
}
assertVersion('mobile.versionName', versions.mobile.versionName);
if (!Number.isInteger(versions.mobile.versionCode) || versions.mobile.versionCode < 1) {
  throw new Error('versions.json mobile.versionCode must be a positive integer.');
}
if (versions.mobile.versionCode > 2_100_000_000) {
  throw new Error('versions.json mobile.versionCode exceeds the Google Play maximum.');
}

const rootPackage = readJson('package.json');
rootPackage.version = versions.desktop;
writeJson('package.json', rootPackage);

const adminPackage = readJson('apps/admin-web/package.json');
adminPackage.version = versions.adminWeb;
writeJson('apps/admin-web/package.json', adminPackage);

replaceTomlVersion('Cargo.toml', '\\[workspace\\.package\\]', versions.server);
replaceTomlVersion('src-tauri/Cargo.toml', '\\[package\\]', versions.desktop);

const desktopTauri = readJson('src-tauri/tauri.conf.json');
desktopTauri.version = versions.desktop;
writeJson('src-tauri/tauri.conf.json', desktopTauri);

const mobileTauri = readJson('src-tauri/tauri.android.conf.json');
mobileTauri.version = versions.mobile.versionName;
mobileTauri.bundle ??= {};
mobileTauri.bundle.android ??= {};
mobileTauri.bundle.android.versionCode = versions.mobile.versionCode;
writeJson('src-tauri/tauri.android.conf.json', mobileTauri);

replacePkgbuildValue('packaging/aur/collab/PKGBUILD', 'pkgver', versions.desktop);
replaceMetainfoRelease('flatpak/com.azazel.collab.metainfo.xml', versions.desktop);

if (process.exitCode) {
  process.exit(process.exitCode);
}

if (write) {
  console.log('Version manifests synced from versions.json.');
} else {
  console.log('Version manifests are synced with versions.json.');
}
