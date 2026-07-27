import { CalendarX2, ChevronRight, Cloud, KeyRound, LogOut, Pencil, Plus, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { FormEvent, useMemo, useState } from 'react';

import { Banner, EmptyState, Spinner, StatusDot } from '../components/ui';
import { normalizeServerUrl, type KnownServer } from '../lib/servers';
import { useMobileStore } from '../state/store';

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function ServersScreen({ onOpenServer }: { onOpenServer: (serverUrl: string) => void }) {
  const servers = useMobileStore((s) => s.servers);
  const statuses = useMobileStore((s) => s.statuses);
  const restoringServers = useMobileStore((s) => s.restoringServers);
  const connect = useMobileStore((s) => s.connect);
  const reauthenticate = useMobileStore((s) => s.reauthenticate);
  const reconnect = useMobileStore((s) => s.reconnect);
  const disconnect = useMobileStore((s) => s.disconnect);
  const calendarCacheOrigins = useMobileStore((s) => s.calendarCacheOrigins);
  const removeCalendarCachesForServer = useMobileStore((s) => s.removeCalendarCachesForServer);

  const [showForm, setShowForm] = useState(servers.length === 0);
  const [serverUrl, setServerUrl] = useState('https://');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [allowInvalid, setAllowInvalid] = useState(false);
  const [offlineCopyMode, setOfflineCopyMode] = useState<NonNullable<KnownServer['offlineCopyMode']>>('inherit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [reauthServer, setReauthServer] = useState<KnownServer | null>(null);
  const [reauthPassword, setReauthPassword] = useState('');
  const [reauthBusy, setReauthBusy] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);

  function beginEdit(server: (typeof servers)[number]) {
    const normalized = normalizeServerUrl(server.serverUrl);
    setEditingServer(normalized);
    setServerUrl(normalized);
    setUsername(server.username);
    setPassword('');
    setAllowInvalid(server.allowInvalidCertificates);
    setOfflineCopyMode(server.offlineCopyMode ?? 'inherit');
    setShowForm(false);
  }

  function beginAdd() {
    setEditingServer(null);
    setServerUrl('https://');
    setUsername('');
    setPassword('');
    setAllowInvalid(false);
    setOfflineCopyMode('inherit');
    setShowForm(true);
  }

  const connectedCount = useMemo(
    () => Object.values(statuses).filter((status) => status.connected).length,
    [statuses],
  );
  const restoringCount = Object.keys(restoringServers).length;

  async function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await connect(serverUrl, username.trim(), password, {
        allowInvalidCertificates: allowInvalid,
        persistAcrossReboots: true,
        offlineCopyMode,
      });
      const normalizedNext = normalizeServerUrl(serverUrl);
      if (editingServer && editingServer !== normalizedNext) await disconnect(editingServer);
      setPassword('');
      setEditingServer(null);
      setShowForm(false);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function withPending(serverUrl: string, action: () => Promise<void>) {
    setPending(serverUrl);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(null);
    }
  }

  function beginReauthentication(server: KnownServer) {
    setReauthServer(server);
    setReauthPassword('');
    setReauthError(null);
  }

  function closeReauthentication() {
    if (reauthBusy) return;
    setReauthServer(null);
    setReauthPassword('');
    setReauthError(null);
  }

  async function handleReauthentication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reauthServer || !reauthPassword) return;
    setReauthBusy(true);
    setReauthError(null);
    try {
      await reauthenticate(reauthServer.serverUrl, reauthPassword);
      setReauthServer(null);
      setReauthPassword('');
    } catch (reason) {
      setReauthError(errorMessage(reason));
    } finally {
      setReauthBusy(false);
    }
  }

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <h1>Servers</h1>
          <p>
            {restoringCount > 0
              ? `Connecting to ${restoringCount} server${restoringCount === 1 ? '' : 's'}…`
              : connectedCount > 0
                ? `${connectedCount} connected`
                : 'Not connected'}
          </p>
        </div>
        {!showForm && !editingServer ? (
          <button className="header-action" type="button" onClick={beginAdd}>
            <Plus size={18} aria-hidden />
            Add
          </button>
        ) : null}
      </header>

      {error ? <Banner tone="error">{error}</Banner> : null}

      {showForm && !editingServer ? (
        <form className="card form-card" onSubmit={handleConnect}>
          <div className="card-title">
            <Cloud size={18} aria-hidden />
            <span>Connect to a hosted server</span>
          </div>
          <label className="field">
            <span>Server URL</span>
            <input
              value={serverUrl}
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="https://collab.example.com"
              onChange={(event) => setServerUrl(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Username</span>
            <input
              value={username}
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              value={password}
              type="password"
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="toggle-field">
            <input
              type="checkbox"
              checked={allowInvalid}
              onChange={(event) => setAllowInvalid(event.target.checked)}
            />
            <span>
              <strong>Allow untrusted certificate</strong>
              <em>Only for private servers with a self-signed certificate.</em>
            </span>
          </label>
          <div className="form-actions">
            {servers.length > 0 ? (
              <button
                type="button"
                className="ghost-button"
                onClick={() => { setShowForm(false); setEditingServer(null); }}
                disabled={busy}
              >
                Cancel
              </button>
            ) : null}
            <button
              type="submit"
              className="primary-button"
              disabled={busy || !serverUrl.trim() || !username.trim() || !password}
            >
              {busy ? <Spinner /> : <Cloud size={18} aria-hidden />}
              Sign in
            </button>
          </div>
        </form>
      ) : null}

      {servers.length === 0 && !showForm ? (
        <EmptyState
          icon={<Cloud size={28} aria-hidden />}
          title="No servers yet"
          message="Add a hosted Collab server to browse its vaults on this device."
        />
      ) : null}

      <ul className="list">
        {servers.map((server) => {
          const key = normalizeServerUrl(server.serverUrl);
          const status = statuses[key];
          const online = !!status?.connected;
          const restoring = restoringServers[key] === true;
          const isPending = pending === key;
          const editing = editingServer === key;
          const hasCalendarCache = calendarCacheOrigins.some(
            (origin) => normalizeServerUrl(origin.serverUrl) === key,
          );
          return (
            <li className={`server-list-item ${editing ? 'editing' : ''}`} key={key}>
              <div className="list-row server-row">
                <button
                  type="button"
                  className="row-main"
                  disabled={!online || editing}
                  onClick={() => onOpenServer(key)}
                >
                  {restoring ? <Spinner size={16} /> : <StatusDot online={online} />}
                  <div className="row-text">
                    <strong>{key.replace(/^https?:\/\//, '')}</strong>
                    <span>
                      {restoring
                        ? 'Connecting…'
                        : online
                        ? status?.user?.displayName || status?.user?.username || server.username
                        : 'Disconnected'}
                      {server.allowInvalidCertificates ? ' · untrusted TLS' : ''}
                      {server.offlineCopyMode === 'always' ? ' · offline copies' : ''}
                    </span>
                  </div>
                  {online && !editing ? <ChevronRight size={18} aria-hidden className="row-chevron" /> : null}
                </button>
                <div className="row-actions">
                  {hasCalendarCache ? (
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={`Remove cached calendars from ${key}`}
                      title="Remove cached calendars"
                      disabled={isPending || editing}
                      onClick={() => {
                        if (!window.confirm(`Remove cached calendars from ${key.replace(/^https?:\/\//, '')}? Server data is not changed.`)) return;
                        void withPending(key, () => removeCalendarCachesForServer(key));
                      }}
                    >
                      {isPending ? <Spinner size={16} /> : <CalendarX2 size={16} aria-hidden />}
                    </button>
                  ) : null}
                  {!online && !restoring ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Sign in again to ${key}`}
                      title="Sign in again"
                      disabled={isPending || editing}
                      onClick={() => beginReauthentication(server)}
                    >
                      <KeyRound size={16} aria-hidden />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={`icon-button ${editing ? 'active' : ''}`}
                    aria-label={`Edit ${key}`}
                    disabled={isPending || restoring}
                    onClick={() => editing ? setEditingServer(null) : beginEdit(server)}
                  >
                    <Pencil size={16} aria-hidden />
                  </button>
                  {online ? (
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label="Disconnect"
                      disabled={isPending || editing}
                      onClick={() => withPending(key, () => disconnect(key))}
                    >
                      {isPending ? <Spinner size={16} /> : <LogOut size={16} aria-hidden />}
                    </button>
                  ) : !restoring ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Reconnect"
                      disabled={isPending || editing}
                      onClick={() => withPending(key, () => reconnect(key))}
                    >
                      {isPending ? <Spinner size={16} /> : <RefreshCw size={16} aria-hidden />}
                    </button>
                  ) : null}
                </div>
              </div>
              {editing ? (
                <form className="server-inline-editor" aria-label={`Edit ${key}`} onSubmit={handleConnect}>
                  <label className="field">
                    <span>Server URL</span>
                    <input value={serverUrl} inputMode="url" autoCapitalize="none" autoCorrect="off" onChange={(event) => setServerUrl(event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Username</span>
                    <input value={username} autoCapitalize="none" autoCorrect="off" onChange={(event) => setUsername(event.target.value)} />
                  </label>
                  <label className="field">
                    <span>Password</span>
                    <input value={password} type="password" autoCapitalize="none" autoCorrect="off" placeholder="Required to apply changes" onChange={(event) => setPassword(event.target.value)} />
                  </label>
                  <label className="toggle-field compact-toggle">
                    <input type="checkbox" checked={allowInvalid} onChange={(event) => setAllowInvalid(event.target.checked)} />
                    <span><strong>Allow untrusted certificate</strong><em>Only for private, trusted deployments.</em></span>
                  </label>
                  <fieldset className="server-offline-mode">
                    <legend>Automatic offline copies</legend>
                    <div className="segmented-control">
                      {(['inherit', 'always', 'never'] as const).map((mode) => (
                        <button key={mode} type="button" className={offlineCopyMode === mode ? 'selected' : ''} onClick={() => setOfflineCopyMode(mode)}>
                          {mode === 'inherit' ? 'Default' : mode === 'always' ? 'Always' : 'Never'}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <div className="form-actions">
                    <button type="button" className="ghost-button" disabled={busy} onClick={() => setEditingServer(null)}>Cancel</button>
                    <button type="submit" className="primary-button" disabled={busy || !serverUrl.trim() || !username.trim() || !password}>
                      {busy ? <Spinner /> : <Pencil size={17} aria-hidden />} Apply changes
                    </button>
                  </div>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>

      {servers.some((server) => server.allowInvalidCertificates) ? (
        <p className="footnote">
          <ShieldAlert size={14} aria-hidden /> Untrusted-certificate servers verify TLS loosely.
          Use only for private deployments you trust.
        </p>
      ) : null}

      {reauthServer ? (
        <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeReauthentication();
        }}>
          <form
            className="sheet reauthentication-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`Sign in again to ${normalizeServerUrl(reauthServer.serverUrl)}`}
            onSubmit={handleReauthentication}
          >
            <div className="sheet-handle" />
            <div className="sheet-head">
              <KeyRound size={20} aria-hidden />
              <div className="row-text">
                <strong>Sign in again</strong>
                <span>{reauthServer.username} on {normalizeServerUrl(reauthServer.serverUrl)}</span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close sign in"
                disabled={reauthBusy}
                onClick={closeReauthentication}
              >
                <X size={18} aria-hidden />
              </button>
            </div>
            <p className="sheet-note">
              Your server settings, offline copies, and cached calendars will be kept.
            </p>
            <label className="field">
              <span>Password</span>
              <input
                autoFocus
                value={reauthPassword}
                type="password"
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                disabled={reauthBusy}
                onChange={(event) => setReauthPassword(event.target.value)}
              />
            </label>
            {reauthError ? <Banner tone="error">{reauthError}</Banner> : null}
            <div className="form-actions">
              <button type="button" className="ghost-button" disabled={reauthBusy} onClick={closeReauthentication}>
                Cancel
              </button>
              <button type="submit" className="primary-button" disabled={reauthBusy || !reauthPassword}>
                {reauthBusy ? <Spinner /> : <KeyRound size={18} aria-hidden />}
                Sign in
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
