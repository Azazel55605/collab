import { useEffect, useRef, useState } from 'react';

import { tauriCommands } from './tauri';

export interface ServerProfile {
  id: string;
  username: string;
  displayName: string;
  hasAvatar: boolean;
  avatarUpdatedAt: string | null;
}

export function useServerProfile(
  serverUrl: string,
  onUpdated: (profile: ServerProfile) => Promise<void>,
) {
  const [profile, setServerProfile] = useState<ServerProfile | null>(null);
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void tauriCommands
      .hostedAccountRequest<ServerProfile>(serverUrl, 'GET', '/api/v1/users/me')
      .then((user) => {
        if (cancelled) return;
        setServerProfile(user);
        setUsername(user.username);
        setName(user.displayName);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [serverUrl]);

  const [avatarError, setAvatarError] = useState('');
  const profileId = profile?.id;
  useEffect(() => {
    let cancelled = false;
    setAvatar(null);
    setAvatarError('');
    if (!profileId) return;
    // Ask even when `hasAvatar` is false: the native client answers a 404 with
    // null, so a stale or wrong flag can no longer hide an uploaded picture.
    void tauriCommands
      .hostedAccountRequest<string | null>(serverUrl, 'GET', '/api/v1/users/me/avatar')
      .then((data) => {
        if (!cancelled) setAvatar(typeof data === 'string' ? data : null);
      })
      .catch((reason) => {
        if (!cancelled) setAvatarError(`Your picture could not be loaded: ${String(reason)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [serverUrl, profileId, profile?.hasAvatar, profile?.avatarUpdatedAt]);

  async function mutate(action: () => Promise<ServerProfile | void>, success: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const user = await action();
      if (!alive.current) return;
      if (user) {
        setServerProfile(user);
        setName(user.displayName);
        setUsername(user.username);
        await onUpdated(user);
      }
      if (alive.current) setMessage(success);
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return {
    profile,
    username,
    setUsername,
    name,
    setName,
    avatar,
    avatarError,
    currentPassword,
    setCurrentPassword,
    newPassword,
    setNewPassword,
    confirmPassword,
    setConfirmPassword,
    busy,
    error,
    setError,
    message,
    mutate,
    alive,
  };
}
