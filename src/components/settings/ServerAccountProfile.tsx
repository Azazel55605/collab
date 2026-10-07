import { useRef, useState } from 'react';

import { knownServerFor, upsertKnownServer } from '../../lib/hostedServers';
import { tauriCommands } from '../../lib/tauri';
import { type ServerProfile, useServerProfile } from '../../lib/useServerProfile';
import { isEffectivelyConnected, useServerStore } from '../../store/serverStore';
import { Button } from '../ui/button';
import { Field, FieldGroup, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';

import { SectionLabel } from './settingsControls';

export default function ServerAccountProfile() {
  const connections = useServerStore((s) => s.connections);
  const connected = Object.values(connections).filter((c) => isEffectivelyConnected(c.status));
  const [chosen, setChosen] = useState('');
  const serverUrl = connected.some((c) => c.status.serverUrl === chosen)
    ? chosen
    : (connected[0]?.status.serverUrl ?? '');
  return (
    <section className="flex flex-col gap-4 mt-6">
      <SectionLabel>Server account</SectionLabel>
      {connected.length > 1 && (
        <Tabs value={serverUrl} onValueChange={setChosen}>
          <TabsList className="flex flex-wrap h-auto" aria-label="Profile server">
            {connected.map(({ status }) => (
              <TabsTrigger key={status.serverUrl} value={status.serverUrl!}>
                {status.serverUrl}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      {serverUrl ? (
        <AccountForm key={serverUrl} serverUrl={serverUrl} />
      ) : (
        <p className="text-xs text-muted-foreground">Connect to a server to manage your account.</p>
      )}
    </section>
  );
}

function AccountForm({ serverUrl }: { serverUrl: string }) {
  async function onUpdated(profile: ServerProfile) {
    const known = knownServerFor(serverUrl);
    if (known) upsertKnownServer({ ...known, username: profile.username });
    await useServerStore.getState().refreshAll();
  }
  const p = useServerProfile(serverUrl, onUpdated);
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground break-all">{serverUrl}</p>
      {p.error && (
        <p role="alert" className="text-sm text-destructive">
          {p.error}
        </p>
      )}
      {p.message && (
        <p role="status" className="text-sm">
          {p.message}
        </p>
      )}
      {!p.profile ? (
        <p>Loading profile…</p>
      ) : (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            {p.avatar ? (
              <img
                src={p.avatar}
                alt="Your profile picture"
                className="size-16 rounded-full object-cover"
              />
            ) : (
              <span className="size-16 rounded-full bg-muted flex items-center justify-center">
                {p.profile.displayName.slice(0, 2)}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={p.busy}
              onClick={() => fileInput.current?.click()}
            >
              Change picture
            </Button>
            {p.profile.hasAvatar && (
              <Button
                variant="outline"
                size="sm"
                disabled={p.busy}
                onClick={() =>
                  void p.mutate(
                    () =>
                      tauriCommands.hostedAccountRequest<ServerProfile>(
                        serverUrl,
                        'DELETE',
                        '/api/v1/users/me/avatar',
                      ),
                    'Picture removed.',
                  )
                }
              >
                Remove picture
              </Button>
            )}
            <input
              hidden
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                if (file.size > 1024 * 1024) {
                  p.setError('Pictures must be 1 MB or smaller.');
                  return;
                }
                void p.mutate(async () => {
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  let binary = '';
                  for (let offset = 0; offset < bytes.length; offset += 32768)
                    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
                  return tauriCommands.hostedAccountRequest<ServerProfile>(
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
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void p.mutate(
                () =>
                  tauriCommands.hostedAccountRequest<ServerProfile>(
                    serverUrl,
                    'PATCH',
                    '/api/v1/users/me',
                    { username: p.username.trim(), displayName: p.name.trim() },
                  ),
                'Profile updated.',
              );
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="account-display-name">Display name</FieldLabel>
                <Input
                  id="account-display-name"
                  required
                  maxLength={200}
                  value={p.name}
                  onChange={(e) => p.setName(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="account-username">Username</FieldLabel>
                <Input
                  id="account-username"
                  required
                  autoComplete="username"
                  value={p.username}
                  onChange={(e) => p.setUsername(e.target.value)}
                />
              </Field>
            </FieldGroup>
            <Button size="sm" disabled={p.busy}>
              Save account
            </Button>
          </form>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (p.newPassword !== p.confirmPassword) {
                p.setError('New passwords do not match.');
                return;
              }
              void p.mutate(async () => {
                await tauriCommands.hostedAccountRequest<void>(
                  serverUrl,
                  'POST',
                  '/api/v1/users/me/password',
                  { currentPassword: p.currentPassword, newPassword: p.newPassword },
                );
                if (p.alive.current) {
                  p.setCurrentPassword('');
                  p.setNewPassword('');
                  p.setConfirmPassword('');
                }
              }, 'Password changed. Other sessions have been signed out.');
            }}
          >
            <h3 className="text-sm font-medium">Change password</h3>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="account-current-password">Current password</FieldLabel>
                <Input
                  id="account-current-password"
                  required
                  type="password"
                  autoComplete="current-password"
                  value={p.currentPassword}
                  onChange={(e) => p.setCurrentPassword(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="account-new-password">New password</FieldLabel>
                <Input
                  id="account-new-password"
                  required
                  minLength={12}
                  type="password"
                  autoComplete="new-password"
                  value={p.newPassword}
                  onChange={(e) => p.setNewPassword(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="account-confirm-new-password">Confirm new password</FieldLabel>
                <Input
                  id="account-confirm-new-password"
                  required
                  minLength={12}
                  type="password"
                  autoComplete="new-password"
                  value={p.confirmPassword}
                  onChange={(e) => p.setConfirmPassword(e.target.value)}
                />
              </Field>
            </FieldGroup>
            <Button size="sm" disabled={p.busy}>
              Change password
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
