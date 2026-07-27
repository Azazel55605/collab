import { type FormEvent, useEffect, useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { KnownServer } from '../../lib/hostedServers';
import { useServerStore } from '../../store/serverStore';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';

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
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (server) {
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

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!server || !password) return;
    setBusy(true);
    setError(null);
    try {
      await reauthenticate(server.serverUrl, password);
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

  return (
    <Dialog open={server != null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound size={16} />
              Sign in again
            </DialogTitle>
            <DialogDescription>
              Reauthenticate {server?.username ? `${server.username} on ` : ''}{server?.serverUrl}.
              Your saved server settings and offline copies will be kept.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1.5">
            <span className="text-xs font-medium">Password</span>
            <Input
              autoFocus
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy}
              required
            />
          </label>
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !password}>
              {busy ? <Loader2 className="animate-spin" /> : <KeyRound />}
              Sign in
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
