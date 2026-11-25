import { type FormEvent, useEffect, useState } from 'react';

import { KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import type { KnownServer } from '../../lib/hostedServers';
import { useServerStore } from '../../store/serverStore';
import {
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
} from '../ui/app-dialog';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Input } from '../ui/input';

import { LinuxSessionPersistence } from './LinuxSessionPersistence';

interface ReauthenticateServerDialogProps {
  server: KnownServer | null;
  onOpenChange: (open: boolean) => void;
  onReauthenticated?: () => void;
}

export function ReauthenticateServerDialog({
  server,
  onOpenChange,
  onReauthenticated,
}: ReauthenticateServerDialogProps) {
  const reauthenticate = useServerStore((state) => state.reauthenticate);
  const reconnect = useServerStore((state) => state.reconnect);
  const [password, setPassword] = useState('');
  const [persistent, setPersistent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (server) {
      setPersistent(server.persistAcrossReboots);
      setPassword('');
      setError(null);
    }
  }, [server]);

  const handleOpenChange = (open: boolean) => {
    if (busy) return;
    if (!open) {
      setPassword('');
      setError(null);
    }
    onOpenChange(open);
  };

  const signIn = async (restore: boolean) => {
    if (!server || busy || (!restore && !password)) return;
    setBusy(true);
    setError(null);
    try {
      if (restore) {
        await reconnect(
          server.serverUrl,
          server.allowInvalidCertificates,
          server.persistAcrossReboots,
        );
      } else {
        await reauthenticate(server.serverUrl, password, persistent);
      }
      toast.success(`Signed in to ${server.serverUrl}`);
      setPassword('');
      onOpenChange(false);
      onReauthenticated?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void signIn(false);
  };

  const host = server ? serverHostLabel(server.serverUrl) : '';
  return (
    <Dialog open={server != null} onOpenChange={handleOpenChange}>
      <AppDialogContent size="s">
        <form className="contents" onSubmit={submit}>
          <AppDialogHeader
            icon={<KeyRound />}
            title="Sign in again"
            description={`Restore your saved session on ${host} or sign in with your password.`}
          />
          <AppDialogBody>
            {server?.username ? (
              <div className="space-y-1.5">
                <span className="text-xs font-medium">Account</span>
                <Input value={server.username} readOnly disabled className="h-9" />
              </div>
            ) : null}
            <label className="block space-y-1.5">
              <span className="text-xs font-medium">Password</span>
              <Input
                autoFocus
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
                required
                className="h-9"
              />
            </label>
            {server && (
              <LinuxSessionPersistence
                checked={persistent}
                onChange={setPersistent}
                disabled={busy}
              />
            )}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void signIn(true)}
            >
              Restore saved session
            </Button>
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </AppDialogBody>
          <AppDialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={busy}
            >
              Work offline
            </Button>
            <Button type="submit" disabled={busy || !password}>
              {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
              Sign in
            </Button>
          </AppDialogFooter>
        </form>
      </AppDialogContent>
    </Dialog>
  );
}

function serverHostLabel(serverUrl: string): string {
  try {
    return new URL(serverUrl).host || serverUrl;
  } catch {
    return serverUrl;
  }
}
