import { useEffect, useState } from 'react';

import { tauriCommands } from './tauri';

/**
 * Authenticated user avatars as data URLs, shared by every chat surface.
 * Sessions can outlive a profile change, so `hasAvatar` flags are not trusted:
 * each user is asked once per TTL. "No avatar" (null) is cached; a failed
 * request is not, so a transient error at startup does not hide pictures.
 */
const TTL = 5 * 60_000;
const RETRY_DELAYS = [2_000, 10_000, 30_000];
const cache = new Map<string, { at: number; value: Promise<string | null> }>();

export function readUserAvatar(serverUrl: string, userId: string, version = '') {
  const key = JSON.stringify([serverUrl, userId, version]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = tauriCommands
    .hostedAccountRequest<string | null>(serverUrl, 'GET', `/api/v1/users/${userId}/avatar`)
    .then((data) => (typeof data === 'string' && data.startsWith('data:image/') ? data : null))
    .catch((reason: unknown) => {
      cache.delete(key);
      console.warn(`Avatar for ${userId} on ${serverUrl} could not be loaded:`, reason);
      throw reason;
    });
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function clearUserAvatars() {
  cache.clear();
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
    let timer: number | undefined;
    setImage(null);
    // The nil UUID stands in for deleted senders, who have no avatar.
    if (!enabled || !serverUrl || !userId || userId === NIL_UUID) return;
    const load = (attempt: number) => {
      void readUserAvatar(serverUrl, userId, version).then(
        (data) => {
          if (alive) setImage(data);
        },
        () => {
          if (alive && attempt < RETRY_DELAYS.length)
            timer = window.setTimeout(() => load(attempt + 1), RETRY_DELAYS[attempt]);
        },
      );
    };
    load(0);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [serverUrl, userId, enabled, version]);
  return image;
}
