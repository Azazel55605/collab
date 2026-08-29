#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadataResult = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], {
  cwd: root,
  encoding: 'utf8',
});

if (metadataResult.status !== 0) {
  process.stderr.write(metadataResult.stderr || 'cargo metadata failed\n');
  process.exit(metadataResult.status ?? 1);
}

const metadata = JSON.parse(metadataResult.stdout);
const workspaceIds = new Set(metadata.workspace_members);
const packages = new Map(
  metadata.packages.filter((pkg) => workspaceIds.has(pkg.id)).map((pkg) => [pkg.name, pkg]),
);

const allowedWorkspaceEdges = new Map([
  ['collab-core', new Set()],
  ['collab-protocol', new Set()],
  ['collab-net-policy', new Set()],
  ['collab-documents', new Set(['collab-core'])],
  ['collab-vault-domain', new Set(['collab-core', 'collab-documents'])],
  ['collab-archive', new Set(['collab-core', 'collab-vault-domain'])],
  ['collab-live', new Set(['collab-documents', 'collab-protocol'])],
  ['collab-replica', new Set(['collab-core', 'collab-protocol', 'collab-vault-domain'])],
  ['collab-calendar', new Set()],
  ['collab-circuit', new Set()],
  ['collab-sheet', new Set()],
  [
    'collab-server',
    new Set([
      'collab-calendar',
      'collab-core',
      'collab-documents',
      'collab-live',
      'collab-net-policy',
      'collab-protocol',
      'collab-vault-domain',
      'collab-archive',
    ]),
  ],
  [
    'collab',
    new Set([
      'collab-calendar',
      'collab-circuit',
      'collab-core',
      'collab-documents',
      'collab-live',
      'collab-net-policy',
      'collab-protocol',
      'collab-replica',
      'collab-sheet',
      'collab-vault-domain',
      'collab-archive',
    ]),
  ],
]);

const domainCrates = new Set([
  'collab-core',
  'collab-protocol',
  'collab-net-policy',
  'collab-documents',
  'collab-vault-domain',
  'collab-archive',
  'collab-live',
  'collab-replica',
  'collab-calendar',
  'collab-circuit',
  'collab-sheet',
]);
const adapterFrameworks = new Set([
  'actix-web',
  'axum',
  'gtk',
  'hyper',
  'jni',
  'keyring',
  'notify',
  'reqwest',
  'rocket',
  'tauri',
  'tokio-tungstenite',
  'tower-http',
  'warp',
  'webkit2gtk',
  'wry',
]);
const persistenceFrameworks = new Set([
  'diesel',
  'postgres',
  'redb',
  'rocksdb',
  'rusqlite',
  'sea-orm',
  'sled',
  'sqlx',
]);
const persistenceExceptions = new Set([
  // Calendar intentionally owns its profile-scoped SQLite store.
  'collab-calendar',
]);

const errors = [];
for (const [name, pkg] of packages) {
  const allowed = allowedWorkspaceEdges.get(name);
  if (!allowed) {
    errors.push(`workspace crate ${name} is missing from the boundary policy`);
    continue;
  }

  for (const dependency of pkg.dependencies) {
    const dependencyName = dependency.name;
    if (packages.has(dependencyName) && !allowed.has(dependencyName)) {
      errors.push(`${name} must not depend on workspace crate ${dependencyName}`);
    }
    if (domainCrates.has(name) && adapterFrameworks.has(dependencyName)) {
      errors.push(`${name} must not depend on adapter framework ${dependencyName}`);
    }
    if (
      domainCrates.has(name) &&
      persistenceFrameworks.has(dependencyName) &&
      !persistenceExceptions.has(name)
    ) {
      errors.push(`${name} must not depend on persistence framework ${dependencyName}`);
    }
  }
}

for (const member of packages.keys()) {
  if (!allowedWorkspaceEdges.has(member)) {
    errors.push(`workspace crate ${member} has no declared dependency policy`);
  }
}

if (errors.length > 0) {
  process.stderr.write('Rust crate boundary check failed:\n');
  for (const error of errors) {
    process.stderr.write(`- ${error}\n`);
  }
  process.exit(1);
}

const edges = [...packages]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([name, pkg]) => {
    const dependencies = pkg.dependencies
      .map((dependency) => dependency.name)
      .filter((dependency) => packages.has(dependency))
      .sort();
    return `${name}: ${dependencies.join(', ') || 'none'}`;
  });

process.stdout.write(`Rust crate boundaries are valid.\n${edges.join('\n')}\n`);
