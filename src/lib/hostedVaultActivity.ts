/**
 * Last-opened timestamps for hosted vaults.
 *
 * Local vaults carry `lastOpened` in the native recents list, but that list only
 * keeps entries whose path is a directory on disk, so `hosted://…` vaults never
 * survive in it. The start screen still needs to order hosted vaults by use, so
 * this small client-side record fills that gap.
 */

const STORAGE_KEY = 'collab-hosted-vault-last-opened';
const MAX_ENTRIES = 200;

export function hostedVaultActivityKey(serverUrl: string, vaultId: string): string {
  return `${serverUrl}|${vaultId}`;
}

export function readHostedVaultLastOpened(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

export function recordHostedVaultOpened(
  serverUrl: string,
  vaultId: string,
  at: number = Date.now(),
): void {
  const entries = readHostedVaultLastOpened();
  entries[hostedVaultActivityKey(serverUrl, vaultId)] = at;
  const trimmed = Object.entries(entries)
    .sort(([, left], [, right]) => right - left)
    .slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // Storage full or unavailable: ordering falls back to name.
  }
}
