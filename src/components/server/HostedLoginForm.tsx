import { FormEvent, useEffect, useState } from 'react';

import { toast } from 'sonner';

import { tauriCommands } from '../../lib/tauri';
import { useServerStore } from '../../store/serverStore';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';

const SERVER_URL_KEY = 'collab-hosted-server-url';
const USERNAME_KEY = 'collab-hosted-username';
const ALLOW_INVALID_CERTIFICATES_KEY = 'collab-hosted-allow-invalid-certificates';
const PERSIST_ACROSS_REBOOTS_KEY = 'collab-hosted-persist-across-reboots';

/**
 * Shared hosted-server sign-in form used by both the Settings server section and
 * the startup vault picker. Persists the server URL, username, and TLS choice up
 * front so a disrupted or failed login never loses what the user already typed,
 * and keeps the bearer-free `connect`/`reconnect` flows in one place.
 */
export function HostedLoginForm({ onConnected }: { onConnected?: () => void }) {
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem(SERVER_URL_KEY) ?? '');
  const [username, setUsername] = useState(() => localStorage.getItem(USERNAME_KEY) ?? '');
  const [allowInvalidCertificates, setAllowInvalidCertificates] = useState(
    () => localStorage.getItem(ALLOW_INVALID_CERTIFICATES_KEY) === 'true',
  );
  const [persistAcrossReboots, setPersistAcrossReboots] = useState(
    () => localStorage.getItem(PERSIST_ACROSS_REBOOTS_KEY) === 'true',
  );
  // The persistence choice only changes behavior on Linux (keyutils vs Secret
  // Service). Windows/macOS keystores are already silent and durable, so the
  // control is hidden there to avoid implying the session might not be remembered.
  const [isLinux, setIsLinux] = useState(false);
  useEffect(() => {
    let active = true;
    // Defensive: any failure or absent host-OS probe simply hides the toggle.
    Promise.resolve()
      .then(() => tauriCommands.hostOs?.())
      .then((os) => {
        if (active) setIsLinux(os === 'linux');
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const { isLoading: busy, connect: connectServer, reconnect: reconnectServer } = useServerStore();

  function persistInputs() {
    localStorage.setItem(SERVER_URL_KEY, serverUrl);
    localStorage.setItem(USERNAME_KEY, username);
    localStorage.setItem(ALLOW_INVALID_CERTIFICATES_KEY, String(allowInvalidCertificates));
    localStorage.setItem(PERSIST_ACROSS_REBOOTS_KEY, String(persistAcrossReboots));
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    persistInputs();
    try {
      await connectServer(
        serverUrl,
        username,
        String(form.get('password')),
        allowInvalidCertificates,
        persistAcrossReboots,
      );
      toast.success('Connected to Collab server');
      onConnected?.();
    } catch (reason) {
      toast.error(String(reason));
    }
  }

  async function reconnect() {
    persistInputs();
    try {
      await reconnectServer(serverUrl, allowInvalidCertificates, persistAcrossReboots);
      toast.success('Server session restored');
      onConnected?.();
    } catch (reason) {
      toast.error(String(reason));
    }
  }

  return (
    <form className="space-y-3" onSubmit={connect}>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Server URL</span>
        <Input
          value={serverUrl}
          onChange={(event) => setServerUrl(event.target.value)}
          placeholder="https://collab.example.com"
          required
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Username</span>
        <Input
          name="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          required
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Password</span>
        <Input name="password" type="password" autoComplete="current-password" required />
      </label>
      <label className="flex items-start gap-2 rounded-lg border border-border/50 bg-card/30 p-3">
        <Checkbox
          aria-label="Allow untrusted TLS certificates"
          checked={allowInvalidCertificates}
          onCheckedChange={(checked) => setAllowInvalidCertificates(checked === true)}
        />
        <span>
          <span className="block text-xs font-medium">Allow untrusted TLS certificates</span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            For private servers using a self-signed certificate. This disables certificate
            verification for this server connection.
          </span>
        </span>
      </label>
      {isLinux && (
        <label className="flex items-start gap-2 rounded-lg border border-border/50 bg-card/30 p-3">
          <Checkbox
            aria-label="Keep me signed in across reboots"
            checked={persistAcrossReboots}
            onCheckedChange={(checked) => setPersistAcrossReboots(checked === true)}
          />
          <span>
            <span className="block text-xs font-medium">Keep me signed in across reboots</span>
            <span className="mt-1 block text-[11px] text-muted-foreground">
              Stores the session in your system keyring so it survives a reboot. May prompt to
              unlock the keyring. When off, you stay signed in until the next reboot without any
              prompts.
            </span>
          </span>
        </label>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy}>
          Connect
        </Button>
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={busy || !serverUrl}
          onClick={reconnect}
        >
          Restore saved session
        </Button>
      </div>
    </form>
  );
}
