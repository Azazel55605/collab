/**
 * Registry of hosted servers the companion app has connected to. Persisted in
 * the app's localStorage so every saved server is restored / reconnected on the
 * next launch (the app can be signed in to several servers at once). Mirrors the
 * desktop `KnownServer` shape from `src/lib/hostedServers.ts`.
 */

export interface KnownServer {
  serverUrl: string;
  username: string;
  allowInvalidCertificates: boolean;
  persistAcrossReboots: boolean;
  offlineCopyMode?: 'inherit' | 'always' | 'never';
}

const KNOWN_SERVERS_KEY = 'collab-mobile-servers';

function isKnownServer(value: unknown): value is KnownServer {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as KnownServer).serverUrl === 'string' &&
    (value as KnownServer).serverUrl.length > 0
  );
}

function save(list: KnownServer[]): void {
  try {
    localStorage.setItem(KNOWN_SERVERS_KEY, JSON.stringify(list));
  } catch {
    // Best-effort persistence.
  }
}

export function normalizeServerUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function listKnownServers(): KnownServer[] {
  try {
    const raw = localStorage.getItem(KNOWN_SERVERS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(isKnownServer);
    }
  } catch {
    // Fall through to empty.
  }
  return [];
}

export function upsertKnownServer(server: KnownServer): void {
  const list = listKnownServers().filter((entry) => entry.serverUrl !== server.serverUrl);
  list.push(server);
  save(list);
}

export function removeKnownServer(serverUrl: string): void {
  save(listKnownServers().filter((entry) => entry.serverUrl !== serverUrl));
}
