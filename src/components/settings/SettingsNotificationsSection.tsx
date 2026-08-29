import { useEffect, useState } from 'react';

import { Bell, BellOff, CheckCircle2, ChevronDown, Save, Send } from 'lucide-react';
import { toast } from 'sonner';

import { listKnownServers } from '../../lib/hostedServers';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../lib/notificationContract';
import { tauriCommands } from '../../lib/tauri';
import { cn } from '../../lib/utils';
import { useCollabStore } from '../../store/collabStore';
import { useServerStore } from '../../store/serverStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import type { CalendarDefinition } from '../../types/calendar';
import type {
  NotificationCategory,
  NotificationPermissionStatus,
  NotificationPreferences,
} from '../../types/notification';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { TimePicker } from '../ui/time-picker';

import { OptionRow, SectionLabel, ToggleSwitch } from './settingsControls';
import TimeZoneSelect from './TimeZoneSelect';

const CATEGORY_LABELS: Array<[NotificationCategory, string, string]> = [
  ['calendar.reminder', 'Calendar reminders', 'Events, tasks, deadlines, and birthdays.'],
  ['calendar.invitation', 'Calendar invitations', 'Invitations and attendee updates.'],
  ['collaboration.message', 'Chat messages', 'New collaboration messages.'],
  ['collaboration.mention', 'Mentions', 'Messages that mention you directly.'],
  [
    'sync.action-required',
    'Sync and account',
    'Conflicts, permission changes, and sign-in recovery.',
  ],
  ['transfer.complete', 'Transfers', 'Completed uploads and downloads.'],
];

function minuteToTime(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function timeToMinute(value: string) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

interface NotificationScopeSource {
  key: string;
  label: string;
  description?: string;
  color?: string;
}

type NotificationScopeGroup = 'servers' | 'vaults' | 'calendars';

function uniqueSources(sources: NotificationScopeSource[]): NotificationScopeSource[] {
  return [...new Map(sources.map((source) => [source.key, source])).values()].sort((left, right) =>
    left.label.localeCompare(right.label),
  );
}

export default function SettingsNotificationsSection() {
  const [permission, setPermission] = useState<NotificationPermissionStatus | null>(null);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [calendars, setCalendars] = useState<CalendarDefinition[]>([]);
  const [expandedScope, setExpandedScope] = useState<NotificationScopeGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const profileId = useCollabStore((state) => state.myUserId);
  const connections = useServerStore((state) => state.connections);
  const vault = useVaultStore((state) => state.vault);
  const recentVaults = useVaultStore((state) => state.recentVaults);
  const timeFormat = useUiStore((state) => state.timeFormat);
  const defaultTimeZone = useUiStore((state) => state.calendarDefaultTimeZone);

  const refresh = async () => {
    try {
      const [nextPermission, nextPreferences, nextCalendars] = await Promise.all([
        tauriCommands.notificationPermissionStatus(),
        profileId
          ? tauriCommands.notificationPreferencesGet(profileId)
          : Promise.resolve(DEFAULT_NOTIFICATION_PREFERENCES),
        profileId ? tauriCommands.calendarList(profileId) : Promise.resolve([]),
      ]);
      setPermission(nextPermission);
      setPreferences(nextPreferences);
      setCalendars(nextCalendars.filter((calendar) => !calendar.deletedAt));
    } catch (error) {
      toast.error(`Could not read notification permission: ${error}`);
    }
  };

  useEffect(() => {
    void refresh();
  }, [profileId]);

  const requestPermission = async () => {
    setBusy(true);
    try {
      const next = await tauriCommands.notificationRequestPermission();
      setPermission(next);
      if (next.status === 'granted') toast.success('Desktop notifications enabled');
    } catch (error) {
      toast.error(`Could not enable notifications: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      await tauriCommands.notificationSendTest();
      toast.success('Test notification sent');
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const granted = permission?.status === 'granted';
  const updatePreferences = (
    update: (current: NotificationPreferences) => NotificationPreferences,
  ) => {
    setPreferences((current) => update(current ?? DEFAULT_NOTIFICATION_PREFERENCES));
  };
  const toggleScope = (scopeKey: string) => {
    updatePreferences((current) => {
      const scopeEnabled = { ...current.scopeEnabled };
      if (scopeEnabled[scopeKey] === false) delete scopeEnabled[scopeKey];
      else scopeEnabled[scopeKey] = false;
      return { ...current, scopeEnabled };
    });
  };
  const serverSources = uniqueSources([
    ...listKnownServers().map((server) => ({
      key: `server:${server.serverUrl}`,
      label: server.username || server.serverUrl,
      description: server.username ? server.serverUrl : undefined,
    })),
    ...Object.keys(connections).map((serverUrl) => ({
      key: `server:${serverUrl}`,
      label: connections[serverUrl].status.user?.displayName || serverUrl,
      description: serverUrl,
    })),
  ]);
  const vaultSources = uniqueSources([
    ...Object.entries(connections).flatMap(([serverUrl, connection]) =>
      connection.hostedVaults.map((hostedVault) => ({
        key: `vault:${hostedVault.id}`,
        label: hostedVault.name,
        description: serverUrl,
      })),
    ),
    ...recentVaults.map((recent) => ({
      key: `vault:${recent.kind === 'hosted' ? recent.hostedVaultId : recent.id}`,
      label: recent.name,
      description: recent.kind === 'hosted' ? recent.serverUrl : 'Local vault',
    })),
    ...(vault
      ? [
          {
            key: `vault:${vault.kind === 'hosted' ? vault.hostedVaultId : vault.id}`,
            label: vault.name,
            description: vault.kind === 'hosted' ? vault.serverUrl : 'Local vault',
          },
        ]
      : []),
  ]);
  const calendarSources = uniqueSources(
    calendars.map((calendar) => ({
      key: `calendar:${calendar.id}`,
      label: calendar.name,
      description:
        calendar.location.kind === 'hosted'
          ? calendar.location.serverUrl
          : calendar.location.kind === 'local'
            ? 'Local calendar'
            : calendar.location.kind === 'subscription'
              ? 'Subscribed calendar'
              : 'Kanban tasks',
      color: calendar.color,
    })),
  );
  const savePreferences = async () => {
    if (!profileId || !preferences) return;
    setBusy(true);
    try {
      setPreferences(await tauriCommands.notificationPreferencesSave(profileId, preferences));
      toast.success('Notification preferences saved');
    } catch (error) {
      toast.error(`Could not save notification preferences: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionLabel>Desktop notifications</SectionLabel>
      <p className="mb-2 text-[12px] text-muted-foreground">
        Permission and native delivery for reminders and background activity.
      </p>
      <OptionRow
        label="System permission"
        description={
          granted
            ? 'Collab can deliver notifications while hidden in the tray.'
            : permission?.status === 'denied'
              ? 'Notifications are blocked. Your operating system may require enabling them in system settings.'
              : 'Enable native desktop notifications for due reminders.'
        }
      >
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {granted ? (
              <CheckCircle2 size={13} className="text-emerald-500" />
            ) : (
              <BellOff size={13} />
            )}
            {permission?.status ?? 'Checking'}
          </span>
          {!granted && permission?.supported !== false && (
            <Button size="sm" onClick={() => void requestPermission()} disabled={busy}>
              <Bell size={13} /> Enable
            </Button>
          )}
        </div>
      </OptionRow>
      <OptionRow
        label="Test notification"
        description="Send a local notification without creating an inbox item."
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => void sendTest()}
          disabled={busy || !granted}
        >
          <Send size={13} /> Send test
        </Button>
      </OptionRow>
      <SectionLabel>Delivery behavior</SectionLabel>
      {preferences ? (
        <>
          <OptionRow
            label="Notifications"
            description="Keep inbox records while controlling native delivery for this profile."
          >
            <ToggleSwitch
              ariaLabel="Notifications"
              checked={preferences.enabled}
              onToggle={() =>
                updatePreferences((current) => ({ ...current, enabled: !current.enabled }))
              }
            />
          </OptionRow>
          <OptionRow
            label="Lock-screen privacy"
            description="The stricter of this setting and each notification's privacy rule is used."
          >
            <Select
              value={preferences.lockScreenPrivacy}
              onValueChange={(lockScreenPrivacy) =>
                updatePreferences((current) => ({
                  ...current,
                  lockScreenPrivacy:
                    lockScreenPrivacy as NotificationPreferences['lockScreenPrivacy'],
                }))
              }
            >
              <SelectTrigger aria-label="Lock-screen privacy" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Full content</SelectItem>
                <SelectItem value="title-only">Title only</SelectItem>
                <SelectItem value="hidden">Hidden</SelectItem>
              </SelectContent>
            </Select>
          </OptionRow>
          <OptionRow
            label="Group notification bursts"
            description="Show one summary when several notifications become due together."
          >
            <ToggleSwitch
              ariaLabel="Group notification bursts"
              checked={preferences.batchNotifications}
              onToggle={() =>
                updatePreferences((current) => ({
                  ...current,
                  batchNotifications: !current.batchNotifications,
                }))
              }
            />
          </OptionRow>
          <SectionLabel>Categories</SectionLabel>
          {CATEGORY_LABELS.map(([category, label, description]) => (
            <OptionRow key={category} label={label} description={description}>
              <ToggleSwitch
                ariaLabel={label}
                checked={preferences.categoryEnabled[category]}
                onToggle={() =>
                  updatePreferences((current) => ({
                    ...current,
                    categoryEnabled: {
                      ...current.categoryEnabled,
                      [category]: !current.categoryEnabled[category],
                    },
                  }))
                }
              />
            </OptionRow>
          ))}
          <SectionLabel>Sources</SectionLabel>
          <p className="mb-2 text-[12px] text-muted-foreground">
            Mute native delivery from individual accounts, vaults, or calendars. Their items remain
            in the inbox.
          </p>
          <div className="space-y-2">
            <ScopeGroup
              id="servers"
              label="Servers"
              emptyLabel="No saved servers"
              sources={serverSources}
              preferences={preferences}
              onToggle={toggleScope}
              expanded={expandedScope === 'servers'}
              onExpandedChange={() =>
                setExpandedScope((current) => (current === 'servers' ? null : 'servers'))
              }
            />
            <ScopeGroup
              id="vaults"
              label="Vaults"
              emptyLabel="No known vaults"
              sources={vaultSources}
              preferences={preferences}
              onToggle={toggleScope}
              expanded={expandedScope === 'vaults'}
              onExpandedChange={() =>
                setExpandedScope((current) => (current === 'vaults' ? null : 'vaults'))
              }
            />
            <ScopeGroup
              id="calendars"
              label="Calendars"
              emptyLabel="No calendars"
              sources={calendarSources}
              preferences={preferences}
              onToggle={toggleScope}
              expanded={expandedScope === 'calendars'}
              onExpandedChange={() =>
                setExpandedScope((current) => (current === 'calendars' ? null : 'calendars'))
              }
            />
          </div>
          <SectionLabel>Quiet hours</SectionLabel>
          <OptionRow
            label="Enable quiet hours"
            description="Non-urgent native notifications wait until this period ends."
          >
            <ToggleSwitch
              ariaLabel="Enable quiet hours"
              checked={preferences.quietHours !== null}
              onToggle={() =>
                updatePreferences((current) => ({
                  ...current,
                  quietHours: current.quietHours
                    ? null
                    : { startMinute: 22 * 60, endMinute: 7 * 60, timeZone: defaultTimeZone },
                }))
              }
            />
          </OptionRow>
          {preferences.quietHours && (
            <div className="space-y-3 pb-3">
              <div className="grid grid-cols-2 gap-2">
                <TimePicker
                  value={minuteToTime(preferences.quietHours.startMinute)}
                  onChange={(value) =>
                    updatePreferences((current) => ({
                      ...current,
                      quietHours: current.quietHours
                        ? { ...current.quietHours, startMinute: timeToMinute(value) }
                        : null,
                    }))
                  }
                  format={timeFormat}
                  label="Starts"
                />
                <TimePicker
                  value={minuteToTime(preferences.quietHours.endMinute)}
                  onChange={(value) =>
                    updatePreferences((current) => ({
                      ...current,
                      quietHours: current.quietHours
                        ? { ...current.quietHours, endMinute: timeToMinute(value) }
                        : null,
                    }))
                  }
                  format={timeFormat}
                  label="Ends"
                />
              </div>
              <TimeZoneSelect
                value={preferences.quietHours.timeZone}
                onValueChange={(timeZone) =>
                  updatePreferences((current) => ({
                    ...current,
                    quietHours: current.quietHours ? { ...current.quietHours, timeZone } : null,
                  }))
                }
              />
              <OptionRow
                label="Allow time-sensitive notifications"
                description="Urgent reminders may bypass quiet hours."
              >
                <ToggleSwitch
                  ariaLabel="Allow time-sensitive notifications"
                  checked={preferences.allowTimeSensitiveDuringQuietHours}
                  onToggle={() =>
                    updatePreferences((current) => ({
                      ...current,
                      allowTimeSensitiveDuringQuietHours:
                        !current.allowTimeSensitiveDuringQuietHours,
                    }))
                  }
                />
              </OptionRow>
            </div>
          )}
          <div className="flex justify-end">
            <Button size="sm" onClick={() => void savePreferences()} disabled={busy || !profileId}>
              <Save size={13} /> Save preferences
            </Button>
          </div>
        </>
      ) : (
        <p className="text-[12px] text-muted-foreground">Loading notification preferences…</p>
      )}
    </>
  );
}

function ScopeGroup({
  id,
  label,
  emptyLabel,
  sources,
  preferences,
  onToggle,
  expanded,
  onExpandedChange,
}: {
  id: NotificationScopeGroup;
  label: string;
  emptyLabel: string;
  sources: NotificationScopeSource[];
  preferences: NotificationPreferences;
  onToggle: (scopeKey: string) => void;
  expanded: boolean;
  onExpandedChange: () => void;
}) {
  const mutedCount = sources.filter(
    (source) => preferences.scopeEnabled[source.key] === false,
  ).length;
  const panelId = `notification-source-${id}`;
  return (
    <div className="overflow-hidden rounded-xl border border-border/40 bg-card/25">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-all app-motion-fast hover:bg-accent/25"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onExpandedChange}
      >
        <span>
          <span className="block text-sm font-medium">{label}</span>
          <span className="mt-0.5 block text-[12px] text-muted-foreground">
            {sources.length === 0
              ? emptyLabel
              : `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}${mutedCount ? `, ${mutedCount} muted` : ''}`}
          </span>
        </span>
        <ChevronDown
          size={16}
          className={cn(
            'shrink-0 text-muted-foreground transition-transform duration-200',
            expanded && 'rotate-180',
          )}
        />
      </button>
      {expanded && sources.length > 0 ? (
        <div id={panelId} className="border-t border-border/40 px-3 py-1.5">
          {sources.map((source) => (
            <OptionRow key={source.key} label={source.label} description={source.description}>
              <div className="flex items-center gap-2">
                {source.color ? (
                  <span
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: source.color }}
                  />
                ) : null}
                <ToggleSwitch
                  ariaLabel={`${source.label} notifications`}
                  checked={preferences.scopeEnabled[source.key] !== false}
                  onToggle={() => onToggle(source.key)}
                />
              </div>
            </OptionRow>
          ))}
        </div>
      ) : null}
    </div>
  );
}
