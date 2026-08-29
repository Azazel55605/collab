/**
 * Registry of hosted servers the user has connected to. Persisted in
 * localStorage so every saved server is restored / auto-reconnected on the next
 * launch — the app can be signed in to several servers at once.
 *
 * Replaces the pre-multi-server single-value keys (`collab-hosted-server-url`
 * etc.); those are migrated into this list on first read so existing users keep
 * their saved server.
 */

export interface KnownServer {
  serverUrl: string;
  username: string;
  allowInvalidCertificates: boolean;
  persistAcrossReboots: boolean;
}

const KNOWN_SERVERS_KEY = 'collab-hosted-servers';

// Legacy single-server keys (pre-multi-server), migrated into the list on read.
const LEGACY_SERVER_URL_KEY = 'collab-hosted-server-url';
const LEGACY_USERNAME_KEY = 'collab-hosted-username';
const LEGACY_ALLOW_INVALID_KEY = 'collab-hosted-allow-invalid-certificates';
const LEGACY_PERSIST_KEY = 'collab-hosted-persist-across-reboots';

/** Matches the native server boundary's origin-only URL normalization. */
export function normalizeHostedServerUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return trimmed.replace(/\/+$/, '');
    }
    return url.origin;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

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
    // Best-effort persistence; a failure just means no cross-launch restore.
  }
}

/** All known servers, migrating a legacy single-server entry on first read. */
export function listKnownServers(): KnownServer[] {
  try {
    const raw = localStorage.getItem(KNOWN_SERVERS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const normalized = new Map<string, KnownServer>();
        for (const server of parsed.filter(isKnownServer)) {
          const serverUrl = normalizeHostedServerUrl(server.serverUrl);
          normalized.set(serverUrl, { ...server, serverUrl });
        }
        const list = [...normalized.values()];
        if (JSON.stringify(list) !== JSON.stringify(parsed)) save(list);
        return list;
      }
    }
  } catch {
    // Fall through to migration / empty.
  }
  const legacyUrl = localStorage.getItem(LEGACY_SERVER_URL_KEY);
  if (legacyUrl) {
    const migrated: KnownServer[] = [
      {
        serverUrl: normalizeHostedServerUrl(legacyUrl),
        username: localStorage.getItem(LEGACY_USERNAME_KEY) ?? '',
        allowInvalidCertificates: localStorage.getItem(LEGACY_ALLOW_INVALID_KEY) === 'true',
        persistAcrossReboots: localStorage.getItem(LEGACY_PERSIST_KEY) === 'true',
      },
    ];
    save(migrated);
    return migrated;
  }
  return [];
}

/** Adds or updates a known server (keyed by URL). */
export function upsertKnownServer(server: KnownServer): void {
  const serverUrl = normalizeHostedServerUrl(server.serverUrl);
  const list = listKnownServers().filter((entry) => entry.serverUrl !== serverUrl);
  list.push({ ...server, serverUrl });
  save(list);
}

/** Forgets a server so it is no longer auto-restored (e.g. after logout). */
export function removeKnownServer(serverUrl: string): void {
  const normalized = normalizeHostedServerUrl(serverUrl);
  save(listKnownServers().filter((entry) => entry.serverUrl !== normalized));
}

/** Looks up saved preferences for a server URL. */
export function knownServerFor(serverUrl: string): KnownServer | undefined {
  const normalized = normalizeHostedServerUrl(serverUrl);
  return listKnownServers().find((entry) => entry.serverUrl === normalized);
}
