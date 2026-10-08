import { useEffect, useState } from 'react';

import { tauriCommands } from './tauri';

/**
 * Authenticated user avatars as data URLs, shared by every chat surface.
 * Sessions can outlive a profile change, so `hasAvatar` flags are not trusted:
 * each user is asked once per TTL and a missing avatar is cached as `null`.
 */
const TTL = 5 * 60_000;
const cache = new Map<string, { at: number; value: Promise<string | null> }>();

export function readUserAvatar(serverUrl: string, userId: string, version = '') {
  const key = JSON.stringify([serverUrl, userId, version]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = tauriCommands
    .hostedAccountRequest<string>(serverUrl, 'GET', `/api/v1/users/${userId}/avatar`)
    .then((data) => (typeof data === 'string' && data.startsWith('data:image/') ? data : null))
    .catch(() => null);
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
    setImage(null);
    // The nil UUID stands in for deleted senders, who have no avatar.
    if (!enabled || !serverUrl || !userId || userId === NIL_UUID) return;
    void readUserAvatar(serverUrl, userId, version).then((data) => {
      if (alive) setImage(data);
    });
    return () => {
      alive = false;
    };
  }, [serverUrl, userId, enabled, version]);
  return image;
}
