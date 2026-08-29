import type { VaultClient } from './vaultClient';

/**
 * Persists `content` as a sibling "conflicted copy" of `relativePath`, so a
 * user resolving a remote change with "Save mine as new" keeps a recoverable
 * copy of their local work while the active document adopts the remote version
 * (Phase 3 of the document session & collaboration plan).
 *
 * The new file is created next to the original with a ` (conflicted copy …)`
 * suffix before the extension, and a numeric disambiguator is appended if that
 * name already exists. Works for both local and hosted vaults via the shared
 * {@link VaultClient} document API. Returns the created relative path.
 */
export async function saveConflictedCopy(
  client: VaultClient,
  relativePath: string,
  content: string,
): Promise<string> {
  const existing = new Set(await safeListPaths(client));
  const target = uniqueConflictedPath(relativePath, existing);
  await client.createDocument(target);
  await client.writeDocument(target, content);
  return target;
}

async function safeListPaths(client: VaultClient): Promise<string[]> {
  try {
    return (await client.listFiles()).map((f) => f.relativePath);
  } catch {
    // If listing fails we still attempt a best-effort unique name from a stamp.
    return [];
  }
}

/** Splits a relative path into `{ dir, stem, ext }` (ext includes the dot). */
function splitPath(relativePath: string): { dir: string; stem: string; ext: string } {
  const slash = relativePath.lastIndexOf('/');
  const dir = slash === -1 ? '' : relativePath.slice(0, slash + 1);
  const name = slash === -1 ? relativePath : relativePath.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { dir, stem: name, ext: '' };
  return { dir, stem: name.slice(0, dot), ext: name.slice(dot) };
}

export function uniqueConflictedPath(relativePath: string, existing: Set<string>): string {
  const { dir, stem, ext } = splitPath(relativePath);
  const stamp = new Date().toISOString().slice(0, 10);
  const baseLabel = `${stem} (conflicted copy ${stamp})`;
  let candidate = `${dir}${baseLabel}${ext}`;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `${dir}${baseLabel} ${n}${ext}`;
    n += 1;
  }
  return candidate;
}
