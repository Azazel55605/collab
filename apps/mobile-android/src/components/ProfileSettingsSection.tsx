import { useRef, useState } from 'react';

import { tauriCommands } from '../../../../src/lib/tauri';
import {
  type ServerProfile as Profile,
  useServerProfile,
} from '../../../../src/lib/useServerProfile';
import { upsertKnownServer } from '../lib/servers';
import { useMobileStore } from '../state/store';

export function ProfileSettingsSection() {
  const servers = useMobileStore((s) => s.servers);
  const statuses = useMobileStore((s) => s.statuses);
  const refreshStatuses = useMobileStore((s) => s.refreshStatuses);
  const connected = servers.filter((server) => statuses[server.serverUrl]?.connected);
  const [chosen, setChosen] = useState('');
  const serverUrl = connected.some((server) => server.serverUrl === chosen)
    ? chosen
    : (connected[0]?.serverUrl ?? '');

  return (
    <section className="card">
      <div className="card-title">Profile</div>
      {connected.length > 1 && (
        <div className="segmented" role="group" aria-label="Profile server">
          {connected.map((server) => (
            <button
              type="button"
              key={server.serverUrl}
              aria-pressed={serverUrl === server.serverUrl}
              onClick={() => setChosen(server.serverUrl)}
            >
              {server.serverUrl}
            </button>
          ))}
        </div>
      )}
      {serverUrl ? (
        <ServerProfile
          key={serverUrl}
          serverUrl={serverUrl}
          onUpdated={async (user) => {
            const server = servers.find((entry) => entry.serverUrl === serverUrl);
            if (server) {
              upsertKnownServer({ ...server, username: user.username });
              useMobileStore.setState((state) => ({
                servers: state.servers.map((entry) =>
                  entry.serverUrl === serverUrl ? { ...entry, username: user.username } : entry,
                ),
              }));
            }
            await refreshStatuses();
          }}
        />
      ) : (
        <p className="footnote">Connect to a server on the Servers tab to manage your profile.</p>
      )}
    </section>
  );
}

function ServerProfile({
  serverUrl,
  onUpdated,
}: {
  serverUrl: string;
  onUpdated: (profile: Profile) => Promise<void>;
}) {
  const {
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
  } = useServerProfile(serverUrl, onUpdated);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <div className="profile-form">
      <p className="footnote">{serverUrl}</p>
      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {avatarError && (
        <div className="banner banner-error" role="alert">
          {avatarError}
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {!profile ? (
        <p>Loading profile…</p>
      ) : (
        <>
          <div className="profile-avatar-actions">
            {avatar ? (
              <img src={avatar} alt="Your profile picture" width={64} height={64} />
            ) : (
              <span className="avatar">{profile.displayName.slice(0, 2)}</span>
            )}
            <button
              className="ghost-button"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              Change picture
            </button>
            {(profile.hasAvatar || avatar) && (
              <button
                className="ghost-button"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    () =>
                      tauriCommands.hostedAccountRequest<Profile>(
                        serverUrl,
                        'DELETE',
                        '/api/v1/users/me/avatar',
                      ),
                    'Picture removed.',
                  )
                }
              >
                Remove picture
              </button>
            )}
            <input
              ref={fileInput}
              hidden
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                if (file.size > 1024 * 1024) {
                  setError('Pictures must be 1 MB or smaller.');
                  return;
                }
                void mutate(async () => {
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  let binary = '';
                  for (let offset = 0; offset < bytes.length; offset += 32768)
                    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
                  return tauriCommands.hostedAccountRequest<Profile>(
                    serverUrl,
                    'PUT',
                    '/api/v1/users/me/avatar',
                    { mediaType: file.type, contentBase64: btoa(binary) },
                  );
                }, 'Picture updated.');
              }}
            />
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(
                () =>
                  tauriCommands.hostedAccountRequest<Profile>(
                    serverUrl,
                    'PATCH',
                    '/api/v1/users/me',
                    { username: username.trim(), displayName: name.trim() },
                  ),
                'Profile updated.',
              );
            }}
          >
            <label className="field">
              <span>Display name</span>
              <input
                value={name}
                required
                maxLength={200}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Username</span>
              <input
                value={username}
                required
                autoComplete="username"
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <button className="primary-button" disabled={busy}>
              Save profile
            </button>
          </form>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (newPassword !== confirmPassword) {
                setError('New passwords do not match.');
                return;
              }
              void mutate(async () => {
                await tauriCommands.hostedAccountRequest<void>(
                  serverUrl,
                  'POST',
                  '/api/v1/users/me/password',
                  { currentPassword, newPassword },
                );
                if (alive.current) {
                  setCurrentPassword('');
                  setNewPassword('');
                  setConfirmPassword('');
                }
              }, 'Password changed. Other sessions have been signed out.');
            }}
          >
            <h3>Change password</h3>
            <label className="field">
              <span>Current password</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </label>
            <label className="field">
              <span>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Confirm new password</span>
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </label>
            <button className="primary-button" disabled={busy}>
              Change password
            </button>
          </form>
        </>
      )}
    </div>
  );
}
