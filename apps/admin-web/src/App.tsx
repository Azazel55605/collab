import {
  Activity,
  Archive,
  Ban,
  Boxes,
  CircleAlert,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  File as FileIcon,
  Folder,
  FolderOpen,
  Gauge,
  History,
  KeyRound,
  LogOut,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SunMoon,
  Trash2,
  Upload,
  UserCheck,
  UserCog,
  UserX,
  Users,
} from 'lucide-react';
import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { serverApi } from './api';
import { useAutoRefresh } from './useAutoRefresh';
import { useAdminAppearance, type AdminAccent, type AdminTheme } from './theme';
import type {
  AdminBackupOverview,
  AdminBackupVerification,
  AdminOverview,
  AdminServerSettings,
  AuditEvent,
  GrantSubjectType,
  HostedVaultActivityEvent,
  HostedVaultAdminDetail,
  HostedChatMessage,
  HostedFileEntry,
  HostedFileRevision,
  HostedVaultMember,
  HostedVaultStorage,
  HostedVaultSummary,
  Invitation,
  MaintenanceReport,
  PermissionTemplate,
  ServerUser,
  UserGroup,
  UserGroupMember,
  VaultGrant,
} from './types';
import { ALL_CAPABILITIES, CAPABILITY_GROUPS, capabilityLabel } from './types';
import { Badge, Button, Card, Checkbox, ConfirmDialog, DialogShell, Input, PromptDialog, SelectMenu, Separator, Switch } from './ui';

type View = 'dashboard' | 'users' | 'vaults' | 'permissions' | 'backups' | 'audit' | 'settings';

export function isSelectedFile(value: FormDataEntryValue | null): value is File {
  return value instanceof globalThis.File && value.size > 0;
}

export async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

export function App() {
  const invitationToken = new URLSearchParams(window.location.search).get('invite');
  const [bootRequired, setBootRequired] = useState<boolean | null>(null);
  const [me, setMe] = useState<ServerUser | null>(null);
  const [error, setError] = useState('');

  const refreshSession = useCallback(async () => {
    setError('');
    try {
      const status = await serverApi.bootstrapStatus();
      setBootRequired(status.required);
      if (!status.required) setMe(await serverApi.me().catch(() => null));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not reach the server.');
    }
  }, []);

  useEffect(() => {
    if (!invitationToken) void refreshSession();
  }, [invitationToken, refreshSession]);

  if (invitationToken) return <InvitationScreen token={invitationToken} />;
  if (error && bootRequired === null) return <CenteredMessage title={error} />;
  if (bootRequired === null) return <CenteredMessage title="Connecting to Collab server..." />;
  if (bootRequired) return <AuthScreen mode="bootstrap" onAuthenticated={(user) => { setBootRequired(false); setMe(user); }} />;
  if (!me) return <AuthScreen mode="login" onAuthenticated={setMe} />;
  if (me.role !== 'admin') return <AccessDenied onLogout={() => setMe(null)} />;
  return <AdminShell me={me} onMeChange={setMe} onLogout={() => setMe(null)} />;
}

function InvitationScreen({ token }: { token: string }) {
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get('password');
    try {
      await serverApi.acceptInvitation(token, String(password));
      window.history.replaceState({}, '', '/admin/');
      setDone(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not accept the invitation.');
    }
  }
  if (done) return <CenteredMessage title="Invitation accepted. Reload to continue." />;
  return <main className="auth-page"><Card className="auth-card"><div className="logo-mark"><KeyRound size={24} /></div><h1>Accept invitation</h1><p className="subtle">Choose a password of at least 12 characters for your Collab account.</p><form onSubmit={accept}><Field label="New password" name="password" type="password" autoComplete="new-password" minLength={12} required />{error && <div className="error-banner"><CircleAlert size={16} />{error}</div>}<Button>Create account</Button></form></Card></main>;
}

function AccessDenied({ onLogout }: { onLogout: () => void }) {
  async function logout() {
    await serverApi.logout().catch(() => undefined);
    onLogout();
  }
  return (
    <main className="auth-page">
      <Card className="auth-card">
        <div className="logo-mark"><ShieldCheck size={24} /></div>
        <h1>Administrator access required</h1>
        <p className="subtle">This account can use Collab, but it cannot manage the server.</p>
        <Button onClick={logout}>Sign out</Button>
      </Card>
    </main>
  );
}

function AuthScreen({
  mode,
  onAuthenticated,
}: {
  mode: 'bootstrap' | 'login';
  onAuthenticated: (user: ServerUser) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const action = mode === 'bootstrap' ? serverApi.bootstrap : serverApi.login;
      const session = await action({
        username: form.get('username'),
        displayName: form.get('displayName') || form.get('username'),
        password: form.get('password'),
        admin: true,
      });
      onAuthenticated(session.user);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Authentication failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <Card className="auth-card">
        <div className="logo-mark"><Boxes size={24} /></div>
        <p className="eyebrow">COLLAB SERVER</p>
        <h1>{mode === 'bootstrap' ? 'Create the first administrator' : 'Welcome back'}</h1>
        <p className="subtle">
          {mode === 'bootstrap'
            ? 'This one-time account controls server users and future hosted vaults.'
            : 'Sign in to manage this Collab server.'}
        </p>
        <form onSubmit={submit}>
          {mode === 'bootstrap' && <Field label="Display name" name="displayName" autoComplete="name" />}
          <Field label="Username" name="username" autoComplete="username" required />
          <Field label="Password" name="password" type="password" autoComplete={mode === 'bootstrap' ? 'new-password' : 'current-password'} required />
          {error && <div className="error-banner"><CircleAlert size={16} />{error}</div>}
          <Button disabled={busy}>{busy ? 'Working...' : mode === 'bootstrap' ? 'Create administrator' : 'Sign in'}</Button>
        </form>
      </Card>
    </main>
  );
}

function AdminShell({ me, onMeChange, onLogout }: { me: ServerUser; onMeChange: (user: ServerUser) => void; onLogout: () => void }) {
  const [view, setView] = useState<View>('dashboard');
  const { appearance, setAppearance } = useAdminAppearance();
  const [accountOpen, setAccountOpen] = useState(false);
  // Seed appearance from the account's saved preferences once on mount, so a
  // user's chosen theme follows their account across browsers.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    const saved = (me.preferences as { appearance?: Partial<typeof appearance> } | null | undefined)?.appearance;
    if (saved) setAppearance((current) => ({ ...current, ...saved }));
  }, [me, setAppearance, appearance]);

  // Appearance changes apply immediately (localStorage) and persist to the
  // account's server-side preferences.
  const persistAppearance: typeof setAppearance = useCallback((updater) => {
    setAppearance((current) => {
      const next = typeof updater === 'function' ? (updater as (value: typeof current) => typeof current)(current) : updater;
      void serverApi.updateSelf({ preferences: { ...(me.preferences ?? {}), appearance: next } }).catch(() => undefined);
      return next;
    });
  }, [me, setAppearance]);

  async function logout() {
    await serverApi.logout().catch(() => undefined);
    onLogout();
  }
  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <div className="brand"><span className="logo-mark small"><Boxes size={18} /></span><div><strong>Collab</strong><small>Server admin</small></div></div>
        <nav aria-label="Administration">
          <NavButton active={view === 'dashboard'} icon={<Gauge />} label="Dashboard" onClick={() => setView('dashboard')} />
          <NavButton active={view === 'users'} icon={<Users />} label="Users" onClick={() => setView('users')} />
          <NavButton active={view === 'vaults'} icon={<Boxes />} label="Vaults" onClick={() => setView('vaults')} />
          <NavButton active={view === 'permissions'} icon={<ShieldCheck />} label="Permissions" onClick={() => setView('permissions')} />
          <NavButton active={view === 'backups'} icon={<Archive />} label="Backups" onClick={() => setView('backups')} />
          <NavButton active={view === 'audit'} icon={<Activity />} label="Audit log" onClick={() => setView('audit')} />
          <NavButton active={view === 'settings'} icon={<Settings />} label="Settings" onClick={() => setView('settings')} />
        </nav>
        <div className="profile">
          <button type="button" className="profile-button" aria-label="Account settings" onClick={() => setAccountOpen(true)}>
            <Avatar user={me} size={32} />
            <div><strong>{me.displayName}</strong><small>{me.username}</small></div>
          </button>
          <Button variant="ghost" size="icon" title="Sign out" onClick={logout}><LogOut size={17} /></Button>
        </div>
      </aside>
      <main className="content">
        {view === 'dashboard' && <Dashboard />}
        {view === 'users' && <UsersPage currentUser={me} />}
        {view === 'vaults' && <VaultsPage />}
        {view === 'permissions' && <PermissionsPage />}
        {view === 'backups' && <BackupsPage />}
        {view === 'audit' && <AuditPage />}
        {view === 'settings' && <SettingsPage appearance={appearance} onChange={persistAppearance} />}
      </main>
      {accountOpen && (
        <AccountDialog
          me={me}
          appearance={appearance}
          onAppearanceChange={persistAppearance}
          onClose={() => setAccountOpen(false)}
          onUpdated={onMeChange}
        />
      )}
    </div>
  );
}

function SettingsPage({
  appearance,
  onChange,
}: {
  appearance: ReturnType<typeof useAdminAppearance>['appearance'];
  onChange: ReturnType<typeof useAdminAppearance>['setAppearance'];
}) {
  const themes: Array<{ value: AdminTheme; label: string; detail: string }> = [
    { value: 'dark', label: 'Dark', detail: 'Balanced dark workspace' },
    { value: 'midnight', label: 'Midnight', detail: 'Deep, low-contrast surfaces' },
    { value: 'warm', label: 'Warm', detail: 'Soft charcoal and amber tones' },
    { value: 'light', label: 'Light', detail: 'Bright neutral workspace' },
  ];
  const accents: AdminAccent[] = ['violet', 'blue', 'emerald', 'rose', 'orange', 'cyan'];
  return (
    <>
      <PageHeader eyebrow="PREFERENCES" title="Settings" subtitle="Tune the administration interface to match your Collab workspace." />
      <Panel title="Appearance" icon={<SunMoon size={17} />}>
        <div className="settings-stack">
          <div className="settings-row">
            <div><strong>Theme</strong><small>Choose the base surface palette.</small></div>
            <SelectMenu
              label="Theme"
              value={appearance.theme}
              options={themes.map((theme) => ({ value: theme.value, label: theme.label }))}
              onChange={(value) => onChange((current) => ({ ...current, theme: value as AdminTheme }))}
            />
          </div>
          <Separator />
          <div className="settings-row settings-row-top">
            <div><strong>Accent color</strong><small>Used for focus, selection, and primary actions.</small></div>
            <div className="accent-picker" role="group" aria-label="Accent color">
              {accents.map((accent) => <Button key={accent} variant={appearance.accent === accent ? 'default' : 'outline'} size="icon" className={`accent-swatch accent-${accent}`} aria-label={accent} title={accent} onClick={() => onChange((current) => ({ ...current, accent }))}><span /></Button>)}
            </div>
          </div>
          <Separator />
          <div className="settings-row">
            <div><strong>Compact density</strong><small>Reduce spacing in data-heavy server views.</small></div>
            <Switch label="Compact density" checked={appearance.compact} onCheckedChange={(compact) => onChange((current) => ({ ...current, compact }))} />
          </div>
        </div>
      </Panel>
      <Panel title="Preview" icon={<Gauge size={17} />}>
        <div className="appearance-preview">
          <div><Badge variant="success">Server healthy</Badge><h2>{themes.find((theme) => theme.value === appearance.theme)?.label} administration</h2><p className="subtle">The interface updates immediately and persists in this browser.</p></div>
          <Button>Primary action</Button>
        </div>
      </Panel>
      <ServerConfigurationPanel />
    </>
  );
}

function ServerConfigurationPanel() {
  const [settings, setSettings] = useState<AdminServerSettings | null>(null);
  const [draft, setDraft] = useState({
    browserSecureCookies: false,
    sessionTtlHours: 12,
    nativeAccessTtlMinutes: 15,
    nativeRefreshTtlDays: 30,
    wsTicketTtlSeconds: 30,
    maxFileBytes: '256 MiB',
    maxImportBytes: '512 MiB',
    maxImportExpandedBytes: '2 GiB',
    storageWarningBytes: '10 GiB',
    storageQuotaBytes: '0',
    revisionHistoryLimit: 0,
    revisionStorageTargetBytes: '0',
    scheduleEnabled: false,
    intervalSeconds: 86_400,
    retentionDays: 14,
    exportDir: '',
    maintenanceEnabled: false,
    maintenanceMessage: '',
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [maintenance, setMaintenance] = useState<MaintenanceReport | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [liveDebug, setLiveDebug] = useState<boolean | null>(null);
  const [liveDebugBusy, setLiveDebugBusy] = useState(false);
  const applySettings = useCallback((next: AdminServerSettings) => {
    setSettings(next);
    setDraft({
      browserSecureCookies: next.runtime.browserSecureCookies.value,
      sessionTtlHours: next.runtime.sessionTtlHours.value,
      nativeAccessTtlMinutes: next.runtime.nativeAccessTtlMinutes.value,
      nativeRefreshTtlDays: next.runtime.nativeRefreshTtlDays.value,
      wsTicketTtlSeconds: next.runtime.wsTicketTtlSeconds.value,
      maxFileBytes: formatByteSize(next.runtime.maxFileBytes.value),
      maxImportBytes: formatByteSize(next.runtime.maxImportBytes.value),
      maxImportExpandedBytes: formatByteSize(next.runtime.maxImportExpandedBytes.value),
      storageWarningBytes: formatByteSize(next.runtime.storageWarningBytes.value),
      storageQuotaBytes: formatByteSize(next.runtime.storageQuotaBytes.value),
      revisionHistoryLimit: next.runtime.revisionHistoryLimit.value,
      revisionStorageTargetBytes: formatByteSize(next.runtime.revisionStorageTargetBytes.value),
      scheduleEnabled: next.backup.scheduleEnabled,
      intervalSeconds: next.backup.intervalSeconds,
      retentionDays: next.backup.retentionDays,
      exportDir: next.backup.exportDir ?? '',
      maintenanceEnabled: next.maintenance.enabled,
      maintenanceMessage: next.maintenance.message ?? '',
    });
  }, []);
  const load = useCallback(() => serverApi.settings().then((next) => { applySettings(next); setError(''); }).catch((reason) => setError(String(reason))), [applySettings]);
  useEffect(() => void load(), [load]);
  useEffect(() => { serverApi.liveDebug().then((s) => setLiveDebug(s.enabled)).catch(() => setLiveDebug(false)); }, []);

  async function toggleLiveDebug(enabled: boolean) {
    setLiveDebugBusy(true);
    try {
      const result = await serverApi.setLiveDebug(enabled);
      setLiveDebug(result.enabled);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLiveDebugBusy(false);
    }
  }

  async function saveCurrentSettings() {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const next = await serverApi.updateSettings({
        runtime: {
          browserSecureCookies: draft.browserSecureCookies,
          sessionTtlHours: draft.sessionTtlHours,
          nativeAccessTtlMinutes: draft.nativeAccessTtlMinutes,
          nativeRefreshTtlDays: draft.nativeRefreshTtlDays,
          wsTicketTtlSeconds: draft.wsTicketTtlSeconds,
          maxFileBytes: draft.maxFileBytes,
          maxImportBytes: draft.maxImportBytes,
          maxImportExpandedBytes: draft.maxImportExpandedBytes,
          storageWarningBytes: draft.storageWarningBytes,
          storageQuotaBytes: draft.storageQuotaBytes,
          revisionHistoryLimit: draft.revisionHistoryLimit,
          revisionStorageTargetBytes: draft.revisionStorageTargetBytes,
        },
        backup: {
          scheduleEnabled: draft.scheduleEnabled,
          intervalSeconds: draft.intervalSeconds,
          retentionDays: draft.retentionDays,
          exportDir: draft.exportDir.trim() || null,
        },
        maintenance: {
          enabled: draft.maintenanceEnabled,
          message: draft.maintenanceMessage.trim() || null,
        },
      });
      applySettings(next);
      setMessage('Server settings saved.');
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    await saveCurrentSettings();
  }

  async function runMaintenance() {
    setMaintenanceBusy(true);
    setError('');
    setMessage('');
    try {
      const report = await serverApi.runMaintenance();
      setMaintenance(report);
      setMessage('Maintenance pass complete.');
    } catch (reason) {
      setError(String(reason));
    } finally {
      setMaintenanceBusy(false);
    }
  }

  if (!settings) {
    return <Panel title="Server configuration" icon={<Server size={17} />}><Loading /></Panel>;
  }
  const runtime = settings.runtime;
  const backup = settings.backup;
  return (
    <Panel title="Server configuration" icon={<Server size={17} />}>
      <form className="settings-stack" onSubmit={save}>
        {error && <div className="error-banner"><CircleAlert size={16} />{error}</div>}
        {message && <div className="success-banner" role="status"><ShieldCheck size={16} />{message}</div>}
        <p className="subtle">Settings marked as environment overrides are locked because their `COLLAB_*` variable is configured. Remove the variable and restart the container to make that field editable from the admin UI.</p>
        <div className="settings-grid">
          <SettingField label="Browser secure cookies" setting={runtime.browserSecureCookies} type="checkbox" checked={draft.browserSecureCookies} onChange={(event) => setDraft((current) => ({ ...current, browserSecureCookies: event.target.checked }))} />
          <SettingField label="Session TTL hours" setting={runtime.sessionTtlHours} type="number" min={1} max={720} value={draft.sessionTtlHours} onChange={(event) => setDraft((current) => ({ ...current, sessionTtlHours: Number(event.target.value) || 1 }))} />
          <SettingField label="Native access TTL minutes" setting={runtime.nativeAccessTtlMinutes} type="number" min={1} max={1440} value={draft.nativeAccessTtlMinutes} onChange={(event) => setDraft((current) => ({ ...current, nativeAccessTtlMinutes: Number(event.target.value) || 1 }))} />
          <SettingField label="Native refresh TTL days" setting={runtime.nativeRefreshTtlDays} type="number" min={1} max={365} value={draft.nativeRefreshTtlDays} onChange={(event) => setDraft((current) => ({ ...current, nativeRefreshTtlDays: Number(event.target.value) || 1 }))} />
          <SettingField label="WebSocket ticket TTL seconds" setting={runtime.wsTicketTtlSeconds} type="number" min={1} max={600} value={draft.wsTicketTtlSeconds} onChange={(event) => setDraft((current) => ({ ...current, wsTicketTtlSeconds: Number(event.target.value) || 1 }))} />
          <SettingField label="Max file size" setting={runtime.maxFileBytes} type="text" placeholder="e.g. 256 MiB" value={draft.maxFileBytes} onChange={(event) => setDraft((current) => ({ ...current, maxFileBytes: event.target.value }))} />
          <SettingField label="Max ZIP import size" setting={runtime.maxImportBytes} type="text" placeholder="e.g. 512 MiB" value={draft.maxImportBytes} onChange={(event) => setDraft((current) => ({ ...current, maxImportBytes: event.target.value }))} />
          <SettingField label="Max expanded ZIP size" setting={runtime.maxImportExpandedBytes} type="text" placeholder="e.g. 2 GiB" value={draft.maxImportExpandedBytes} onChange={(event) => setDraft((current) => ({ ...current, maxImportExpandedBytes: event.target.value }))} />
          <SettingField label="Storage warning size" setting={runtime.storageWarningBytes} type="text" placeholder="e.g. 10 GiB" value={draft.storageWarningBytes} onChange={(event) => setDraft((current) => ({ ...current, storageWarningBytes: event.target.value }))} />
          <SettingField label="Storage quota (0 = unlimited)" setting={runtime.storageQuotaBytes} type="text" placeholder="e.g. 50 GiB or 0" value={draft.storageQuotaBytes} onChange={(event) => setDraft((current) => ({ ...current, storageQuotaBytes: event.target.value }))} />
          <SettingField label="File history versions (0 = unlimited)" setting={runtime.revisionHistoryLimit} type="number" min={0} max={1_000_000} value={draft.revisionHistoryLimit} onChange={(event) => setDraft((current) => ({ ...current, revisionHistoryLimit: Number(event.target.value) || 0 }))} />
          <SettingField label="File history storage target (0 = disabled)" setting={runtime.revisionStorageTargetBytes} type="text" placeholder="e.g. 20 GiB or 0" value={draft.revisionStorageTargetBytes} onChange={(event) => setDraft((current) => ({ ...current, revisionStorageTargetBytes: event.target.value }))} />
        </div>
        <Separator />
        <div className="settings-grid">
          <LockedFieldMeta locked={backup.locks.scheduleEnabled} envVar="COLLAB_BACKUP_SCHEDULE_ENABLED" source={backup.locks.scheduleEnabled ? 'env' : 'gui/default'}>
            <label className="toggle-row"><input type="checkbox" disabled={backup.locks.scheduleEnabled} checked={draft.scheduleEnabled} onChange={(event) => setDraft((current) => ({ ...current, scheduleEnabled: event.target.checked }))} /> Enable scheduled backups</label>
          </LockedFieldMeta>
          <LockedFieldMeta locked={backup.locks.intervalSeconds} envVar="COLLAB_BACKUP_INTERVAL_SECONDS" source={backup.locks.intervalSeconds ? 'env' : 'gui/default'}>
            <Field label="Backup interval seconds" type="number" min={60} step={60} disabled={backup.locks.intervalSeconds} value={draft.intervalSeconds} onChange={(event) => setDraft((current) => ({ ...current, intervalSeconds: Number(event.target.value) || 60 }))} />
          </LockedFieldMeta>
          <LockedFieldMeta locked={backup.locks.retentionDays} envVar="COLLAB_BACKUP_RETENTION_DAYS" source={backup.locks.retentionDays ? 'env' : 'gui/default'}>
            <Field label="Backup retention days" type="number" min={0} disabled={backup.locks.retentionDays} value={draft.retentionDays} onChange={(event) => setDraft((current) => ({ ...current, retentionDays: Number(event.target.value) || 0 }))} />
          </LockedFieldMeta>
          <LockedFieldMeta locked={backup.locks.exportDir} envVar="COLLAB_BACKUP_EXPORT_DIR" source={backup.locks.exportDir ? 'env' : 'gui/default'}>
            <Field label="Backup export path" placeholder="/backup-export" disabled={backup.locks.exportDir} value={draft.exportDir} onChange={(event) => setDraft((current) => ({ ...current, exportDir: event.target.value }))} />
          </LockedFieldMeta>
        </div>
        <div className="actions"><Button type="submit" size="sm" disabled={busy}>Save server settings</Button></div>
      </form>
      <Separator />
      <div className="settings-stack">
        <div className="settings-row">
          <div>
            <strong>Maintenance mode</strong>
            <small>Pause hosted-vault writes and live WebSocket sessions while keeping reads, health checks, auth, backups, and admin controls available.</small>
          </div>
          <Switch label="Maintenance mode" checked={draft.maintenanceEnabled} onCheckedChange={(enabled) => setDraft((current) => ({ ...current, maintenanceEnabled: enabled }))} />
        </div>
        <Field label="Maintenance message" maxLength={500} placeholder="Short upgrade window, please retry in a few minutes." value={draft.maintenanceMessage} onChange={(event) => setDraft((current) => ({ ...current, maintenanceMessage: event.target.value }))} />
        {settings.maintenance.updatedAt && <p className="subtle">Last changed {new Date(settings.maintenance.updatedAt).toLocaleString()}.</p>}
        {draft.maintenanceEnabled && <div className="warning-row"><CircleAlert size={16} /><div><strong>Maintenance mode enabled</strong><small>Mutating hosted-vault API calls and live collaboration WebSocket sessions will receive a temporary maintenance response.</small></div></div>}
        <div className="actions"><Button type="button" size="sm" disabled={busy} onClick={() => void saveCurrentSettings()}>Save maintenance mode</Button></div>
      </div>
      <Separator />
      <div className="settings-stack">
        <p className="subtle">Retention and compaction runs automatically on a schedule. Run it now to immediately clear expired sessions/tickets, prune logs beyond their retention window, compact document revision history, and reclaim orphaned blob storage.</p>
        <div className="actions"><Button type="button" variant="outline" size="sm" disabled={maintenanceBusy} onClick={runMaintenance}>Run maintenance now</Button></div>
        {maintenance && (
          <p className="subtle">
            Reclaimed {maintenance.prunedRevisions} revision(s) and {formatBytes(maintenance.reclaimedBlobBytes)} across {maintenance.reclaimedBlobs} blob(s);
            cleared {maintenance.expiredWsTickets} ticket(s), {maintenance.expiredSessions} session(s), {maintenance.stalePresence} presence row(s);
            pruned {maintenance.prunedAuditEvents + maintenance.prunedActivityEvents} log event(s).
          </p>
        )}
      </div>
      <Separator />
      <div className="settings-stack">
        <div className="settings-row">
          <div>
            <strong>Live collaboration debug tracing</strong>
            <small>Emit verbose <code>info</code> logs of live co-editing subscribe/apply/broadcast/forward events to the server log — for diagnosing sync problems. Process-local, resets on restart, off by default.</small>
          </div>
          <Switch
            label="Live collaboration debug tracing"
            checked={liveDebug ?? false}
            onCheckedChange={(enabled) => {
              if (liveDebug === null || liveDebugBusy) return;
              void toggleLiveDebug(enabled);
            }}
          />
        </div>
      </div>
    </Panel>
  );
}

function SettingField<T extends string | number | boolean>({
  label,
  setting,
  ...inputProps
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; setting: { envVar: string; locked: boolean; source: string } }) {
  return (
    <LockedFieldMeta locked={setting.locked} envVar={setting.envVar} source={setting.source}>
      <Field label={label} disabled={setting.locked} {...inputProps} />
    </LockedFieldMeta>
  );
}

function LockedFieldMeta({ children, locked, envVar, source }: { children: React.ReactNode; locked: boolean; envVar: string; source: string }) {
  return (
    <div className={locked ? 'locked-setting' : ''}>
      {children}
      <small className="setting-source">{locked ? `Locked by ${envVar}` : `Source: ${source}`}</small>
    </div>
  );
}

function Dashboard() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => serverApi.overview().then((data) => { setOverview(data); setError(''); }).catch((reason) => setError(String(reason))), []);
  useEffect(() => void load(), [load]);
  useAutoRefresh(load, { intervalMs: 3_000 });
  return (
    <>
      <PageHeader eyebrow="OPERATIONS" title="Server dashboard" subtitle="A quiet overview of identities, sessions, and server activity." action={<IconButton label="Refresh dashboard" onClick={load}><RefreshCw size={16} /></IconButton>} />
      {error && <div className="error-banner"><CircleAlert size={16} />{error}</div>}
      {!overview ? <Loading /> : <>
        <div className="metric-grid">
          <Metric icon={<ShieldCheck />} label="Server health" value={overview.health} detail={`${Math.floor(overview.uptimeSeconds / 60)} minutes uptime`} />
          <Metric icon={<Users />} label="Active users" value={overview.activeUsers} detail={`${overview.users} total`} />
          <Metric icon={<KeyRound />} label="Active sessions" value={overview.activeSessions} detail="Revocable browser sessions" />
          <Metric icon={<Boxes />} label="Hosted vaults" value={overview.hostedVaults} detail="Canonical hosted vaults" />
          <Metric icon={<Server />} label="Server version" value={`v${overview.serverVersion}`} detail={`Protocol ${overview.protocolVersion}`} />
          <Metric
            icon={<Database />}
            label="Storage"
            value={formatBytes(overview.storage.databaseBytes + overview.storage.blobBytes)}
            detail={`${formatBytes(overview.storage.databaseBytes)} database · ${formatBytes(overview.storage.blobBytes)} blobs${overview.storage.warningThresholdBytes > 0 ? ` · warns at ${formatBytes(overview.storage.warningThresholdBytes)}` : ''}`}
          />
          <Metric
            icon={<Database />}
            label="Stored content"
            value={formatBytes(overview.storage.storedContentBytes)}
            detail={overview.storage.quotaBytes > 0 ? `${formatBytes(overview.storage.quotaBytes)} quota` : 'Deduplicated · no quota set'}
          />
          <Metric icon={<KeyRound />} label="Pending invitations" value={overview.pendingInvitations} detail="One-time expiring links" />
        </div>
        <Panel title="Live collaboration" icon={<Activity size={17} />}>
          <div className="storage-grid">
            <Metric icon={<Activity />} label="Live connections" value={overview.liveCollaboration.activeConnections} detail="Open WebSocket sessions" />
            <Metric icon={<Boxes />} label="Loaded rooms" value={overview.liveCollaboration.loadedRooms} detail={`${overview.liveCollaboration.activeAwarenessStates} awareness states`} />
            <Metric icon={<Users />} label="Active presence" value={overview.liveCollaboration.activePresenceUsers} detail="Hosted users seen in the last 30 seconds" />
            <Metric icon={<Gauge />} label="Update rate" value={overview.liveCollaboration.updatesLastMinute} detail="Durable updates in the last minute" />
            <Metric icon={<Database />} label="CRDT update log" value={overview.liveCollaboration.pendingUpdateCount} detail={`${formatBytes(overview.liveCollaboration.pendingUpdateBytes)} pending compaction`} />
            <Metric
              icon={<Database />}
              label="Compacted documents"
              value={overview.liveCollaboration.compactedDocuments}
              detail={`${formatBytes(overview.liveCollaboration.compactedStateBytes)} compacted${overview.liveCollaboration.lastCompactionAt ? ` · ${new Date(overview.liveCollaboration.lastCompactionAt).toLocaleString()}` : ''}`}
            />
          </div>
        </Panel>
        {overview.operationalWarnings.length > 0 && <Panel title="Operational warnings" icon={<CircleAlert size={17} />}><div className="warning-list">{overview.operationalWarnings.map((warning) => <div className={`warning-row ${warning.severity}`} key={warning.code}><CircleAlert size={16} /><div><strong>{warning.code.replaceAll('_', ' ')}</strong><small>{warning.message}</small></div></div>)}</div></Panel>}
        <Panel title="Recent activity" icon={<Activity size={17} />}><AuditTable events={overview.recentAuditEvents} /></Panel>
      </>}
    </>
  );
}

function BackupsPage() {
  const [overview, setOverview] = useState<AdminBackupOverview | null>(null);
  const [verification, setVerification] = useState<Record<string, AdminBackupVerification>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [settingsDraft, setSettingsDraft] = useState({
    scheduleEnabled: false,
    intervalSeconds: 86_400,
    retentionDays: 14,
    exportDir: '',
  });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const applyOverview = useCallback((data: AdminBackupOverview) => {
    setOverview(data);
    setSettingsDraft({
      scheduleEnabled: data.settings.scheduleEnabled,
      intervalSeconds: data.settings.intervalSeconds,
      retentionDays: data.settings.retentionDays,
      exportDir: data.settings.exportDir ?? '',
    });
  }, []);
  const load = useCallback(() => serverApi.backups().then((data) => { applyOverview(data); setError(''); }).catch((reason) => setError(String(reason))), [applyOverview]);
  useEffect(() => void load(), [load]);
  useAutoRefresh(load, { intervalMs: 10_000 });

  async function runBackup() {
    setBusy('run');
    setMessage('');
    setError('');
    try {
      const result = await serverApi.runBackup();
      setMessage(result.output ? `${result.message} ${result.output}` : result.message);
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy('');
    }
  }

  async function verify(name: string) {
    setBusy(`verify:${name}`);
    setError('');
    try {
      const result = await serverApi.verifyBackup(name);
      setVerification((current) => ({ ...current, [name]: result }));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy('');
    }
  }

  async function exportBackup(name: string) {
    setBusy(`export:${name}`);
    setError('');
    setMessage('');
    try {
      const blob = await serverApi.exportBackup(name);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${name}.tar.gz`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage(`Exported ${name}.`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy('');
    }
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy('import');
    setMessage('');
    setError('');
    try {
      const archiveBase64 = await fileToBase64(file);
      const next = await serverApi.importBackup(archiveBase64);
      applyOverview(next);
      setMessage(`Imported ${file.name}.`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy('');
    }
  }

  async function restore(name: string) {
    setBusy(`restore:${name}`);
    setMessage('');
    setError('');
    try {
      const result = await serverApi.restoreBackup(name);
      setMessage(result.output ? `${result.message} ${result.output}` : result.message);
      setConfirmRestore(null);
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy('');
    }
  }

  async function deleteBackup(name: string) {
    setBusy(`delete:${name}`);
    setError('');
    try {
      await serverApi.deleteBackup(name);
      setConfirmDelete(null);
      setVerification((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy('');
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setBusy('settings');
    setMessage('');
    setError('');
    try {
      const next = await serverApi.updateBackupSettings({
        scheduleEnabled: settingsDraft.scheduleEnabled,
        intervalSeconds: settingsDraft.intervalSeconds,
        retentionDays: settingsDraft.retentionDays,
        exportDir: settingsDraft.exportDir.trim() || null,
      });
      applyOverview(next);
      setMessage('Backup settings saved.');
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="RECOVERY"
        title="Backups"
        subtitle="Inspect, verify, and manage deployment backups visible to the server."
        action={<div className="actions"><input ref={importInputRef} type="file" accept=".tar.gz,.tgz,application/gzip,application/x-gzip" hidden onChange={(event) => void importBackup(event)} /><Button variant="outline" size="sm" disabled={busy === 'import'} onClick={() => importInputRef.current?.click()}><Upload size={16} />Import</Button><Button variant="outline" size="sm" onClick={load}><RefreshCw size={16} />Refresh</Button><Button size="sm" disabled={!overview?.backupCommandConfigured || busy === 'run'} onClick={runBackup}><Archive size={16} />Run backup</Button></div>}
      />
      {error && <div className="error-banner"><CircleAlert size={16} />{error}</div>}
      {message && <div className="success-banner" role="status"><ShieldCheck size={16} />{message}</div>}
      {!overview ? <Loading /> : <>
        <div className="metric-grid">
          <Metric icon={<Archive />} label="Backups" value={overview.backups.length} detail={overview.backupDir} />
          <Metric icon={<Server />} label="Run command" value={overview.backupCommandConfigured ? 'Configured' : 'Disabled'} detail="Optional operator hook" />
          <Metric icon={<RotateCcw />} label="Restore command" value={overview.restoreCommandConfigured ? 'Configured' : 'Disabled'} detail="Requires explicit confirmation" />
          <Metric icon={<History />} label="Schedule" value={overview.schedule.enabled ? 'Enabled' : 'Disabled'} detail={`${formatDuration(overview.schedule.intervalSeconds)} interval · ${overview.schedule.retentionDays === 0 ? 'no pruning' : `${overview.schedule.retentionDays}d retention`}`} />
          <Metric icon={<Download />} label="External export" value={!overview.exportTarget.configured ? 'Not set' : overview.exportTarget.writable ? 'Ready' : 'Needs attention'} detail={overview.exportTarget.path ?? 'Mount SMB/NFS/USB and set export path'} />
        </div>
        <Panel title="Schedule and export" icon={<History size={17} />}>
          <form className="settings-grid" onSubmit={saveSettings}>
            <div>
              <label>Scheduler</label>
              <p className="subtle">{overview.schedule.enabled ? `Server-managed backups run every ${formatDuration(overview.schedule.intervalSeconds)}.` : 'Scheduled backups are disabled. Enable them here to let the server run backups automatically.'}</p>
              <label className="toggle-row"><input type="checkbox" disabled={overview.settings.locks.scheduleEnabled} checked={settingsDraft.scheduleEnabled} onChange={(event) => setSettingsDraft((current) => ({ ...current, scheduleEnabled: event.target.checked }))} /> Enable scheduled backups</label>
              {overview.settings.locks.scheduleEnabled && <small className="setting-source">Locked by COLLAB_BACKUP_SCHEDULE_ENABLED</small>}
            </div>
            <div>
              <label>Retention</label>
              <p className="subtle">{overview.schedule.retentionDays === 0 ? 'Automatic pruning is disabled.' : `Backups older than ${overview.schedule.retentionDays} days are pruned.`}</p>
              <div className="inline-fields">
                <Field label="Interval seconds" type="number" min={60} step={60} disabled={overview.settings.locks.intervalSeconds} value={settingsDraft.intervalSeconds} onChange={(event) => setSettingsDraft((current) => ({ ...current, intervalSeconds: Number(event.target.value) || 60 }))} />
                <Field label="Retention days" type="number" min={0} disabled={overview.settings.locks.retentionDays} value={settingsDraft.retentionDays} onChange={(event) => setSettingsDraft((current) => ({ ...current, retentionDays: Number(event.target.value) || 0 }))} />
              </div>
              {(overview.settings.locks.intervalSeconds || overview.settings.locks.retentionDays) && <small className="setting-source">One or more retention fields are locked by environment variables.</small>}
            </div>
            <div>
              <label>External export target</label>
              <p className="subtle">{overview.exportTarget.message}</p>
              <Field label="Container export path" placeholder="/backup-export" disabled={overview.settings.locks.exportDir} value={settingsDraft.exportDir} onChange={(event) => setSettingsDraft((current) => ({ ...current, exportDir: event.target.value }))} />
              {overview.settings.locks.exportDir && <small className="setting-source">Locked by COLLAB_BACKUP_EXPORT_DIR</small>}
            </div>
            <div className="actions"><Button type="submit" size="sm" disabled={busy === 'settings'}>Save backup settings</Button></div>
          </form>
        </Panel>
        {!overview.backupCommandConfigured && (
          <Panel title="Operator hook required" icon={<CircleAlert size={17} />}>
            <p className="subtle">The server can list, verify, and delete backup artifacts. Running or restoring backups from the web UI is disabled until `COLLAB_BACKUP_COMMAND` or `COLLAB_RESTORE_COMMAND` is configured by the operator.</p>
          </Panel>
        )}
        <Panel title="Backup artifacts" icon={<Database size={17} />}>
          {overview.backups.length === 0 ? <p className="subtle">No backups found in {overview.backupDir}.</p> : (
            <div className="audit-list">
              {overview.backups.map((backup) => {
                const result = verification[backup.name];
                const complete = backup.hasPostgresDump && backup.hasBlobArchive && backup.hasManifest && backup.hasChecksums;
                return (
                  <div className="backup-row" key={backup.name}>
                    <div className="grow">
                      <strong>{backup.name}</strong>
                      <small>{backup.createdAt ? new Date(backup.createdAt).toLocaleString() : 'Unknown creation time'} · {formatBytes(backup.sizeBytes)}</small>
                      <div className="capability-chips">
                        <Badge variant={complete ? 'success' : 'destructive'}>{complete ? 'Complete' : 'Incomplete'}</Badge>
                        {backup.hasConfig && <span className="request-chip">config</span>}
                        {result && <Badge variant={result.ok ? 'success' : 'destructive'}>{result.ok ? 'Verified' : 'Failed verification'}</Badge>}
                      </div>
                      {result && (
                        <div className="backup-artifacts">
                          {result.artifacts.map((artifact) => (
                            <span className={`request-chip ${artifact.ok ? '' : 'danger'}`} key={artifact.path}>{artifact.path}: {artifact.ok ? 'ok' : artifact.error ?? 'failed'}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="actions">
                      <Button variant="outline" size="sm" disabled={busy === `verify:${backup.name}`} onClick={() => void verify(backup.name)}>Verify</Button>
                      <Button variant="outline" size="sm" disabled={!complete || busy === `export:${backup.name}`} onClick={() => void exportBackup(backup.name)}><Download size={14} />Export</Button>
                      <Button variant="outline" size="sm" disabled={!overview.restoreCommandConfigured || busy === `restore:${backup.name}`} onClick={() => setConfirmRestore(backup.name)}>Restore</Button>
                      <Button variant="destructive" size="sm" disabled={busy === `delete:${backup.name}`} onClick={() => setConfirmDelete(backup.name)}>Delete</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </>}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete backup?"
          description={`Delete ${confirmDelete} from the server backup volume. This cannot be undone.`}
          confirmLabel="Delete backup"
          destructive
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void deleteBackup(confirmDelete)}
        />
      )}
      {confirmRestore && (
        <ConfirmDialog
          title="Restore backup?"
          description={`Run the configured restore command for ${confirmRestore}. This is destructive and should only be used with an operator-controlled restore wrapper.`}
          confirmLabel="Restore backup"
          destructive
          onCancel={() => setConfirmRestore(null)}
          onConfirm={() => void restore(confirmRestore)}
        />
      )}
    </>
  );
}

function UsersPage({ currentUser }: { currentUser: ServerUser }) {
  const [users, setUsers] = useState<ServerUser[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [invitationLink, setInvitationLink] = useState('');
  const [activity, setActivity] = useState<{ user: ServerUser; events: AuditEvent[] } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ServerUser | null>(null);
  const [resetTarget, setResetTarget] = useState<ServerUser | null>(null);
  const [editTarget, setEditTarget] = useState<ServerUser | null>(null);
  const [roleTarget, setRoleTarget] = useState<ServerUser | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [nextUsers, nextInvitations] = await Promise.all([serverApi.users(), serverApi.invitations()]);
      setUsers(nextUsers);
      setInvitations(nextInvitations);
      setError('');
    } catch (reason) { setError(String(reason)); }
  }, []);
  useEffect(() => void load(), [load]);
  useAutoRefresh(load);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await serverApi.createUser({
        username: form.get('username'),
        displayName: form.get('displayName'),
        password: form.get('password'),
        admin: form.get('admin') === 'on',
      });
      setShowCreate(false);
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const created = await serverApi.createInvitation({
        username: form.get('username'),
        displayName: form.get('displayName'),
        admin: form.get('admin') === 'on',
        expiresInHours: Number(form.get('expiresInHours')),
      });
      setInvitationLink(`${window.location.origin}/admin/?invite=${created.token}`);
      await load();
    } catch (reason) { setError(String(reason)); }
  }
  async function revokeInvitation(invitation: Invitation) {
    try {
      await serverApi.revokeInvitation(invitation.id);
      if (invitationLink.includes(`invite=`)) setInvitationLink('');
      await load();
    } catch (reason) { setError(String(reason)); }
  }
  async function setDisabled(user: ServerUser, disabled: boolean) {
    try {
      await serverApi.updateUser(user.id, { disabled });
      await load();
    } catch (reason) { setError(String(reason)); }
  }
  async function deleteAccount(user: ServerUser) {
    try {
      await serverApi.deleteUser(user.id);
      if (activity?.user.id === user.id) setActivity(null);
      await load();
    } catch (reason) { setError(String(reason)); }
  }
  async function setRole(user: ServerUser, role: 'admin' | 'member') {
    try {
      await serverApi.updateUser(user.id, { role });
      await load();
    } catch (reason) { setError(String(reason)); }
  }
  const query = search.trim().toLowerCase();
  const visibleUsers = query
    ? users.filter((user) => user.displayName.toLowerCase().includes(query) || user.username.toLowerCase().includes(query))
    : users;
  const invitationStatus = (invitation: Invitation) =>
    invitation.acceptedAt
      ? 'accepted'
      : invitation.revokedAt
        ? 'revoked'
        : new Date(invitation.expiresAt) < new Date()
          ? 'expired'
          : 'pending';
  return (
    <>
      <PageHeader eyebrow="IDENTITY" title="Users" subtitle="Create accounts, issue invitations, and manage access." action={<div className="actions"><Button variant="outline" size="sm" onClick={() => setShowInvite(!showInvite)}>Invite user</Button><Button size="sm" onClick={() => setShowCreate(!showCreate)}><Plus size={16} />Add user</Button></div>} />
      {error && <div className="error-banner"><CircleAlert size={16} />{error}</div>}
      {showCreate && <Panel title="Create user" icon={<Plus size={17} />}><form className="inline-form" onSubmit={create}><Field label="Display name" name="displayName" required /><Field label="Username" name="username" required /><Field label="Temporary password" name="password" type="password" required /><label className="check"><Checkbox name="admin" /> Administrator</label><Button size="sm">Create user</Button></form></Panel>}
      {showInvite && <Panel title="Invite user" icon={<KeyRound size={17} />}><form className="inline-form" onSubmit={invite}><Field label="Display name" name="displayName" required /><Field label="Username" name="username" required /><Field label="Expires in hours" name="expiresInHours" type="number" min={1} max={720} defaultValue={72} required /><label className="check"><Checkbox name="admin" /> Administrator</label><Button size="sm">Create link</Button></form>{invitationLink && <div className="invitation-link" role="status"><code>{invitationLink}</code><Button variant="outline" size="sm" onClick={() => navigator.clipboard?.writeText(invitationLink)}>Copy</Button></div>}</Panel>}
      <Panel title={`${users.length} server users`} icon={<Users size={17} />}>
        <label className="list-search">
          <Search size={15} />
          <Input type="search" value={search} placeholder="Search users by name or username" aria-label="Search users" onChange={(event) => setSearch(event.target.value)} />
        </label>
        <div className="user-list">{visibleUsers.map((user) => <div className="user-row" key={user.id}><Avatar user={user} /><div className="grow"><strong>{user.displayName}</strong><small>{user.username} · {user.role}{user.isPrimaryAdmin ? ' · primary administrator' : ''}</small></div><Badge variant={user.role === 'admin' ? 'success' : 'outline'}>{user.role}</Badge><Badge variant={user.status === 'active' ? 'success' : 'destructive'}>{user.status}</Badge><span className="session-count">{user.activeSessions} sessions</span><div className="compact-actions user-actions"><Button aria-label="Edit" title="Edit" variant="outline" size="icon" onClick={() => setEditTarget(user)}><Pencil size={15} /></Button>{user.role === 'admin' ? <Button aria-label="Make member" title="Make member" variant="outline" size="icon" disabled={user.id === currentUser.id || user.isPrimaryAdmin} onClick={() => setRoleTarget(user)}><UserCog size={15} /></Button> : <Button aria-label="Make admin" title="Make admin" variant="outline" size="icon" onClick={() => setRoleTarget(user)}><ShieldCheck size={15} /></Button>}<Button aria-label="Activity" title="Activity" variant="outline" size="icon" onClick={async () => setActivity({ user, events: await serverApi.userActivity(user.id) })}><Activity size={15} /></Button><Button aria-label="Reset password" title="Reset password" variant="outline" size="icon" onClick={() => setResetTarget(user)}><KeyRound size={15} /></Button>{user.status === 'disabled' ? <Button aria-label="Re-enable" title="Re-enable" variant="outline" size="icon" disabled={user.isPrimaryAdmin} onClick={() => setDisabled(user, false)}><UserCheck size={15} /></Button> : <Button aria-label="Disable" title="Disable" variant="outline" size="icon" disabled={user.id === currentUser.id || user.isPrimaryAdmin} onClick={() => setDisabled(user, true)}><Ban size={15} /></Button>}<Button aria-label="Revoke sessions" title="Revoke sessions" variant="outline" size="icon" onClick={async () => { await serverApi.revokeSessions(user.id); await load(); }}><LogOut size={15} /></Button><Button aria-label="Delete account" title="Delete account" variant="destructive" size="icon" disabled={user.id === currentUser.id || user.isPrimaryAdmin} onClick={() => setConfirmDelete(user)}><UserX size={15} /></Button></div></div>)}{visibleUsers.length === 0 && <p className="subtle">No users match this search.</p>}</div>
      </Panel>
      <Panel title={`${invitations.length} invitations`} icon={<KeyRound size={17} />}>
        <div className="audit-list">
          {invitations.map((invitation) => {
            const status = invitationStatus(invitation);
            return (
              <div className="audit-row" key={invitation.id}>
                <div className="grow">
                  <strong>{invitation.displayName}</strong>
                  <small>{invitation.username} · expires {new Date(invitation.expiresAt).toLocaleString()}</small>
                </div>
                <span className="request-chip">{status}</span>
                {status === 'pending' && (
                  <Button aria-label={`Revoke invitation for ${invitation.username}`} title="Revoke invitation" variant="outline" size="sm" onClick={() => void revokeInvitation(invitation)}>
                    <Ban size={14} />Revoke
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </Panel>
      {activity && (
        <DialogShell
          title={`${activity.user.displayName} activity`}
          description={`Recent account events for ${activity.user.username}.`}
          onClose={() => setActivity(null)}
          className="ui-dialog-wide"
        >
          <AuditTable events={activity.events} />
          <div className="ui-dialog-actions"><Button variant="outline" onClick={() => setActivity(null)}>Close</Button></div>
        </DialogShell>
      )}
      {confirmDelete && (
        <ConfirmDialog
          destructive
          title={`Delete ${confirmDelete.username}?`}
          description="The account is permanently deleted. This cannot be undone."
          confirmLabel="Delete account"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const user = confirmDelete;
            setConfirmDelete(null);
            void deleteAccount(user);
          }}
        />
      )}
      {resetTarget && (
        <PromptDialog
          title={`Reset password for ${resetTarget.username}`}
          description="Every session of this user is revoked and the new password takes effect immediately."
          label="New password"
          type="password"
          minLength={12}
          submitLabel="Reset password"
          onCancel={() => setResetTarget(null)}
          onSubmit={async (password) => {
            const user = resetTarget;
            setResetTarget(null);
            try {
              await serverApi.resetPassword(user.id, password);
              await load();
            } catch (reason) {
              setError(String(reason));
            }
          }}
        />
      )}
      {editTarget && (
        <EditUserDialog
          user={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => { setEditTarget(null); void load(); }}
        />
      )}
      {roleTarget && (
        <ConfirmDialog
          title={roleTarget.role === 'admin' ? `Demote ${roleTarget.username} to member?` : `Promote ${roleTarget.username} to administrator?`}
          description={roleTarget.role === 'admin'
            ? 'They lose access to every server administration capability and can only use Collab as a member.'
            : 'They gain full server administration access, including users, vaults, permissions, backups, and settings.'}
          confirmLabel={roleTarget.role === 'admin' ? 'Make member' : 'Make administrator'}
          onCancel={() => setRoleTarget(null)}
          onConfirm={() => {
            const user = roleTarget;
            setRoleTarget(null);
            void setRole(user, user.role === 'admin' ? 'member' : 'admin');
          }}
        />
      )}
    </>
  );
}

function VaultsPage() {
  const [vaults, setVaults] = useState<HostedVaultSummary[]>([]);
  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [forceDelete, setForceDelete] = useState<HostedVaultSummary | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => serverApi.vaults().then((data) => { setVaults(data); setError(''); }).catch((reason) => setError(String(reason))), []);
  useEffect(() => void load(), [load]);
  useAutoRefresh(load);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    try {
      await serverApi.createVault({ name: form.get('name') });
      setShowCreate(false);
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  }
  if (selectedVaultId) {
    return <VaultDetailPage vaultId={selectedVaultId} onBack={() => { setSelectedVaultId(null); void load(); }} />;
  }
  const query = search.trim().toLowerCase();
  const visibleVaults = query
    ? vaults.filter((vault) => vault.name.toLowerCase().includes(query) || vault.ownerDisplayName.toLowerCase().includes(query))
    : vaults;
  return (
    <>
      <PageHeader
        eyebrow="HOSTED CONTENT"
        title="Vaults"
        subtitle="Canonical hosted vaults with storage, membership, and lifecycle controls."
        action={<Button size="sm" onClick={() => setShowCreate(!showCreate)}><Plus size={16} />New vault</Button>}
      />
      {error && <div className="error-banner"><CircleAlert size={16} />{error}</div>}
      {showCreate && (
        <Panel title="Create vault" icon={<Plus size={17} />}>
          <form className="inline-form" onSubmit={create}>
            <Field label="Vault name" name="name" maxLength={128} required />
            <Button size="sm">Create vault</Button>
          </form>
          <p className="subtle">You become the vault owner and can add members from the vault detail view.</p>
        </Panel>
      )}
      {vaults.length > 0 && (
        <StorageBreakdown
          title="Storage by vault"
          icon={<Database size={17} />}
          unitLabel="vaults"
          emptyLabel="No vault is using storage yet."
          segments={vaults.map((vault) => ({ label: vault.name, bytes: vault.storageBytes }))}
        />
      )}
      {vaults.length === 0 ? (
        <div className="empty-state"><Boxes size={34} /><h2>No hosted vaults yet</h2><p>Create a vault here or from a connected Collab client and it will appear in this inventory.</p></div>
      ) : (
        <Panel title={`${vaults.length} hosted vaults`} icon={<Boxes size={17} />}>
          <label className="list-search">
            <Search size={15} />
            <Input type="search" value={search} placeholder="Search vaults by name or owner" aria-label="Search vaults" onChange={(event) => setSearch(event.target.value)} />
          </label>
          <div className="audit-list">
            {visibleVaults.map((vault) => (
              <div className="audit-row" key={vault.id}>
                <div className="grow"><strong>{vault.name}</strong><small>{vault.ownerDisplayName} · {vault.members} members · {formatBytes(vault.storageBytes)}</small></div>
                <span className={`status ${vault.status === 'active' ? 'active' : 'disabled'}`}>{vault.status.replace('_', ' ')}</span>
                <Button variant="outline" size="sm" aria-label={`Manage ${vault.name}`} onClick={() => setSelectedVaultId(vault.id)}>Manage</Button>
                {vault.status === 'pending_delete' && (
                  <Button variant="destructive" size="sm" aria-label={`Force delete ${vault.name}`} onClick={() => setForceDelete(vault)}>Force delete</Button>
                )}
              </div>
            ))}
            {visibleVaults.length === 0 && <p className="subtle">No vaults match this search.</p>}
          </div>
        </Panel>
      )}
      {forceDelete && (
        <ConfirmDialog
          destructive
          title={`Permanently delete ${forceDelete.name}?`}
          description="This irreversibly removes the vault and all of its files, revisions, members, grants, and history. This cannot be undone."
          confirmLabel="Force delete"
          onCancel={() => setForceDelete(null)}
          onConfirm={() => {
            const vault = forceDelete;
            setForceDelete(null);
            setError('');
            void serverApi.forceDeleteVault(vault.id).then(load).catch((reason) => setError(String(reason)));
          }}
        />
      )}
    </>
  );
}

function VaultDetailPage({ vaultId, onBack }: { vaultId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<HostedVaultAdminDetail | null>(null);
  const [members, setMembers] = useState<HostedVaultMember[]>([]);
  const [activity, setActivity] = useState<HostedVaultActivityEvent[]>([]);
  const [chatMessages, setChatMessages] = useState<HostedChatMessage[]>([]);
  const [storage, setStorage] = useState<HostedVaultStorage | null>(null);
  const [files, setFiles] = useState<HostedFileEntry[]>([]);
  const [manifestSequence, setManifestSequence] = useState(0);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [fileSearch, setFileSearch] = useState('');
  const [fileBrowserTab, setFileBrowserTab] = useState<'files' | 'trash'>('files');
  const [draggingFileId, setDraggingFileId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null | '__root__'>(null);
  const [users, setUsers] = useState<ServerUser[]>([]);
  const [newMemberId, setNewMemberId] = useState('');
  const [grants, setGrants] = useState<VaultGrant[]>([]);
  const [templates, setTemplates] = useState<PermissionTemplate[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [grantSubjectType, setGrantSubjectType] = useState<GrantSubjectType>('group');
  const [grantSubjectId, setGrantSubjectId] = useState('');
  const [grantEditor, setGrantEditor] = useState<{
    subjectType: GrantSubjectType;
    subjectId: string;
    subjectName: string;
    current: VaultGrant | null;
  } | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    label: string;
    action: () => Promise<unknown>;
  } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [importing, setImporting] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [forceDeleting, setForceDeleting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const [nextDetail, nextMembers, nextActivity, nextChatMessages, nextUsers, nextStorage, nextManifest, nextGrants, nextTemplates, nextGroups] = await Promise.all([
        serverApi.vaultDetail(vaultId),
        serverApi.vaultMembers(vaultId),
        serverApi.vaultActivity(vaultId),
        serverApi.vaultChat(vaultId).catch(() => []),
        serverApi.users(),
        serverApi.vaultStorage(vaultId).catch(() => null),
        serverApi.vaultFiles(vaultId),
        serverApi.vaultGrants(vaultId).catch(() => []),
        serverApi.templates().catch(() => []),
        serverApi.groups().catch(() => []),
      ]);
      setDetail(nextDetail);
      setMembers(nextMembers);
      setActivity(nextActivity);
      setChatMessages(nextChatMessages);
      setUsers(nextUsers);
      setStorage(nextStorage);
      setFiles(nextManifest.files);
      setManifestSequence(nextManifest.sequence);
      setGrants(nextGrants);
      setTemplates(nextTemplates);
      setGroups(nextGroups);
    } catch (reason) {
      setError(String(reason));
    }
  }, [vaultId]);
  useEffect(() => void load(), [load]);
  useAutoRefresh(load);

  async function run(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  }
  const memberIds = new Set(members.map((member) => member.userId));
  const candidates = users.filter((user) => user.status === 'active' && !memberIds.has(user.id));
  const memberChoice = candidates.some((user) => user.id === newMemberId)
    ? newMemberId
    : candidates[0]?.id ?? '';
  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!memberChoice) return;
    await run(() => serverApi.addVaultMember(vaultId, { userId: memberChoice, role: 'viewer' }));
    setNewMemberId('');
  }

  async function importVault(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setImporting(true);
    setError('');
    try {
      await serverApi.importVault(vaultId, await fileToBase64(file));
      await load();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setImporting(false);
    }
  }

  async function exportVault() {
    setError('');
    try {
      const blob = await serverApi.exportVault(vaultId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${detail?.name ?? 'collab-vault'}.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function downloadEntry(file: HostedFileEntry) {
    setError('');
    try {
      const blob = file.kind === 'folder'
        ? await serverApi.downloadFolder(vaultId, file.id)
        : await serverApi.downloadFile(vaultId, file.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.kind === 'folder' ? `${file.name}.zip` : file.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(String(reason));
    }
  }

  // Move a file/folder under a new parent via drag-and-drop. Guards against
  // no-op moves and dropping a folder into itself or one of its descendants.
  async function performMove(fileId: string, targetParentId: string | null) {
    const file = filesById.get(fileId);
    if (!file || file.state !== 'active') return;
    if ((file.parentId ?? null) === targetParentId) return;
    if (file.kind === 'folder' && targetParentId) {
      const target = filesById.get(targetParentId);
      if (target && (target.id === file.id || target.relativePath === file.relativePath || target.relativePath.startsWith(`${file.relativePath}/`))) {
        return;
      }
    }
    await run(() => serverApi.moveFile(vaultId, {
      clientOperationId: crypto.randomUUID(),
      baseManifestSequence: manifestSequence,
      operationType: 'move',
      targetFileId: fileId,
      parentId: targetParentId,
    }));
  }

  async function performTrashOperation(file: HostedFileEntry, operationType: 'restore' | 'purge') {
    await serverApi.moveFile(vaultId, {
      clientOperationId: crypto.randomUUID(),
      baseManifestSequence: manifestSequence,
      operationType,
      targetFileId: file.id,
    });
  }

  // Move an active file or folder to the vault trash (recoverable from the Trash
  // section below).
  async function trashEntry(file: HostedFileEntry) {
    await serverApi.moveFile(vaultId, {
      clientOperationId: crypto.randomUUID(),
      baseManifestSequence: manifestSequence,
      operationType: 'trash',
      targetFileId: file.id,
    });
  }

  function handleDropOnTarget(targetParentId: string | null) {
    const fileId = draggingFileId;
    setDraggingFileId(null);
    setDropTargetId(null);
    if (fileId) void performMove(fileId, targetParentId);
  }

  const filesById = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);
  // Aggregate each folder's size from its active descendant files by walking the
  // parent chain of every active file once.
  const folderSizes = useMemo(() => {
    const totals = new Map<string, number>();
    for (const file of files) {
      if (file.state !== 'active' || file.kind === 'folder') continue;
      const bytes = file.currentRevision?.sizeBytes ?? 0;
      if (!bytes) continue;
      let parentId = file.parentId ?? null;
      const guard = new Set<string>();
      while (parentId && !guard.has(parentId)) {
        guard.add(parentId);
        totals.set(parentId, (totals.get(parentId) ?? 0) + bytes);
        parentId = filesById.get(parentId)?.parentId ?? null;
      }
    }
    return totals;
  }, [files, filesById]);
  const currentFolder = currentFolderId ? filesById.get(currentFolderId) : null;
  const breadcrumbs = useMemo(() => {
    const folders: HostedFileEntry[] = [];
    let folder = currentFolder;
    while (folder) {
      folders.unshift(folder);
      folder = folder.parentId ? filesById.get(folder.parentId) : undefined;
    }
    return folders;
  }, [currentFolder, filesById]);
  const normalizedSearch = fileSearch.trim().toLocaleLowerCase();
  const activeFiles = useMemo(() => files.filter((file) => file.state === 'active'), [files]);
  const largestFiles = useMemo(
    () => activeFiles
      .filter((file) => file.kind !== 'folder' && (file.currentRevision?.sizeBytes ?? 0) > 0)
      .map((file) => ({ label: file.relativePath, bytes: file.currentRevision?.sizeBytes ?? 0 })),
    [activeFiles],
  );
  const visibleFiles = useMemo(() => {
    const matching = normalizedSearch
      ? activeFiles.filter((file) => file.relativePath.toLocaleLowerCase().includes(normalizedSearch))
      : activeFiles.filter((file) => file.parentId === currentFolderId);
    return [...matching].sort((left, right) => {
      if (left.kind === 'folder' && right.kind !== 'folder') return -1;
      if (left.kind !== 'folder' && right.kind === 'folder') return 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    });
  }, [activeFiles, currentFolderId, normalizedSearch]);
  const trashedFiles = useMemo(() => {
    const trashedIds = new Set(files.filter((file) => file.state === 'trashed').map((file) => file.id));
    return files
      .filter((file) => file.state === 'trashed' && (!file.parentId || !trashedIds.has(file.parentId)))
      .sort((left, right) => (right.trashedAt ?? '').localeCompare(left.trashedAt ?? ''));
  }, [files]);

  function openFolder(folderId: string | null) {
    setCurrentFolderId(folderId);
    setFileSearch('');
  }

  const pendingDelete = detail?.status === 'pending_delete';
  const lifecycleActions = detail && (
    <div className="actions">
      <Button variant="outline" size="sm" onClick={onBack}>Back to vaults</Button>
      <Button variant="outline" size="sm" onClick={() => setRenaming(true)}>Rename</Button>
      {detail.status === 'active' && <Button variant="outline" size="sm" onClick={() => run(() => serverApi.updateVault(vaultId, { status: 'archived' }))}>Archive vault</Button>}
      {detail.status === 'archived' && <Button variant="outline" size="sm" onClick={() => run(() => serverApi.updateVault(vaultId, { status: 'active' }))}>Reactivate vault</Button>}
      {pendingDelete ? (
        <>
          <Button variant="outline" size="sm" onClick={() => run(() => serverApi.updateVault(vaultId, { status: 'active' }))}>Restore vault</Button>
          <Button variant="destructive" size="sm" onClick={() => setForceDeleting(true)}>Force delete</Button>
        </>
      ) : (
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setConfirm({
            title: `Delete ${detail.name}?`,
            description: 'The vault is marked for deletion and stops accepting changes.',
            label: 'Delete vault',
            action: () => serverApi.deleteVault(vaultId),
          })}
        >
          Delete vault
        </Button>
      )}
    </div>
  );

  return (
    <>
      <PageHeader
        eyebrow="HOSTED CONTENT"
        title={detail?.name ?? 'Vault'}
        subtitle={detail ? `Owned by ${detail.ownerDisplayName} (${detail.ownerUsername}) · ${detail.status.replace('_', ' ')}` : 'Loading vault details...'}
        action={lifecycleActions ?? <Button variant="outline" size="sm" onClick={onBack}>Back to vaults</Button>}
      />
      {error && <div className="error-banner"><CircleAlert size={16} />{error}</div>}
      {!detail ? <Loading /> : <>
        <div className="metric-grid">
          <Metric icon={<Database />} label="Vault storage" value={formatBytes(detail.storageBytes)} detail="Sum of all stored revisions" />
          <Metric icon={<Boxes />} label="Active files" value={detail.activeFiles} detail={`${detail.trashedFiles} in trash`} />
          <Metric icon={<Users />} label="Members" value={detail.members} detail="Persisted vault memberships" />
          <Metric icon={<Activity />} label="Manifest sequence" value={detail.manifestSequence} detail={`Updated ${new Date(detail.updatedAt).toLocaleString()}`} />
        </div>
        <div className="detail-columns">
          <Panel title="Vault settings" icon={<Settings size={17} />}>
            <div className="settings-row">
              <div>
                <strong>Require offline copy</strong>
                <p className="subtle">Ask native clients to prepare this vault for offline use whenever they open it.</p>
              </div>
              <Button
                size="sm"
                variant={detail.requireOfflineCopy ? 'default' : 'outline'}
                disabled={pendingDelete}
                onClick={() => run(() => serverApi.updateVault(vaultId, { requireOfflineCopy: !detail.requireOfflineCopy }))}
              >
                {detail.requireOfflineCopy ? 'Offline copy required' : 'Require offline copy'}
              </Button>
            </div>
            <div className="settings-row">
              <div>
                <strong>File history</strong>
                <p className="subtle">
                  {storage ? `${storage.revisionCount} retained versions using ${formatBytes(storage.retainedRevisionBytes)}. Manage individual file versions from the History menu.` : 'Manage retained document versions from the file browser.'}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setFileBrowserTab('files'); setFilesOpen(true); }}
              >
                <History size={15} />Manage versions
              </Button>
            </div>
          </Panel>
          <Panel title="Vault files" icon={<Folder size={17} />}>
            <p className="subtle">{detail.activeFiles} active {detail.activeFiles === 1 ? 'file' : 'files'} · {detail.trashedFiles} in trash. Open the browser to navigate folders, move, download, delete, and manage trashed items.</p>
            <div className="panel-actions"><Button size="sm" onClick={() => setFilesOpen(true)}><FolderOpen size={16} />Browse files</Button></div>
          </Panel>
        </div>
        <Panel title="Storage and transfer" icon={<Database size={17} />}>
          {storage ? (
            <div className="storage-grid">
              <Metric icon={<Database />} label="Active content" value={formatBytes(storage.activeBytes)} detail={`${storage.activeFiles} active entries`} />
              <Metric icon={<Database />} label="Trash content" value={formatBytes(storage.trashBytes)} detail={`${storage.trashedFiles} trashed entries`} />
              <Metric icon={<Database />} label="Retained history" value={formatBytes(storage.retainedRevisionBytes)} detail={`${storage.revisionCount} revisions · ${storage.snapshotCount} snapshots`} />
              <Metric icon={<Database />} label="Unique blobs" value={formatBytes(storage.uniqueBlobBytes)} detail="Deduplicated within this vault" />
            </div>
          ) : (
            <p className="subtle">Detailed storage accounting requires this administrator to be a vault member.</p>
          )}
          <div className="transfer-actions">
            <input
              ref={importInputRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={(event) => void importVault(event)}
            />
            <Button
              size="sm"
              onClick={() => importInputRef.current?.click()}
              disabled={detail.status !== 'active' || detail.activeFiles > 0 || importing}
            >
              <Upload size={16} />{importing ? 'Importing...' : 'Import ZIP into empty vault'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void exportVault()} disabled={detail.status === 'pending_delete'}><Download size={16} />Export ZIP</Button>
          </div>
          <p className="subtle">Import requires an empty active vault. Server administrators can transfer content across every hosted vault.</p>
        </Panel>
        <StorageBreakdown
          title="Largest files"
          icon={<Database size={17} />}
          unitLabel="files"
          emptyLabel="No file content to chart yet."
          segments={largestFiles}
        />
        {filesOpen && (
          <DialogShell
            title="Vault files"
            description={`Browse, move, download, and manage files in ${detail.name}.`}
            onClose={() => setFilesOpen(false)}
            className="ui-dialog-files"
          >
          <div className="file-browser-toolbar">
            <nav className="file-breadcrumbs" aria-label="Vault file path">
              <Button
                variant="ghost"
                size="sm"
                className={dropTargetId === '__root__' ? 'drop-target' : ''}
                onClick={() => openFolder(null)}
                aria-current={currentFolderId === null ? 'page' : undefined}
                onDragOver={(event) => { if (draggingFileId) { event.preventDefault(); setDropTargetId('__root__'); } }}
                onDragLeave={() => setDropTargetId((current) => (current === '__root__' ? null : current))}
                onDrop={(event) => { event.preventDefault(); handleDropOnTarget(null); }}
              >
                <FolderOpen size={15} />Vault root
              </Button>
              {breadcrumbs.map((folder) => (
                <span key={folder.id}>
                  <ChevronRight size={14} />
                  <Button
                    variant="ghost"
                    size="sm"
                    className={dropTargetId === folder.id ? 'drop-target' : ''}
                    onClick={() => openFolder(folder.id)}
                    aria-current={currentFolderId === folder.id ? 'page' : undefined}
                    onDragOver={(event) => { if (draggingFileId && draggingFileId !== folder.id) { event.preventDefault(); setDropTargetId(folder.id); } }}
                    onDragLeave={() => setDropTargetId((current) => (current === folder.id ? null : current))}
                    onDrop={(event) => { event.preventDefault(); handleDropOnTarget(folder.id); }}
                  >{folder.name}</Button>
                </span>
              ))}
            </nav>
            <label className="file-search">
              <Search size={15} />
              <Input
                type="search"
                value={fileSearch}
                placeholder="Search all vault files"
                aria-label="Search vault files"
                onChange={(event) => setFileSearch(event.target.value)}
              />
            </label>
          </div>
          <div className="file-browser-tabs" role="tablist" aria-label="Vault file browser sections">
            <Button
              type="button"
              variant={fileBrowserTab === 'files' ? 'default' : 'outline'}
              size="sm"
              role="tab"
              aria-selected={fileBrowserTab === 'files'}
              onClick={() => setFileBrowserTab('files')}
            >
              <Folder size={15} />Files
            </Button>
            <Button
              type="button"
              variant={fileBrowserTab === 'trash' ? 'default' : 'outline'}
              size="sm"
              role="tab"
              aria-selected={fileBrowserTab === 'trash'}
              onClick={() => setFileBrowserTab('trash')}
            >
              <Trash2 size={15} />Trash ({trashedFiles.length})
            </Button>
          </div>
          <div className="files-modal-body">
          {fileBrowserTab === 'files' && <>
            <p className="subtle file-browser-summary">
              {normalizedSearch
                ? `${visibleFiles.length} matches across the vault`
                : `${visibleFiles.length} entries in ${currentFolder?.relativePath ?? 'Vault root'} · drag a row onto a folder to move it`}
            </p>
            <div className="file-browser">
            <div className="file-row file-header">
              <span>{normalizedSearch ? 'Path' : 'Name'}</span><span>Size</span><span>Modified</span><span>State</span><span>Actions</span>
            </div>
            {!normalizedSearch && currentFolder && (
              <div
                className={['file-row', 'file-row-up', dropTargetId === (currentFolder.parentId ?? '__root__') && draggingFileId ? 'drop-target' : ''].filter(Boolean).join(' ')}
                onDragOver={(event) => { if (draggingFileId) { event.preventDefault(); setDropTargetId(currentFolder.parentId ?? '__root__'); } }}
                onDragLeave={() => setDropTargetId((current) => (current === (currentFolder.parentId ?? '__root__') ? null : current))}
                onDrop={(event) => { event.preventDefault(); handleDropOnTarget(currentFolder.parentId ?? null); }}
              >
                <div className="file-name">
                  <FolderOpen size={16} />
                  <span><button type="button" className="file-open-button" onClick={() => openFolder(currentFolder.parentId ?? null)}>.. (up one level)</button></span>
                </div>
                <span>—</span><span>—</span><span /><span />
              </div>
            )}
            {visibleFiles.map((file) => {
              const draggable = file.state === 'active' && !normalizedSearch;
              const isFolderDropTarget = file.kind === 'folder' && dropTargetId === file.id && draggingFileId !== null && draggingFileId !== file.id;
              return (
                <div
                  className={['file-row', draggingFileId === file.id ? 'dragging' : '', isFolderDropTarget ? 'drop-target' : ''].filter(Boolean).join(' ')}
                  key={file.id}
                  draggable={draggable}
                  onDragStart={draggable ? (event) => { setDraggingFileId(file.id); event.dataTransfer.effectAllowed = 'move'; } : undefined}
                  onDragEnd={() => { setDraggingFileId(null); setDropTargetId(null); }}
                  onDragOver={file.kind === 'folder' ? (event) => {
                    if (draggingFileId && draggingFileId !== file.id) { event.preventDefault(); setDropTargetId(file.id); }
                  } : undefined}
                  onDragLeave={file.kind === 'folder' ? () => setDropTargetId((current) => (current === file.id ? null : current)) : undefined}
                  onDrop={file.kind === 'folder' ? (event) => { event.preventDefault(); handleDropOnTarget(file.id); } : undefined}
                >
                  <div className="file-name">
                    {file.kind === 'folder' ? <Folder size={16} /> : <FileIcon size={16} />}
                    <span>
                      {file.kind === 'folder'
                        ? <button type="button" className="file-open-button" onClick={() => openFolder(file.id)}>{normalizedSearch ? file.relativePath : file.name}</button>
                        : <strong>{normalizedSearch ? file.relativePath : file.name}</strong>}
                      <small>{file.kind}{file.documentType ? ` · ${file.documentType}` : ''}</small>
                    </span>
                  </div>
                  <span>{file.kind === 'folder' ? (folderSizes.has(file.id) ? formatBytes(folderSizes.get(file.id) ?? 0) : '—') : file.currentRevision ? formatBytes(file.currentRevision.sizeBytes) : '—'}</span>
                  <span>{new Date(file.updatedAt).toLocaleString()}</span>
                  <Badge variant={file.state === 'active' ? 'success' : 'destructive'}>{file.state}</Badge>
                  <div className="compact-actions file-actions">
                    {file.kind === 'document' ? (
                      <FileHistoryMenu
                        vaultId={vaultId}
                        file={file}
                        canRestore={detail.status === 'active' && file.state === 'active'}
                        onError={setError}
                        onRestored={() => void load()}
                      />
                    ) : (
                      <span className="file-history-placeholder" aria-hidden="true" />
                    )}
                    <Button aria-label={`Download ${file.relativePath}`} title={file.kind === 'folder' ? 'Download ZIP' : 'Download'} variant="outline" size="icon" disabled={file.state !== 'active'} onClick={() => void downloadEntry(file)}><Download size={15} /></Button>
                    <Button
                      aria-label={`Delete ${file.relativePath}`}
                      title="Delete"
                      variant="destructive"
                      size="icon"
                      disabled={pendingDelete || file.state !== 'active'}
                      onClick={() => setConfirm({
                        title: `Move ${file.name} to trash?`,
                        description: file.kind === 'folder'
                          ? 'The folder and its contents move to the vault trash. You can restore them from the Trash section.'
                          : 'The file moves to the vault trash. You can restore it from the Trash section.',
                        label: 'Move to trash',
                        action: () => trashEntry(file),
                      })}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </div>
              );
            })}
            {visibleFiles.length === 0 && <div className="file-browser-empty">{normalizedSearch ? 'No files match this search.' : 'This folder is empty.'}</div>}
            </div>
          </>}
          {fileBrowserTab === 'trash' && <div className="ui-dialog-section">
            <p className="subtle">Trashed top-level items are kept separately from active vault files. Restoring a folder also restores its contents.</p>
            <div className="file-browser">
              <div className="file-row trash-file-row file-header">
                <span>Original path</span><span>Size</span><span>Deleted</span><span>Deleted by</span><span>Actions</span>
              </div>
              {trashedFiles.map((file) => (
                <div className="file-row trash-file-row" key={file.id}>
                  <div className="file-name">
                    {file.kind === 'folder' ? <Folder size={16} /> : <FileIcon size={16} />}
                    <span><strong>{file.relativePath}</strong><small>{file.kind}{file.documentType ? ` · ${file.documentType}` : ''}</small></span>
                  </div>
                  <span>{file.currentRevision ? formatBytes(file.currentRevision.sizeBytes) : '—'}</span>
                  <span>{file.trashedAt ? new Date(file.trashedAt).toLocaleString() : 'Unknown'}</span>
                  <span>{file.trashedByDisplayName ?? 'Unknown user'}</span>
                  <div className="actions">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pendingDelete}
                      onClick={() => void run(() => performTrashOperation(file, 'restore'))}
                    >
                      <RotateCcw size={15} />Restore
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={pendingDelete}
                      onClick={() => setConfirm({
                        title: `Permanently delete ${file.name}?`,
                        description: 'This removes the item and its retained trash record. This action cannot be undone.',
                        label: 'Delete permanently',
                        action: () => performTrashOperation(file, 'purge'),
                      })}
                    >
                      <Trash2 size={15} />Delete permanently
                    </Button>
                  </div>
                </div>
              ))}
              {trashedFiles.length === 0 && <div className="file-browser-empty">Trash is empty.</div>}
            </div>
          </div>}
          </div>
          <div className="ui-dialog-actions"><Button variant="outline" onClick={() => setFilesOpen(false)}>Close</Button></div>
          </DialogShell>
        )}
        <Panel title="Members & access" icon={<Users size={17} />}>
          <h3 className="subsection-heading">Members ({members.length})</h3>
          <p className="subtle">Membership determines who can receive direct vault access. Configure effective permissions under Access grants.</p>
          <div className="user-list">
            {members.map((member) => (
              <div className="user-row" key={member.userId}>
                <div className="avatar">{member.displayName.slice(0, 2).toUpperCase()}</div>
                <div className="grow"><strong>{member.displayName}</strong><small>{member.username}{member.owner ? ' · owner' : ''}</small></div>
                <Badge variant={member.owner ? 'success' : 'outline'}>{member.owner ? 'owner' : 'member'}</Badge>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={member.owner || pendingDelete}
                  onClick={() => setConfirm({
                    title: `Remove ${member.username}?`,
                    description: `They immediately lose access to ${detail.name}.`,
                    label: 'Remove member',
                    action: () => serverApi.removeVaultMember(vaultId, member.userId),
                  })}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
          {!pendingDelete && candidates.length > 0 && (
            <form className="inline-form" onSubmit={addMember}>
              <label className="field"><span>User</span>
                <SelectMenu
                  label="Add member user"
                  value={memberChoice}
                  options={candidates.map((user) => ({ value: user.id, label: `${user.displayName} (${user.username})` }))}
                  onChange={setNewMemberId}
                />
              </label>
              <Button size="sm">Add member</Button>
            </form>
          )}
          <Separator />
          <h3 className="subsection-heading">Access grants ({grants.length})</h3>
          <p className="subtle">Grant a user or group access through a reusable template or a custom capability set. User grants override the member baseline; removing one reverts to that baseline.</p>
          <div className="user-list">
            {grants.length === 0 && <p className="subtle">No grants resolved for this vault.</p>}
            {grants.map((grant) => (
              <div className="user-row" key={`${grant.subjectType}:${grant.subjectId}`}>
                <Badge variant="outline">{grant.subjectType}</Badge>
                <div className="grow">
                  <strong>{grant.subjectName}</strong>
                  <small>{grant.templateName ? `Template: ${grant.templateName}` : 'Custom / role default'}</small>
                  <div className="capability-summary-row"><CapabilitySummary capabilities={grant.capabilities} /></div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pendingDelete || (grant.subjectType === 'user' && grant.subjectId === detail.ownerUserId)}
                  onClick={() => setGrantEditor({
                    subjectType: grant.subjectType,
                    subjectId: grant.subjectId,
                    subjectName: grant.subjectName,
                    current: grant,
                  })}
                >
                  Configure
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pendingDelete || (grant.subjectType === 'user' && grant.subjectId === detail.ownerUserId)}
                  onClick={() => setConfirm({
                    title: `Remove grant for ${grant.subjectName}?`,
                    description: grant.subjectType === 'group'
                      ? 'The group loses its grant on this vault.'
                      : 'The member reverts to their role default capabilities.',
                    label: 'Remove grant',
                    action: () => serverApi.deleteVaultGrant(vaultId, grant.subjectType, grant.subjectId),
                  })}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
          {!pendingDelete && (
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                const subjectCandidates = grantSubjectType === 'group'
                  ? groups.map((group) => group.id)
                  : members.filter((member) => !member.owner).map((member) => member.userId);
                const subjectId = subjectCandidates.includes(grantSubjectId) ? grantSubjectId : subjectCandidates[0];
                if (!subjectId) return;
                const subjectName = grantSubjectType === 'group'
                  ? groups.find((group) => group.id === subjectId)?.name
                  : members.find((member) => member.userId === subjectId)?.displayName;
                if (!subjectName) return;
                setGrantEditor({ subjectType: grantSubjectType, subjectId, subjectName, current: null });
              }}
            >
              <label className="field"><span>Subject</span>
                <SelectMenu
                  label="Grant subject type"
                  value={grantSubjectType}
                  options={[{ value: 'group', label: 'Group' }, { value: 'user', label: 'User (member)' }]}
                  onChange={(value) => { setGrantSubjectType(value as GrantSubjectType); setGrantSubjectId(''); }}
                />
              </label>
              <label className="field"><span>{grantSubjectType === 'group' ? 'Group' : 'Member'}</span>
                <SelectMenu
                  label="Grant subject"
                  value={grantSubjectId || (grantSubjectType === 'group' ? groups[0]?.id ?? '' : members.find((member) => !member.owner)?.userId ?? '')}
                  options={grantSubjectType === 'group'
                    ? groups.map((group) => ({ value: group.id, label: group.name }))
                    : members.filter((member) => !member.owner).map((member) => ({ value: member.userId, label: member.displayName }))}
                  onChange={setGrantSubjectId}
                />
              </label>
              <Button size="sm">Configure access</Button>
            </form>
          )}
        </Panel>
        <VaultChatLogPanel messages={chatMessages} />
        <VaultActivityPanel activity={activity} />
      </>}
      {confirm && (
        <ConfirmDialog
          destructive
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.label}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const pending = confirm;
            setConfirm(null);
            void run(pending.action);
          }}
        />
      )}
      {forceDeleting && detail && (
        <ConfirmDialog
          destructive
          title={`Permanently delete ${detail.name}?`}
          description="This irreversibly removes the vault and all of its files, revisions, members, grants, and history. This cannot be undone."
          confirmLabel="Force delete"
          onCancel={() => setForceDeleting(false)}
          onConfirm={() => {
            setForceDeleting(false);
            setError('');
            void serverApi.forceDeleteVault(vaultId).then(onBack).catch((reason) => setError(String(reason)));
          }}
        />
      )}
      {renaming && detail && (
        <PromptDialog
          title="Rename vault"
          description="The new name is visible to every vault member."
          label="Vault name"
          defaultValue={detail.name}
          submitLabel="Rename"
          onCancel={() => setRenaming(false)}
          onSubmit={(name) => {
            setRenaming(false);
            void run(() => serverApi.updateVault(vaultId, { name }));
          }}
        />
      )}
      {grantEditor && detail && (
        <GrantEditorDialog
          vaultId={vaultId}
          subjectType={grantEditor.subjectType}
          subjectId={grantEditor.subjectId}
          subjectName={grantEditor.subjectName}
          vaultName={detail.name}
          current={grantEditor.current}
          templates={templates}
          onClose={() => setGrantEditor(null)}
          onSaved={() => {
            setGrantEditor(null);
            void load();
          }}
        />
      )}
    </>
  );
}

// Per-file revision history shown as a dropdown menu instead of a full panel.
function FileHistoryMenu({
  vaultId,
  file,
  canRestore,
  onRestored,
  onError,
}: {
  vaultId: string;
  file: HostedFileEntry;
  canRestore: boolean;
  onRestored: () => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<HostedFileRevision[]>([]);
  const [loading, setLoading] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [selectedRevisionIds, setSelectedRevisionIds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setMenuPosition({
        top: rect.bottom + 4,
        left: Math.max(8, rect.right - 340),
        width: Math.min(340, Math.max(280, window.innerWidth - 16)),
      });
    }
    setOpen(true);
    setLoading(true);
    try {
      setRevisions(await serverApi.fileRevisions(vaultId, file.id));
    } catch (reason) {
      onError(String(reason));
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  async function restore(revision: HostedFileRevision) {
    try {
      await serverApi.restoreFileRevision(vaultId, file.id, revision.id, file.currentRevision?.sequence ?? 0);
      setOpen(false);
      onRestored();
    } catch (reason) {
      onError(String(reason));
    }
  }

  async function deleteRevision(revision: HostedFileRevision) {
    setDeleting(true);
    try {
      setRevisions(await serverApi.deleteFileRevision(vaultId, file.id, revision.id));
      onRestored();
    } catch (reason) {
      onError(String(reason));
    } finally {
      setDeleting(false);
    }
  }

  async function deleteSelected(all = false) {
    setDeleting(true);
    try {
      setRevisions(await serverApi.deleteFileRevisions(vaultId, file.id, all ? { all: true } : { revisionIds: selectedRevisionIds }));
      setSelectedRevisionIds([]);
      setManageOpen(false);
      onRestored();
    } catch (reason) {
      onError(String(reason));
    } finally {
      setDeleting(false);
    }
  }

  const currentRevisionId = file.currentRevision?.id ?? null;
  const deletableRevisions = revisions.filter((revision) => revision.id !== currentRevisionId);
  const historyMenu = open && menuPosition ? createPortal(
    <div
      ref={listRef}
      className="history-menu-list"
      role="menu"
      aria-label={`Revision history for ${file.name}`}
      style={{ top: menuPosition.top, left: menuPosition.left, width: menuPosition.width }}
    >
      <div className="history-menu-head">
        <strong>{file.name}</strong>
        <Button variant="outline" size="sm" disabled={loading || revisions.length === 0} onClick={() => setManageOpen(true)}>Manage</Button>
      </div>
      {loading && <p className="subtle history-menu-empty">Loading revisions...</p>}
      {!loading && revisions.length === 0 && <p className="subtle history-menu-empty">No revisions recorded.</p>}
      {!loading && revisions.map((revision) => {
        const isCurrent = revision.id === currentRevisionId;
        return (
          <div className="history-menu-row" key={revision.id}>
            <div className="grow">
              <strong>Revision {revision.sequence}{isCurrent ? ' · current' : ''}</strong>
              <small>{formatBytes(revision.sizeBytes)} · {revision.createdByDisplayName ?? 'System'} · {new Date(revision.createdAt).toLocaleString()}</small>
            </div>
            <div className="compact-actions">
              <Button
                variant="outline"
                size="sm"
                disabled={isCurrent || !canRestore}
                onClick={() => void restore(revision)}
              >
                Restore
              </Button>
              <Button
                aria-label={`Delete revision ${revision.sequence}`}
                title="Delete revision"
                variant="destructive"
                size="icon"
                disabled={isCurrent || deleting}
                onClick={() => void deleteRevision(revision)}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
        );
      })}
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={containerRef} className="history-menu">
      <Button
        ref={triggerRef}
        aria-label={`History ${file.relativePath}`}
        aria-haspopup="menu"
        aria-expanded={open}
        variant="outline"
        size="sm"
        disabled={file.state !== 'active'}
        onClick={() => void toggle()}
      >
        <History size={15} />History<ChevronDown size={13} />
      </Button>
      {historyMenu}
      {manageOpen && (
        <DialogShell
          title={`Manage history for ${file.name}`}
          description="Delete old file versions. The current revision and snapshot-pinned revisions are protected by the server."
          onClose={() => setManageOpen(false)}
          className="ui-dialog-wide"
        >
          <div className="history-manage-list">
            {revisions.map((revision) => {
              const isCurrent = revision.id === currentRevisionId;
              const selected = selectedRevisionIds.includes(revision.id);
              return (
                <label className="history-manage-row" key={revision.id}>
                  <Checkbox
                    disabled={isCurrent || deleting}
                    checked={selected}
                    onChange={(event) => setSelectedRevisionIds((current) => event.target.checked ? [...current, revision.id] : current.filter((id) => id !== revision.id))}
                  />
                  <div className="grow">
                    <strong>Revision {revision.sequence}{isCurrent ? ' · current' : ''}</strong>
                    <small>{formatBytes(revision.sizeBytes)} · {revision.createdByDisplayName ?? 'System'} · {new Date(revision.createdAt).toLocaleString()}</small>
                  </div>
                </label>
              );
            })}
            {revisions.length === 0 && <p className="subtle">No revisions recorded.</p>}
          </div>
          <div className="ui-dialog-actions">
            <Button variant="outline" onClick={() => setManageOpen(false)}>Close</Button>
            <Button variant="outline" disabled={deleting || selectedRevisionIds.length === 0} onClick={() => void deleteSelected(false)}>Delete selected</Button>
            <Button variant="destructive" disabled={deleting || deletableRevisions.length === 0} onClick={() => void deleteSelected(true)}>Delete all old versions</Button>
          </div>
        </DialogShell>
      )}
    </div>
  );
}

function VaultChatLogPanel({ messages }: { messages: HostedChatMessage[] }) {
  const ordered = [...messages].sort((left, right) => right.timestamp - left.timestamp);
  return (
    <Panel title="Chat log" icon={<MessageSquare size={17} />}>
      {ordered.length === 0 ? <p className="subtle">No chat messages recorded for this vault yet.</p> : (
        <>
          <p className="subtle">Most recent {ordered.length} server-routed chat {ordered.length === 1 ? 'message' : 'messages'}.</p>
          <div className="chat-log-list">
            {ordered.map((message) => (
              <div className="chat-log-row" key={message.id}>
                <div className="avatar" style={{ background: message.userColor }}>{message.userName.slice(0, 2).toUpperCase()}</div>
                <div className="grow">
                  <div className="chat-log-meta">
                    <strong>{message.userName}</strong>
                    <small>{new Date(message.timestamp).toLocaleString()}</small>
                  </div>
                  <p>{message.content}</p>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

// Vault activity condensed into a card with the three most recent events plus a
// collapsible submenu for the full log.
function VaultActivityPanel({ activity }: { activity: HostedVaultActivityEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const recent = activity.slice(0, 3);
  const rest = activity.slice(3);
  const renderRow = (event: HostedVaultActivityEvent) => (
    <div className="audit-row" key={event.id}>
      <span className="event-dot success" />
      <div className="grow">
        <strong>{event.eventType.replaceAll('.', ' ').replaceAll('_', ' ')}</strong>
        <small>{event.actorDisplayName ?? 'System'} · {new Date(event.createdAt).toLocaleString()}</small>
      </div>
      {event.targetType && <span className="request-chip">{event.targetType}</span>}
    </div>
  );
  return (
    <Panel title="Vault activity" icon={<Activity size={17} />}>
      {activity.length === 0 ? <p className="subtle">No recorded activity yet.</p> : (
        <>
          <Card className="activity-recent">
            <div className="activity-recent-head">
              <small>Most recent activity</small>
            </div>
            <div className="audit-list">{recent.map(renderRow)}</div>
          </Card>
          {rest.length > 0 && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="activity-toggle"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                <ChevronRight size={14} className={expanded ? 'rotate' : ''} />
                {expanded ? 'Hide earlier activity' : `Show ${rest.length} earlier event${rest.length === 1 ? '' : 's'}`}
              </Button>
              {expanded && <div className="audit-list activity-rest">{rest.map(renderRow)}</div>}
            </>
          )}
        </>
      )}
    </Panel>
  );
}

function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('all');
  const [resultFilter, setResultFilter] = useState('all');
  const load = useCallback(() => serverApi.auditEvents().then(setEvents).catch(() => undefined), []);
  useEffect(() => void load(), [load]);
  useAutoRefresh(load);

  const actionOptions = useMemo(() => {
    const actions = Array.from(new Set(events.map((event) => event.action))).sort();
    return [{ value: 'all', label: 'All events' }, ...actions.map((action) => ({ value: action, label: action.replaceAll('.', ' ') }))];
  }, [events]);
  const resultOptions = useMemo(() => {
    const results = Array.from(new Set(events.map((event) => event.result))).sort();
    return [{ value: 'all', label: 'All results' }, ...results.map((result) => ({ value: result, label: result }))];
  }, [events]);
  const query = search.trim().toLowerCase();
  const visibleEvents = useMemo(() => events.filter((event) => {
    if (actionFilter !== 'all' && event.action !== actionFilter) return false;
    if (resultFilter !== 'all' && event.result !== resultFilter) return false;
    if (!query) return true;
    return event.action.toLowerCase().includes(query)
      || (event.actorDisplayName?.toLowerCase().includes(query) ?? false)
      || (event.targetType?.toLowerCase().includes(query) ?? false)
      || (event.targetId?.toLowerCase().includes(query) ?? false);
  }), [events, actionFilter, resultFilter, query]);

  return (
    <>
      <PageHeader eyebrow="SECURITY" title="Audit log" subtitle="Redacted authentication and administration events." />
      <Panel title={`${visibleEvents.length} of ${events.length} events`} icon={<ShieldCheck size={17} />}>
        <div className="audit-filters">
          <label className="list-search">
            <Search size={15} />
            <Input type="search" value={search} placeholder="Search by action, actor, or target" aria-label="Search audit events" onChange={(event) => setSearch(event.target.value)} />
          </label>
          <SelectMenu label="Filter by event" value={actionFilter} options={actionOptions} onChange={setActionFilter} />
          <SelectMenu label="Filter by result" value={resultFilter} options={resultOptions} onChange={setResultFilter} />
        </div>
        <AuditTable events={visibleEvents} />
      </Panel>
    </>
  );
}

function AuditTable({ events }: { events: AuditEvent[] }) {
  if (!events.length) return <p className="subtle">No audit events yet.</p>;
  return <div className="audit-list">{events.map((event) => <div className="audit-row" key={event.id}><span className={`event-dot ${event.result}`} /><div className="grow"><strong>{event.action.replaceAll('.', ' ')}</strong><small>{event.actorDisplayName ?? 'System'} · {new Date(event.createdAt).toLocaleString()}</small></div><span className="request-chip">{event.result}</span></div>)}</div>;
}

// --- Permissions ---

type PermissionsTab = 'overview' | 'users' | 'groups' | 'templates';

function CapabilitySummary({ capabilities }: { capabilities: string[] }) {
  if (capabilities.length === 0) return <span className="subtle">No capabilities</span>;
  if (capabilities.length === ALL_CAPABILITIES.length) return <Badge variant="success">Full access</Badge>;
  return (
    <span className="capability-chips">
      {capabilities.map((token) => (
        <span className="request-chip" key={token} title={capabilityLabel(token)}>{token}</span>
      ))}
    </span>
  );
}

function TemplateEditorDialog({
  template,
  mode,
  onClose,
  onSaved,
}: {
  template: PermissionTemplate | null;
  mode: 'create' | 'edit' | 'clone';
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(mode === 'clone' ? `${template?.name ?? ''} copy` : template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(template?.capabilities ?? []));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function toggle(token: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  }

  async function save() {
    if (!name.trim()) {
      setError('A template name is required.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const capabilities = ALL_CAPABILITIES.filter((token) => selected.has(token));
      const payload = { name: name.trim(), description: description.trim() || null, capabilities };
      if (mode === 'edit' && template) await serverApi.updateTemplate(template.id, payload);
      else await serverApi.createTemplate(payload);
      onSaved();
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  }

  const title = mode === 'edit' ? 'Edit template' : mode === 'clone' ? 'Clone template' : 'New template';
  return (
    <DialogShell title={title} description="Choose the capabilities this template grants." onClose={onClose}>
      <label className="field"><span>Name</span><Input value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
      <label className="field"><span>Description</span><Input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <div className="capability-editor">
        {CAPABILITY_GROUPS.map((group) => (
          <div className="capability-group" key={group.domain}>
            <strong>{group.domain}</strong>
            {group.capabilities.map((capability) => (
              <label className="check" key={capability.token}>
                <Checkbox checked={selected.has(capability.token)} onChange={() => toggle(capability.token)} aria-label={capability.token} />
                {capability.label}
              </label>
            ))}
          </div>
        ))}
      </div>
      {error && <div className="error-banner" role="alert"><CircleAlert size={16} />{error}</div>}
      <div className="ui-dialog-actions">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={busy} onClick={() => void save()}>{mode === 'edit' ? 'Save template' : 'Create template'}</Button>
      </div>
    </DialogShell>
  );
}

function PermissionsPage() {
  const [tab, setTab] = useState<PermissionsTab>('overview');
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [templates, setTemplates] = useState<PermissionTemplate[]>([]);
  const [users, setUsers] = useState<ServerUser[]>([]);
  const [vaults, setVaults] = useState<HostedVaultSummary[]>([]);
  const [groupMembers, setGroupMembers] = useState<Record<string, UserGroupMember[]>>({});
  const [grantsByVault, setGrantsByVault] = useState<Record<string, VaultGrant[]>>({});
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<{ template: PermissionTemplate | null; mode: 'create' | 'edit' | 'clone' } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; description: string; label: string; action: () => Promise<unknown> } | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const [nextGroups, nextTemplates, nextUsers, nextVaults] = await Promise.all([
        serverApi.groups(),
        serverApi.templates(),
        serverApi.users(),
        serverApi.vaults(),
      ]);
      setGroups(nextGroups);
      setTemplates(nextTemplates);
      setUsers(nextUsers);
      setVaults(nextVaults);
      const memberEntries = await Promise.all(
        nextGroups.map(async (group) => [group.id, await serverApi.groupMembers(group.id).catch(() => [])] as const),
      );
      setGroupMembers(Object.fromEntries(memberEntries));
      const grantEntries = await Promise.all(
        nextVaults.map(async (vault) => [vault.id, await serverApi.vaultGrants(vault.id).catch(() => [])] as const),
      );
      setGrantsByVault(Object.fromEntries(grantEntries));
    } catch (reason) {
      setError(String(reason));
    }
  }, []);
  useEffect(() => void load(), [load]);
  useAutoRefresh(load);

  async function run(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  }

  const tabs: Array<{ value: PermissionsTab; label: string }> = [
    { value: 'overview', label: 'Overview' },
    { value: 'users', label: 'Users' },
    { value: 'groups', label: 'Groups' },
    { value: 'templates', label: 'Templates' },
  ];

  return (
    <>
      <PageHeader eyebrow="ACCESS CONTROL" title="Permissions" subtitle="Reusable templates, user groups, and per-vault grants." />
      {error && <div className="error-banner" role="alert"><CircleAlert size={16} />{error}</div>}
      <div className="tab-bar" role="tablist" aria-label="Permissions sections">
        {tabs.map((entry) => (
          <Button
            key={entry.value}
            role="tab"
            aria-selected={tab === entry.value}
            variant="ghost"
            className={tab === entry.value ? 'active' : ''}
            onClick={() => setTab(entry.value)}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      {tab === 'overview' && (
        <PermissionsOverview
          groups={groups}
          users={users}
          groupMembers={groupMembers}
          grantsByVault={grantsByVault}
          vaults={vaults}
          search={search}
          onSearch={setSearch}
        />
      )}

      {tab === 'users' && (
        <PermissionsUsers
          users={users}
          groups={groups}
          templates={templates}
          vaults={vaults}
          groupMembers={groupMembers}
          grantsByVault={grantsByVault}
          onChange={() => void load()}
        />
      )}

      {tab === 'groups' && (
        <Panel title={`${groups.length} groups`} icon={<Users size={17} />}>
          <div className="panel-actions"><Button size="sm" onClick={() => setCreatingGroup(true)}><Plus size={15} /> New group</Button></div>
          {creatingGroup && (
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const name = String(data.get('name') ?? '').trim();
                if (!name) return;
                setCreatingGroup(false);
                void run(() => serverApi.createGroup({ name, description: String(data.get('description') ?? '').trim() || null }));
              }}
            >
              <Field label="Name" name="name" required />
              <Field label="Description" name="description" />
              <Button size="sm">Create group</Button>
            </form>
          )}
          <div className="user-list">
            {groups.map((group) => (
              <div className="user-row" key={group.id}>
                <div className="grow"><strong>{group.name}</strong><small>{group.description || 'No description'} · {group.memberCount} members</small></div>
                <Button variant="outline" size="sm" onClick={() => setSelectedGroupId(selectedGroupId === group.id ? null : group.id)}>
                  {selectedGroupId === group.id ? 'Close' : 'Manage'}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirm({
                    title: `Delete ${group.name}?`,
                    description: 'The group and all its vault grants are removed.',
                    label: 'Delete group',
                    action: () => serverApi.deleteGroup(group.id),
                  })}
                >
                  Delete
                </Button>
              </div>
            ))}
          </div>
          {selectedGroupId && (() => {
            const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;
            if (!selectedGroup) return null;
            return (
              <div className="subject-detail">
                <GroupMembersEditor
                  group={selectedGroup}
                  members={groupMembers[selectedGroupId] ?? []}
                  users={users}
                  onChange={() => void load()}
                />
                <Separator />
                <SubjectVaultGrants
                  subjectType="group"
                  subjectId={selectedGroup.id}
                  subjectName={selectedGroup.name}
                  vaults={vaults}
                  templates={templates}
                  grantsByVault={grantsByVault}
                  onChange={() => void load()}
                />
              </div>
            );
          })()}
        </Panel>
      )}

      {tab === 'templates' && (
        <Panel title={`${templates.length} templates`} icon={<ShieldCheck size={17} />}>
          <div className="panel-actions"><Button size="sm" onClick={() => setEditor({ template: null, mode: 'create' })}><Plus size={15} /> New template</Button></div>
          <div className="user-list">
            {templates.map((template) => (
              <div className="user-row" key={template.id}>
                <div className="grow">
                  <strong>{template.name} {template.isBuiltin && <Badge variant="outline">built-in</Badge>}</strong>
                  <small>{template.description || 'No description'}</small>
                  <div className="capability-summary-row"><CapabilitySummary capabilities={template.capabilities} /></div>
                </div>
                {template.isBuiltin ? (
                  <Button variant="outline" size="sm" onClick={() => setEditor({ template, mode: 'clone' })}>Clone</Button>
                ) : (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setEditor({ template, mode: 'edit' })}>Edit</Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setConfirm({
                        title: `Delete ${template.name}?`,
                        description: 'Grants that reference this template revert to their default capabilities.',
                        label: 'Delete template',
                        action: () => serverApi.deleteTemplate(template.id),
                      })}
                    >
                      Delete
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {editor && (
        <TemplateEditorDialog
          template={editor.template}
          mode={editor.mode}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            void load();
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          destructive
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.label}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const pending = confirm;
            setConfirm(null);
            void run(pending.action);
          }}
        />
      )}
    </>
  );
}

function GroupMembersEditor({
  group,
  members,
  users,
  onChange,
}: {
  group: UserGroup | null;
  members: UserGroupMember[];
  users: ServerUser[];
  onChange: () => void;
}) {
  const [choice, setChoice] = useState('');
  const [error, setError] = useState('');
  if (!group) return null;
  const memberIds = new Set(members.map((member) => member.userId));
  const candidates = users.filter((user) => user.status === 'active' && !memberIds.has(user.id));
  const selected = candidates.some((user) => user.id === choice) ? choice : candidates[0]?.id ?? '';

  async function mutate(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      onChange();
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <div className="group-members">
      <Separator />
      <strong>Members of {group.name}</strong>
      {error && <div className="error-banner" role="alert"><CircleAlert size={16} />{error}</div>}
      <div className="user-list">
        {members.length === 0 && <p className="subtle">No members yet.</p>}
        {members.map((member) => (
          <div className="user-row" key={member.userId}>
            <div className="avatar">{member.displayName.slice(0, 2).toUpperCase()}</div>
            <div className="grow"><strong>{member.displayName}</strong><small>{member.username}</small></div>
            <Button variant="destructive" size="sm" onClick={() => void mutate(() => serverApi.removeGroupMember(group.id, member.userId))}>Remove</Button>
          </div>
        ))}
      </div>
      {candidates.length > 0 && (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (selected) void mutate(() => serverApi.addGroupMember(group.id, selected));
          }}
        >
          <label className="field"><span>Add user</span>
            <SelectMenu
              label="Add group member"
              value={selected}
              options={candidates.map((user) => ({ value: user.id, label: `${user.displayName} (${user.username})` }))}
              onChange={setChoice}
            />
          </label>
          <Button size="sm">Add member</Button>
        </form>
      )}
    </div>
  );
}

function PermissionsOverview({
  groups,
  users,
  groupMembers,
  grantsByVault,
  vaults,
  search,
  onSearch,
}: {
  groups: UserGroup[];
  users: ServerUser[];
  groupMembers: Record<string, UserGroupMember[]>;
  grantsByVault: Record<string, VaultGrant[]>;
  vaults: HostedVaultSummary[];
  search: string;
  onSearch: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const query = search.trim().toLowerCase();
  const vaultName = (id: string) => vaults.find((vault) => vault.id === id)?.name ?? id;

  // Aggregate grants by subject across every vault.
  const grantsForSubject = (type: GrantSubjectType, subjectId: string) =>
    Object.entries(grantsByVault).flatMap(([vaultId, grants]) =>
      grants.filter((grant) => grant.subjectType === type && grant.subjectId === subjectId).map((grant) => ({ vaultId, grant })),
    );
  const groupsForUser = (userId: string) =>
    groups.filter((group) => (groupMembers[group.id] ?? []).some((member) => member.userId === userId));

  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const visibleGroups = groups.filter((group) => !query || group.name.toLowerCase().includes(query));
  const visibleUsers = users.filter(
    (user) => !query || user.displayName.toLowerCase().includes(query) || user.username.toLowerCase().includes(query),
  );

  function TreeNode({ id, label, sub, children }: { id: string; label: React.ReactNode; sub?: string; children?: React.ReactNode }) {
    const isOpen = expanded.has(id);
    return (
      <div className="tree-node">
        <button type="button" className="tree-row" aria-expanded={isOpen} onClick={() => toggle(id)}>
          {children ? (isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />) : <span className="tree-spacer" />}
          <span className="grow"><strong>{label}</strong>{sub && <small> {sub}</small>}</span>
        </button>
        {isOpen && children && <div className="tree-children">{children}</div>}
      </div>
    );
  }

  return (
    <Panel title="Access overview" icon={<Search size={17} />}>
      <Input placeholder="Search users, groups, and vaults…" value={search} onChange={(event) => onSearch(event.target.value)} aria-label="Search permissions" />
      <div className="permission-tree">
        <div className="tree-section">
          <p className="eyebrow">Groups</p>
          {visibleGroups.length === 0 && <p className="subtle">No matching groups.</p>}
          {visibleGroups.map((group) => {
            const members = groupMembers[group.id] ?? [];
            const grants = grantsForSubject('group', group.id);
            return (
              <TreeNode key={group.id} id={`group:${group.id}`} label={group.name} sub={`· ${members.length} members · ${grants.length} vault grants`}>
                <TreeNode id={`group:${group.id}:members`} label="Members" sub={`(${members.length})`}>
                  {members.map((member) => <div className="tree-leaf" key={member.userId}>{member.displayName} <small>{member.username}</small></div>)}
                  {members.length === 0 && <div className="tree-leaf subtle">None</div>}
                </TreeNode>
                <TreeNode id={`group:${group.id}:grants`} label="Vault grants" sub={`(${grants.length})`}>
                  {grants.map(({ vaultId, grant }) => (
                    <div className="tree-leaf" key={vaultId}>{vaultName(vaultId)} <small>{grant.templateName ?? `${grant.capabilities.length} capabilities`}</small></div>
                  ))}
                  {grants.length === 0 && <div className="tree-leaf subtle">None</div>}
                </TreeNode>
              </TreeNode>
            );
          })}
        </div>
        <div className="tree-section">
          <p className="eyebrow">Users</p>
          {visibleUsers.length === 0 && <p className="subtle">No matching users.</p>}
          {visibleUsers.map((user) => {
            const userGroups = groupsForUser(user.id);
            const grants = grantsForSubject('user', user.id);
            return (
              <TreeNode key={user.id} id={`user:${user.id}`} label={user.displayName} sub={`· ${user.username}`}>
                <TreeNode id={`user:${user.id}:groups`} label="Group memberships" sub={`(${userGroups.length})`}>
                  {userGroups.map((group) => <div className="tree-leaf" key={group.id}>{group.name}</div>)}
                  {userGroups.length === 0 && <div className="tree-leaf subtle">None</div>}
                </TreeNode>
                <TreeNode id={`user:${user.id}:grants`} label="Direct vault grants" sub={`(${grants.length})`}>
                  {grants.map(({ vaultId, grant }) => (
                    <div className="tree-leaf" key={vaultId}>{vaultName(vaultId)} <small>{grant.templateName ?? `${grant.capabilities.length} capabilities`}</small></div>
                  ))}
                  {grants.length === 0 && <div className="tree-leaf subtle">None</div>}
                </TreeNode>
              </TreeNode>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

function GrantEditorDialog({
  vaultId,
  subjectType,
  subjectId,
  subjectName,
  vaultName,
  current,
  templates,
  onClose,
  onSaved,
}: {
  vaultId: string;
  subjectType: GrantSubjectType;
  subjectId: string;
  subjectName: string;
  vaultName: string;
  current: VaultGrant | null;
  templates: PermissionTemplate[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<'template' | 'custom'>(current?.templateId ? 'template' : 'custom');
  const [templateId, setTemplateId] = useState(current?.templateId ?? templates[0]?.id ?? '');
  const [selected, setSelected] = useState<Set<string>>(new Set(current?.capabilities ?? []));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function toggle(token: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      const payload = mode === 'template'
        ? { templateId }
        : { capabilities: ALL_CAPABILITIES.filter((token) => selected.has(token)) };
      await serverApi.putVaultGrant(vaultId, subjectType, subjectId, payload);
      onSaved();
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  }

  return (
    <DialogShell title={`Access for ${subjectName}`} description={`Vault: ${vaultName}`} onClose={onClose}>
      <div className="settings-row">
        <span>Source</span>
        <SelectMenu
          label="Grant source"
          value={mode}
          options={[{ value: 'template', label: 'Template' }, { value: 'custom', label: 'Custom capabilities' }]}
          onChange={(value) => setMode(value as 'template' | 'custom')}
        />
      </div>
      {mode === 'template' ? (
        <div className="settings-row">
          <span>Template</span>
          <SelectMenu label="Template" value={templateId} options={templates.map((template) => ({ value: template.id, label: template.name }))} onChange={setTemplateId} />
        </div>
      ) : (
        <div className="capability-editor">
          {CAPABILITY_GROUPS.map((group) => (
            <div className="capability-group" key={group.domain}>
              <strong>{group.domain}</strong>
              {group.capabilities.map((capability) => (
                <label className="check" key={capability.token}>
                  <Checkbox checked={selected.has(capability.token)} onChange={() => toggle(capability.token)} aria-label={capability.token} />
                  {capability.label}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
      {error && <div className="error-banner" role="alert"><CircleAlert size={16} />{error}</div>}
      <div className="ui-dialog-actions">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={busy} onClick={() => void save()}>Apply</Button>
      </div>
    </DialogShell>
  );
}

/**
 * Lists and edits a subject's (user or group) vault grants. Groups can be
 * granted on any vault; user grants override an existing membership, so new user
 * grants are added from the vault's own Access section.
 */
function SubjectVaultGrants({
  subjectType,
  subjectId,
  subjectName,
  vaults,
  templates,
  grantsByVault,
  onChange,
}: {
  subjectType: GrantSubjectType;
  subjectId: string;
  subjectName: string;
  vaults: HostedVaultSummary[];
  templates: PermissionTemplate[];
  grantsByVault: Record<string, VaultGrant[]>;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState<{ vaultId: string; vaultName: string; current: VaultGrant | null } | null>(null);
  const [addVaultId, setAddVaultId] = useState('');
  const [error, setError] = useState('');

  const vaultName = (id: string) => vaults.find((vault) => vault.id === id)?.name ?? id;
  const grants = Object.entries(grantsByVault).flatMap(([vaultId, vaultGrants]) =>
    vaultGrants
      .filter((grant) => grant.subjectType === subjectType && grant.subjectId === subjectId)
      .map((grant) => ({ vaultId, grant })));
  const grantedIds = new Set(grants.map((entry) => entry.vaultId));
  const addableVaults = vaults.filter((vault) => !grantedIds.has(vault.id));
  const addVault = addableVaults.some((vault) => vault.id === addVaultId) ? addVaultId : addableVaults[0]?.id ?? '';

  async function run(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      onChange();
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <>
      <strong>Vault grants</strong>
      {subjectType === 'user'
        ? <p className="subtle">Override a member's capabilities per vault. Add a user to a vault from the vault's Access section first.</p>
        : <p className="subtle">Grant this group access to vaults through a template or specific capabilities.</p>}
      {error && <div className="error-banner" role="alert"><CircleAlert size={16} />{error}</div>}
      <div className="user-list">
        {grants.length === 0 && <p className="subtle">No vault grants.</p>}
        {grants.map(({ vaultId, grant }) => (
          <div className="user-row access-grant-row" key={vaultId}>
            <div className="grow"><strong>{vaultName(vaultId)}</strong><small>{grant.templateName ?? `${grant.capabilities.length} capabilities`}</small></div>
            <Button variant="outline" size="sm" onClick={() => setEditing({ vaultId, vaultName: vaultName(vaultId), current: grant })}>Edit access</Button>
            <Button variant="destructive" size="sm" onClick={() => void run(() => serverApi.deleteVaultGrant(vaultId, subjectType, subjectId))}>{subjectType === 'group' ? 'Remove' : 'Reset'}</Button>
          </div>
        ))}
      </div>
      {subjectType === 'group' && addableVaults.length > 0 && (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (addVault) setEditing({ vaultId: addVault, vaultName: vaultName(addVault), current: null });
          }}
        >
          <label className="field"><span>Grant on vault</span>
            <SelectMenu label="Grant group on vault" value={addVault} options={addableVaults.map((vault) => ({ value: vault.id, label: vault.name }))} onChange={setAddVaultId} />
          </label>
          <Button size="sm">Configure</Button>
        </form>
      )}
      {editing && (
        <GrantEditorDialog
          vaultId={editing.vaultId}
          vaultName={editing.vaultName}
          subjectType={subjectType}
          subjectId={subjectId}
          subjectName={subjectName}
          current={editing.current}
          templates={templates}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChange(); }}
        />
      )}
    </>
  );
}

function PermissionsUsers({
  users,
  groups,
  templates,
  vaults,
  groupMembers,
  grantsByVault,
  onChange,
}: {
  users: ServerUser[];
  groups: UserGroup[];
  templates: PermissionTemplate[];
  vaults: HostedVaultSummary[];
  groupMembers: Record<string, UserGroupMember[]>;
  grantsByVault: Record<string, VaultGrant[]>;
  onChange: () => void;
}) {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addGroupId, setAddGroupId] = useState('');
  const [error, setError] = useState('');

  const query = search.trim().toLowerCase();
  const visible = users.filter((user) => !query || user.displayName.toLowerCase().includes(query) || user.username.toLowerCase().includes(query));
  const selected = users.find((user) => user.id === selectedId) ?? null;

  async function run(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      onChange();
    } catch (reason) {
      setError(String(reason));
    }
  }

  const memberGroups = selected ? groups.filter((group) => (groupMembers[group.id] ?? []).some((member) => member.userId === selected.id)) : [];
  const joinableGroups = selected ? groups.filter((group) => !memberGroups.some((joined) => joined.id === group.id)) : [];
  const joinGroupId = joinableGroups.some((group) => group.id === addGroupId) ? addGroupId : joinableGroups[0]?.id ?? '';

  return (
    <Panel title="User access" icon={<Users size={17} />}>
      {error && <div className="error-banner" role="alert"><CircleAlert size={16} />{error}</div>}
      <Input placeholder="Search users…" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search users" />
      <div className="permission-user-layout">
        <div className="user-list user-picker">
          {visible.map((user) => (
            <button type="button" key={user.id} className={`user-row user-pick${selectedId === user.id ? ' active' : ''}`} onClick={() => setSelectedId(user.id)}>
              <Avatar user={user} size={28} />
              <div className="grow"><strong>{user.displayName}</strong><small>{user.username}</small></div>
            </button>
          ))}
          {visible.length === 0 && <p className="subtle">No matching users.</p>}
        </div>
        <div className="user-detail">
          {!selected ? <p className="subtle">Select a user to manage their groups and vault access.</p> : (
            <>
              <div className="account-identity"><Avatar user={selected} size={40} /><div><strong>{selected.displayName}</strong><small>{selected.username} · {selected.role}</small></div></div>

              <Separator />
              <strong>Group memberships</strong>
              <div className="capability-chips">
                {memberGroups.length === 0 && <span className="subtle">No groups</span>}
                {memberGroups.map((group) => (
                  <span className="request-chip removable" key={group.id}>
                    {group.name}
                    <button type="button" aria-label={`Remove from ${group.name}`} onClick={() => void run(() => serverApi.removeGroupMember(group.id, selected.id))}>×</button>
                  </span>
                ))}
              </div>
              {joinableGroups.length > 0 && (
                <form className="inline-form" onSubmit={(event) => { event.preventDefault(); if (joinGroupId) void run(() => serverApi.addGroupMember(joinGroupId, selected.id)); }}>
                  <label className="field"><span>Add to group</span>
                    <SelectMenu label="Add user to group" value={joinGroupId} options={joinableGroups.map((group) => ({ value: group.id, label: group.name }))} onChange={setAddGroupId} />
                  </label>
                  <Button size="sm">Add</Button>
                </form>
              )}

              <Separator />
              <SubjectVaultGrants
                subjectType="user"
                subjectId={selected.id}
                subjectName={selected.displayName}
                vaults={vaults}
                templates={templates}
                grantsByVault={grantsByVault}
                onChange={onChange}
              />
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

// --- User profile & account ---

function Avatar({ user, size = 36 }: { user: Pick<ServerUser, 'id' | 'displayName' | 'hasAvatar' | 'avatarUpdatedAt'>; size?: number }) {
  const dimension = { width: size, height: size, minWidth: size };
  if (user.hasAvatar) {
    return <img className="avatar avatar-img" style={dimension} width={size} height={size} alt="" src={serverApi.avatarUrl(user.id, user.avatarUpdatedAt)} />;
  }
  return <div className="avatar" style={dimension}>{user.displayName.slice(0, 2).toUpperCase()}</div>;
}

/** Read-only view of a user's group memberships and direct vault grants. */
function UserAssignments({ userId }: { userId: string }) {
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [grants, setGrants] = useState<Array<{ vaultName: string; grant: VaultGrant }>>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [allGroups, allVaults] = await Promise.all([serverApi.groups(), serverApi.vaults()]);
        const memberLists = await Promise.all(
          allGroups.map(async (group) => [group, await serverApi.groupMembers(group.id).catch(() => [])] as const),
        );
        const grantLists = await Promise.all(
          allVaults.map(async (vault) => [vault, await serverApi.vaultGrants(vault.id).catch(() => [])] as const),
        );
        if (cancelled) return;
        setGroups(memberLists.filter(([, members]) => members.some((member) => member.userId === userId)).map(([group]) => group));
        setGrants(grantLists.flatMap(([vault, vaultGrants]) =>
          vaultGrants
            .filter((grant) => grant.subjectType === 'user' && grant.subjectId === userId)
            .map((grant) => ({ vaultName: vault.name, grant })),
        ));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);
  if (loading) return <p className="subtle">Loading assignments…</p>;
  return (
    <div className="assignments">
      <div>
        <strong>Group memberships</strong>
        {groups.length === 0 ? <p className="subtle">None</p> : <div className="capability-chips">{groups.map((group) => <span className="request-chip" key={group.id}>{group.name}</span>)}</div>}
      </div>
      <div>
        <strong>Vault grants</strong>
        {grants.length === 0 ? <p className="subtle">None</p> : (
          <div className="user-list">
            {grants.map(({ vaultName, grant }) => (
              <div className="user-row" key={`${vaultName}:${grant.subjectId}`}>
                <div className="grow"><strong>{vaultName}</strong><small>{grant.templateName ?? `${grant.capabilities.length} capabilities`}</small></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EditUserDialog({ user, onClose, onSaved }: { user: ServerUser; onClose: () => void; onSaved: () => void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [username, setUsername] = useState(user.username);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError('');
    try {
      const payload: Record<string, unknown> = {};
      if (displayName.trim() && displayName.trim() !== user.displayName) payload.displayName = displayName.trim();
      if (username.trim() && username.trim() !== user.username) payload.username = username.trim();
      if (Object.keys(payload).length > 0) await serverApi.updateUser(user.id, payload);
      onSaved();
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  }

  return (
    <DialogShell title={`Edit ${user.username}`} description="Update the account's profile and review its assignments." onClose={onClose}>
      <label className="field"><span>Display name</span><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoFocus /></label>
      <label className="field"><span>Username</span><Input value={username} onChange={(event) => setUsername(event.target.value)} /></label>
      {error && <div className="error-banner" role="alert"><CircleAlert size={16} />{error}</div>}
      <Separator />
      <UserAssignments userId={user.id} />
      <div className="ui-dialog-actions">
        <Button variant="outline" onClick={onClose}>Close</Button>
        <Button disabled={busy} onClick={() => void save()}>Save changes</Button>
      </div>
    </DialogShell>
  );
}

function AccountDialog({
  me,
  appearance,
  onAppearanceChange,
  onClose,
  onUpdated,
}: {
  me: ServerUser;
  appearance: ReturnType<typeof useAdminAppearance>['appearance'];
  onAppearanceChange: ReturnType<typeof useAdminAppearance>['setAppearance'];
  onClose: () => void;
  onUpdated: (user: ServerUser) => void;
}) {
  const [displayName, setDisplayName] = useState(me.displayName);
  const [username, setUsername] = useState(me.username);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const accents: AdminAccent[] = ['violet', 'blue', 'emerald', 'rose', 'orange', 'cyan'];

  async function run(action: () => Promise<ServerUser | void>, message: string) {
    setError('');
    setStatus('');
    try {
      const result = await action();
      if (result) onUpdated(result);
      setStatus(message);
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function saveProfile() {
    const payload: Record<string, unknown> = {};
    if (displayName.trim() && displayName.trim() !== me.displayName) payload.displayName = displayName.trim();
    if (username.trim() && username.trim() !== me.username) payload.username = username.trim();
    if (Object.keys(payload).length === 0) { setStatus('No changes to save.'); return; }
    await run(() => serverApi.updateSelf(payload), 'Profile updated.');
  }

  async function onAvatarSelected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 1024 * 1024) { setError('Avatars must be 1 MB or smaller.'); return; }
    const base64 = await fileToBase64(file);
    await run(() => serverApi.uploadOwnAvatar(file.type, base64), 'Avatar updated.');
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    setStatus('');
    try {
      await serverApi.changeOwnPassword(String(form.get('current') ?? ''), String(form.get('next') ?? ''));
      (event.currentTarget as HTMLFormElement).reset();
      setStatus('Password changed.');
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <DialogShell title="Your account" description="Manage your profile, avatar, password, and appearance." onClose={onClose}>
      {error && <div className="error-banner" role="alert"><CircleAlert size={16} />{error}</div>}
      {status && <p className="subtle" role="status">{status}</p>}

      <div className="account-identity">
        <Avatar user={me} size={56} />
        <div className="account-avatar-actions">
          <Button variant="outline" size="sm" onClick={() => avatarInputRef.current?.click()}>Upload avatar</Button>
          {me.hasAvatar && <Button variant="outline" size="sm" onClick={() => void run(() => serverApi.deleteOwnAvatar(), 'Avatar removed.')}>Remove</Button>}
          <input ref={avatarInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={onAvatarSelected} />
        </div>
      </div>

      <label className="field"><span>Display name</span><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
      <label className="field"><span>Username</span><Input value={username} onChange={(event) => setUsername(event.target.value)} /></label>
      <div className="ui-dialog-actions"><Button size="sm" onClick={() => void saveProfile()}>Save profile</Button></div>

      <Separator />
      <strong>Appearance</strong>
      <div className="settings-row">
        <span>Theme</span>
        <SelectMenu
          label="Theme"
          value={appearance.theme}
          options={[{ value: 'dark', label: 'Dark' }, { value: 'midnight', label: 'Midnight' }, { value: 'warm', label: 'Warm' }, { value: 'light', label: 'Light' }]}
          onChange={(value) => onAppearanceChange((current) => ({ ...current, theme: value as AdminTheme }))}
        />
      </div>
      <div className="settings-row">
        <span>Accent</span>
        <div className="accent-picker">
          {accents.map((accent) => (
            <button key={accent} type="button" className={`accent-dot accent-${accent}${appearance.accent === accent ? ' active' : ''}`} aria-label={accent} onClick={() => onAppearanceChange((current) => ({ ...current, accent }))} />
          ))}
        </div>
      </div>
      <label className="check"><Switch label="Compact density" checked={appearance.compact} onCheckedChange={(checked) => onAppearanceChange((current) => ({ ...current, compact: checked }))} /> Compact density</label>

      <Separator />
      <strong>Change password</strong>
      <form className="account-password" onSubmit={changePassword}>
        <Field label="Current password" name="current" type="password" autoComplete="current-password" required />
        <Field label="New password" name="next" type="password" autoComplete="new-password" minLength={12} required />
        <Button size="sm">Change password</Button>
      </form>

      <div className="ui-dialog-actions"><Button variant="outline" onClick={onClose}>Close</Button></div>
    </DialogShell>
  );
}

// Distinct, theme-friendly palette for storage chart segments. The final entry
// is reserved for an aggregated "Other" slice.
const STORAGE_CHART_COLORS = ['#a78bfa', '#60a5fa', '#34d399', '#fb7185', '#fb923c', '#22d3ee', '#fbbf24', '#f472b6'];
const STORAGE_CHART_OTHER_COLOR = '#94a3b8';

interface StorageSegment { label: string; bytes: number }

/**
 * Renders a proportional storage breakdown as an SVG donut ("cake") plus a
 * legend with per-entry bars. Caps the number of slices, aggregating the
 * remainder into a muted "Other" segment so a long inventory stays readable.
 */
function StorageBreakdown({
  title,
  icon,
  emptyLabel,
  unitLabel,
  segments,
  maxSlices = 8,
}: {
  title: string;
  icon: React.ReactNode;
  emptyLabel: string;
  unitLabel: string;
  segments: StorageSegment[];
  maxSlices?: number;
}) {
  const sorted = [...segments].filter((segment) => segment.bytes > 0).sort((left, right) => right.bytes - left.bytes);
  const total = sorted.reduce((sum, segment) => sum + segment.bytes, 0);
  const sliced = sorted.slice(0, maxSlices);
  const remainder = sorted.slice(maxSlices);
  const rows = sliced.map((segment, index) => ({ ...segment, color: STORAGE_CHART_COLORS[index % STORAGE_CHART_COLORS.length] }));
  if (remainder.length > 0) {
    rows.push({ label: `Other (${remainder.length})`, bytes: remainder.reduce((sum, segment) => sum + segment.bytes, 0), color: STORAGE_CHART_OTHER_COLOR });
  }

  if (total === 0) {
    return <Panel title={title} icon={icon}><p className="subtle">{emptyLabel}</p></Panel>;
  }

  const radius = 56;
  const stroke = 22;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <Panel title={title} icon={icon}>
      <div className="storage-chart">
        <svg className="storage-donut" viewBox="0 0 140 140" role="img" aria-label={`${title}: ${formatBytes(total)} across ${rows.length} ${unitLabel}`}>
          <circle className="storage-donut-track" cx="70" cy="70" r={radius} strokeWidth={stroke} fill="none" transform="rotate(-90 70 70)" />
          {rows.map((row) => {
            const fraction = row.bytes / total;
            const dash = fraction * circumference;
            const circle = (
              <circle
                key={row.label}
                cx="70"
                cy="70"
                r={radius}
                fill="none"
                stroke={row.color}
                strokeWidth={stroke}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 70 70)"
              >
                <title>{row.label}: {formatBytes(row.bytes)} ({(fraction * 100).toFixed(1)}%)</title>
              </circle>
            );
            offset += dash;
            return circle;
          })}
          <text className="storage-donut-total" x="70" y="66" textAnchor="middle">{formatBytes(total)}</text>
          <text className="storage-donut-caption" x="70" y="82" textAnchor="middle">{rows.length} {unitLabel}</text>
        </svg>
        <ul className="storage-legend">
          {rows.map((row) => {
            const fraction = row.bytes / total;
            return (
              <li key={row.label}>
                <span className="storage-legend-dot" style={{ background: row.color }} />
                <div className="storage-legend-main">
                  <div className="storage-legend-head">
                    <span className="storage-legend-label" title={row.label}>{row.label}</span>
                    <span className="storage-legend-size">{formatBytes(row.bytes)} · {(fraction * 100).toFixed(1)}%</span>
                  </div>
                  <div className="storage-legend-bar"><span style={{ width: `${Math.max(fraction * 100, 1.5)}%`, background: row.color }} /></div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}

function PageHeader({ eyebrow, title, subtitle, action }: { eyebrow: string; title: string; subtitle: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="subtle">{subtitle}</p></div>{action}</header>;
}
function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) { return <Card className="panel"><div className="panel-title">{icon}<h2>{title}</h2></div>{children}</Card>; }
function Metric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string | number; detail: string }) { return <Card className="metric"><div className="metric-icon">{icon}</div><p>{label}</p><strong>{value}</strong><small>{detail}</small></Card>; }
function Field(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) { const { label, ...inputProps } = props; return <label className="field"><span>{label}</span><Input {...inputProps} /></label>; }
function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) { return <Button variant="ghost" className={active ? 'active' : ''} onClick={onClick}>{icon}<span>{label}</span></Button>; }
function IconButton({ label, children, onClick }: { label: string; children: React.ReactNode; onClick: () => void }) { return <Button variant="outline" size="icon" title={label} aria-label={label} onClick={onClick}>{children}</Button>; }
function Loading() { return <div className="empty-state"><RefreshCw className="spin" /><p>Loading server data...</p></div>; }
function CenteredMessage({ title }: { title: string }) { return <main className="auth-page"><Card className="auth-card"><Server size={28} /><h1>{title}</h1></Card></main>; }
function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`; if (value < 1024 ** 4) return `${(value / 1024 ** 3).toFixed(1)} GB`; return `${(value / 1024 ** 4).toFixed(1)} TB`; }
// Renders a byte count as the largest binary unit it divides evenly into, so the
// editable settings round-trip cleanly (e.g. 268435456 -> "256 MiB", 0 -> "0").
function formatByteSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const units: [string, number][] = [['TiB', 1024 ** 4], ['GiB', 1024 ** 3], ['MiB', 1024 ** 2], ['KiB', 1024]];
  for (const [label, size] of units) {
    if (value % size === 0) return `${value / size} ${label}`;
  }
  return `${value} B`;
}
function formatDuration(seconds: number) { if (seconds < 60) return `${seconds}s`; if (seconds < 3600) return `${Math.round(seconds / 60)}m`; if (seconds < 86400) return `${Math.round(seconds / 3600)}h`; return `${Math.round(seconds / 86400)}d`; }
