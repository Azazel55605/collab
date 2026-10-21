import { useEffect, useState } from 'react';

import { tauriCommands } from './tauri';

const TTL = 5 * 60_000;
const NEGATIVE_TTL = 60_000;
const MAX_ENTRIES = 128;
const BYTE_BUDGET = 8 * 1024 * 1024;
const RETRY_DELAYS = [2_000, 10_000, 30_000];
interface AvatarEntry {
  at: number;
  bytes: number;
  value: Promise<string | null>;
  expires: number;
}
const cache = new Map<string, AvatarEntry>();
const invalidations = new Set<(server?: string) => void>();
let accountFor = (_server: string) => '';
export function setAvatarAccountResolver(resolver: (server: string) => string) {
  accountFor = resolver;
}
function trim() {
  let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [key, entry] of cache) {
    if (entry.expires <= Date.now() || cache.size > MAX_ENTRIES || bytes > BYTE_BUDGET) {
      cache.delete(key);
      bytes -= entry.bytes;
    }
  }
}
export function avatarCacheStats() {
  trim();
  return {
    entries: cache.size,
    bytes: [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0),
  };
}
export function readUserAvatar(serverUrl: string, userId: string, version = '') {
  trim();
  const key = JSON.stringify([serverUrl, accountFor(serverUrl), userId, version]);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }
  const entry: AvatarEntry = {
    at: Date.now(),
    bytes: 0,
    expires: Date.now() + TTL,
    value: Promise.resolve(null),
  };
  entry.value = tauriCommands
    .hostedAccountRequest<string | null>(serverUrl, 'GET', `/api/v1/users/${userId}/avatar`)
    .then((data) => {
      const value =
        typeof data === 'string' && data.startsWith('data:image/') && data.length <= 1_500_000
          ? data
          : null;
      if (cache.get(key) === entry) {
        entry.bytes = value ? value.length * 2 : 0;
        entry.expires = Date.now() + (value ? TTL : NEGATIVE_TTL);
        trim();
      }
      return value;
    })
    .catch((error) => {
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
  cache.set(key, entry);
  trim();
  return entry.value;
}
export function clearUserAvatars(server?: string) {
  for (const key of cache.keys()) if (!server || JSON.parse(key)[0] === server) cache.delete(key);
  for (const callback of invalidations) callback(server);
}
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
export function useUserAvatar(
  serverUrl: string | undefined,
  userId: string | undefined,
  enabled = true,
  version = '',
) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    setImage(null);
    if (!enabled || !serverUrl || !userId || userId === NIL_UUID) return;
    const load = (attempt = 0) => {
      clearTimeout(timer);
      const request = ++generation;
      if (document.visibilityState === 'hidden') return;
      void readUserAvatar(serverUrl, userId, version).then(
        (data) => {
          if (!alive || request !== generation) return;
          setImage(data);
          timer = setTimeout(load, data ? TTL : NEGATIVE_TTL);
        },
        () => {
          if (alive && request === generation && attempt < RETRY_DELAYS.length)
            timer = setTimeout(() => load(attempt + 1), RETRY_DELAYS[attempt]);
        },
      );
    };
    const invalidate = (server?: string) => {
      if (!server || server === serverUrl) {
        setImage(null);
        load();
      }
    };
    const resume = () => load();
    invalidations.add(invalidate);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    load();
    return () => {
      alive = false;
      generation++;
      clearTimeout(timer);
      invalidations.delete(invalidate);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [serverUrl, userId, enabled, version]);
  return image;
}
