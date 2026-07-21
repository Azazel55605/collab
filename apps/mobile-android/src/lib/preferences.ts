import { listKnownServers, normalizeServerUrl } from './servers';

const ALWAYS_OFFLINE_KEY = 'collab-mobile-always-create-offline-copy';

export function alwaysCreateOfflineCopy(): boolean {
  try {
    return localStorage.getItem(ALWAYS_OFFLINE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setAlwaysCreateOfflineCopy(enabled: boolean): void {
  try {
    localStorage.setItem(ALWAYS_OFFLINE_KEY, String(enabled));
  } catch {
    // Best-effort client preference.
  }
}

export function shouldAlwaysCreateOfflineCopy(serverUrl: string): boolean {
  const normalized = normalizeServerUrl(serverUrl);
  const mode = listKnownServers().find(
    (server) => normalizeServerUrl(server.serverUrl) === normalized,
  )?.offlineCopyMode ?? 'inherit';
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return alwaysCreateOfflineCopy();
}
