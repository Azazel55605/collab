#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mappingRoot = join(
  rootDir,
  'src-tauri',
  'gen',
  'android',
  'app',
  'build',
  'outputs',
  'mapping',
);

const boundaries = {
  'com.azazel.collab.companion.CollabTokenStore': [
    'storeRefreshToken',
    'readRefreshToken',
    'deleteRefreshToken',
  ],
  'com.azazel.collab.companion.CollabReplicaKeyStore': ['storeKey', 'readKey', 'deleteKey'],
  'com.azazel.collab.companion.CollabBackgroundScheduler': [
    'configure',
    'requestImmediate',
    'requestDiagnostic',
    'cancelProfile',
  ],
  'com.azazel.collab.companion.CollabContentUri': ['displayName'],
  'com.azazel.collab.companion.CollabNotificationBridge': [
    'permissionStatus',
    'requestPermission',
    'sendTest',
    'takePendingOpen',
    'requestPushRegistration',
    'existingPushInstallationId',
  ],
  'com.azazel.collab.companion.CollabNotificationScheduler': [
    'exactAlarmStatus',
    'openExactAlarmSettings',
    'scheduleProfile',
  ],
};

async function mappingFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return mappingFiles(path);
      return entry.name === 'mapping.txt' ? [path] : [];
    }),
  );
  return files.flat();
}

function classSection(mapping, className) {
  const header = `${className} -> ${className}:`;
  const start = mapping.indexOf(header);
  if (start < 0) return null;
  const remainder = mapping.slice(start + header.length);
  const nextClass = remainder.search(/^\S.* -> .*:$/m);
  return nextClass < 0 ? remainder : remainder.slice(0, nextClass);
}

async function main() {
  let candidates;
  try {
    candidates = await mappingFiles(mappingRoot);
  } catch {
    throw new Error(`Android release mapping is missing below ${mappingRoot}.`);
  }
  if (candidates.length === 0) {
    throw new Error(`Android release mapping is missing below ${mappingRoot}.`);
  }
  const withTimes = await Promise.all(
    candidates.map(async (path) => ({
      path,
      mtimeMs: (await stat(path)).mtimeMs,
    })),
  );
  withTimes.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const mappingPath = withTimes[0].path;
  const mapping = await readFile(mappingPath, 'utf8');
  const failures = [];

  for (const [className, methods] of Object.entries(boundaries)) {
    const section = classSection(mapping, className);
    if (section === null) {
      failures.push(`${className} was removed or renamed`);
      continue;
    }
    for (const method of methods) {
      const preserved = section
        .split('\n')
        .some((line) => line.includes(` ${method}(`) && line.trimEnd().endsWith(` -> ${method}`));
      if (!preserved) failures.push(`${className}.${method} was removed or renamed`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Android release JNI validation failed:\n- ${failures.join('\n- ')}`);
  }
  console.log(`Android release JNI names verified in ${mappingPath}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
