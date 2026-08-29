import { useCallback, useEffect, useState } from 'react';

import {
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Gift,
  MessageSquare,
  RefreshCw,
  Save,
  Send,
  X,
} from 'lucide-react';

import { DEFAULT_NOTIFICATION_PREFERENCES } from '../../../../src/lib/notificationContract';
import type { CalendarDefinition } from '../../../../src/types/calendar';
import type {
  NotificationCategory,
  NotificationPermissionStatus,
  NotificationPreferences,
  NotificationRecord,
} from '../../../../src/types/notification';
import { mobileCalendarProfileId } from '../lib/calendarSync';
import {
  type AndroidExactAlarmStatus,
  listProfileCalendars,
  notificationAndroidExactAlarmStatus,
  notificationAndroidOpenExactAlarmSettings,
  notificationDismiss,
  notificationListInbox,
  notificationMarkRead,
  notificationPermissionStatus,
  notificationPreferencesGet,
  notificationPreferencesSave,
  notificationReconcilePlatformSchedule,
  notificationRequestPermission,
  notificationRetry,
  notificationSendTest,
  notificationSnooze,
} from '../mobileTauri';
import { useMobileStore } from '../state/store';

import { TimeField } from './TimeField';

const CATEGORY_LABELS: Array<[NotificationCategory, string]> = [
  ['calendar.reminder', 'Calendar reminders'],
  ['calendar.invitation', 'Calendar invitations'],
  ['collaboration.message', 'Chat messages'],
  ['collaboration.mention', 'Mentions'],
  ['sync.action-required', 'Sync and account'],
  ['transfer.complete', 'Transfers'],
];

function minuteToTime(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function timeToMinute(value: string) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function notificationIcon(record: NotificationRecord) {
  const kind = record.envelope.kind ?? '';
  if (kind === 'calendar.birthday-reminder') return <Gift size={17} aria-hidden />;
  if (kind.startsWith('calendar.')) return <CalendarDays size={17} aria-hidden />;
  if (kind.startsWith('collaboration.')) return <MessageSquare size={17} aria-hidden />;
  if (kind.startsWith('sync.')) return <CircleAlert size={17} aria-hidden />;
  return <Bell size={17} aria-hidden />;
}

export function NotificationSettingsSection() {
  const profileId = mobileCalendarProfileId();
  const servers = useMobileStore((state) => state.servers);
  const vaults = useMobileStore((state) => state.vaults);
  const [permission, setPermission] = useState<NotificationPermissionStatus | null>(null);
  const [exactAlarm, setExactAlarm] = useState<AndroidExactAlarmStatus | null>(null);
  const [records, setRecords] = useState<NotificationRecord[]>([]);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [expandedScope, setExpandedScope] = useState<'servers' | 'vaults' | 'calendars' | null>(
    null,
  );
  const [calendars, setCalendars] = useState<CalendarDefinition[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextPermission, nextExactAlarm, nextRecords, nextPreferences, nextCalendars] =
        await Promise.all([
          notificationPermissionStatus(),
          notificationAndroidExactAlarmStatus(),
          notificationListInbox(profileId),
          notificationPreferencesGet(profileId),
          listProfileCalendars(profileId),
        ]);
      setPermission(nextPermission);
      setExactAlarm(nextExactAlarm);
      setRecords(nextRecords);
      setPreferences(nextPreferences);
      setCalendars(nextCalendars.filter((calendar) => !calendar.deletedAt));
      setError(null);
      if (nextPermission.status === 'granted') {
        await notificationReconcilePlatformSchedule(profileId);
      }
    } catch (reason) {
      setError(String(reason));
    }
  }, [profileId]);

  useEffect(() => {
    void refresh();
    const onPermission = () => void refresh();
    window.addEventListener('focus', onPermission);
    window.addEventListener('collab-notification-permission-changed', onPermission);
    return () => {
      window.removeEventListener('focus', onPermission);
      window.removeEventListener('collab-notification-permission-changed', onPermission);
    };
  }, [refresh]);

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
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
  const serverSources = servers.map((server) => ({
    key: `server:${server.serverUrl}`,
    label: server.username || server.serverUrl,
    description: server.username ? server.serverUrl : undefined,
  }));
  const vaultSources = Object.entries(vaults).flatMap(([serverUrl, serverVaults]) =>
    serverVaults.map((vault) => ({
      key: `vault:${vault.id}`,
      label: vault.name,
      description: serverUrl,
    })),
  );
  const calendarSources = calendars.map((calendar) => ({
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
  }));

  return (
    <>
      <section className="card">
        <div className="card-title">
          <Bell size={18} aria-hidden />
          <span>Android notifications</span>
        </div>
        <div className="setting-row">
          <div>
            <strong>Notification permission</strong>
            <span>Required for reminders while Collab is closed.</span>
          </div>
          <strong className="setting-value">
            {permission?.status.replace(/-/g, ' ') ?? 'Checking'}
          </strong>
        </div>
        {permission?.status !== 'granted' ? (
          <button
            type="button"
            className="primary-button"
            disabled={busy || permission?.supported === false}
            onClick={() => void run(notificationRequestPermission)}
          >
            <Bell size={16} aria-hidden />
            {permission?.status === 'denied'
              ? 'Open notification settings'
              : 'Enable notifications'}
          </button>
        ) : (
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            onClick={() => void run(notificationSendTest)}
          >
            <Send size={16} aria-hidden />
            Send test notification
          </button>
        )}
        <div className="setting-row">
          <div>
            <strong>Reminder timing</strong>
            <span>
              {exactAlarm?.status === 'fallback'
                ? 'Android may delay reminders because exact alarms are disabled.'
                : 'Exact alarm delivery is available.'}
            </span>
          </div>
          <strong className="setting-value">{exactAlarm?.status ?? 'Checking'}</strong>
        </div>
        {exactAlarm?.status === 'fallback' ? (
          <button
            type="button"
            className="ghost-button"
            disabled={busy}
            onClick={() => void run(notificationAndroidOpenExactAlarmSettings)}
          >
            <Clock3 size={16} aria-hidden />
            Open alarm settings
          </button>
        ) : null}
        {preferences ? (
          <>
            <label className="toggle-row">
              <span>
                <strong>Notifications</strong>
                <small>Control native delivery for this device profile.</small>
              </span>
              <input
                type="checkbox"
                checked={preferences.enabled}
                onChange={() =>
                  updatePreferences((current) => ({ ...current, enabled: !current.enabled }))
                }
              />
            </label>
            <div className="setting-row stacked">
              <div>
                <strong>Lock-screen privacy</strong>
                <span>Limit content shown outside Collab.</span>
              </div>
              <div className="segmented-control" role="group" aria-label="Lock-screen privacy">
                {(
                  [
                    ['full', 'Full'],
                    ['title-only', 'Title'],
                    ['hidden', 'Hidden'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={preferences.lockScreenPrivacy === value ? 'selected' : ''}
                    onClick={() =>
                      updatePreferences((current) => ({
                        ...current,
                        lockScreenPrivacy: value,
                      }))
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="toggle-row">
              <span>
                <strong>Group notification bursts</strong>
                <small>Use summaries when several items become due together.</small>
              </span>
              <input
                type="checkbox"
                checked={preferences.batchNotifications}
                onChange={() =>
                  updatePreferences((current) => ({
                    ...current,
                    batchNotifications: !current.batchNotifications,
                  }))
                }
              />
            </label>
            {CATEGORY_LABELS.map(([category, label]) => (
              <label className="toggle-row" key={category}>
                <span>
                  <strong>{label}</strong>
                </span>
                <input
                  type="checkbox"
                  checked={preferences.categoryEnabled[category]}
                  onChange={() =>
                    updatePreferences((current) => ({
                      ...current,
                      categoryEnabled: {
                        ...current.categoryEnabled,
                        [category]: !current.categoryEnabled[category],
                      },
                    }))
                  }
                />
              </label>
            ))}
            <div className="setting-row stacked">
              <div>
                <strong>Notification sources</strong>
                <span>Muted sources remain available in the notification inbox.</span>
              </div>
              <div className="mobile-notification-sources">
                <MobileScopeGroup
                  id="servers"
                  label="Servers"
                  sources={serverSources}
                  preferences={preferences}
                  onToggle={toggleScope}
                  expanded={expandedScope === 'servers'}
                  onExpandedChange={() =>
                    setExpandedScope((current) => (current === 'servers' ? null : 'servers'))
                  }
                />
                <MobileScopeGroup
                  id="vaults"
                  label="Vaults"
                  sources={vaultSources}
                  preferences={preferences}
                  onToggle={toggleScope}
                  expanded={expandedScope === 'vaults'}
                  onExpandedChange={() =>
                    setExpandedScope((current) => (current === 'vaults' ? null : 'vaults'))
                  }
                />
                <MobileScopeGroup
                  id="calendars"
                  label="Calendars"
                  sources={calendarSources}
                  preferences={preferences}
                  onToggle={toggleScope}
                  expanded={expandedScope === 'calendars'}
                  onExpandedChange={() =>
                    setExpandedScope((current) => (current === 'calendars' ? null : 'calendars'))
                  }
                />
              </div>
            </div>
            <label className="toggle-row">
              <span>
                <strong>Quiet hours</strong>
                <small>Delay non-urgent native notifications.</small>
              </span>
              <input
                type="checkbox"
                checked={preferences.quietHours !== null}
                onChange={() =>
                  updatePreferences((current) => ({
                    ...current,
                    quietHours: current.quietHours
                      ? null
                      : {
                          startMinute: 22 * 60,
                          endMinute: 7 * 60,
                          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                        },
                  }))
                }
              />
            </label>
            {preferences.quietHours ? (
              <>
                <div className="mobile-notification-quiet-times">
                  <label>
                    <span>Starts</span>
                    <TimeField
                      label="Quiet hours start"
                      format="system"
                      value={minuteToTime(preferences.quietHours.startMinute)}
                      onChange={(value) =>
                        updatePreferences((current) => ({
                          ...current,
                          quietHours: current.quietHours
                            ? { ...current.quietHours, startMinute: timeToMinute(value) }
                            : null,
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>Ends</span>
                    <TimeField
                      label="Quiet hours end"
                      format="system"
                      value={minuteToTime(preferences.quietHours.endMinute)}
                      onChange={(value) =>
                        updatePreferences((current) => ({
                          ...current,
                          quietHours: current.quietHours
                            ? { ...current.quietHours, endMinute: timeToMinute(value) }
                            : null,
                        }))
                      }
                    />
                  </label>
                </div>
                <p className="footnote">{preferences.quietHours.timeZone}</p>
                <label className="toggle-row">
                  <span>
                    <strong>Allow time-sensitive notifications</strong>
                    <small>Urgent reminders may bypass quiet hours.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={preferences.allowTimeSensitiveDuringQuietHours}
                    onChange={() =>
                      updatePreferences((current) => ({
                        ...current,
                        allowTimeSensitiveDuringQuietHours:
                          !current.allowTimeSensitiveDuringQuietHours,
                      }))
                    }
                  />
                </label>
              </>
            ) : null}
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setPreferences(await notificationPreferencesSave(profileId, preferences));
                })
              }
            >
              <Save size={16} aria-hidden />
              Save notification preferences
            </button>
          </>
        ) : null}
        {error ? <p className="footnote error-text">{error}</p> : null}
      </section>

      <section className="card">
        <div className="card-title">
          <Bell size={18} aria-hidden />
          <span>Notification inbox</span>
        </div>
        {records.length === 0 ? (
          <p className="footnote">No notifications.</p>
        ) : (
          <div className="mobile-notification-list">
            {records.map((record) => (
              <article
                key={record.envelope.id}
                className={`mobile-notification-row ${record.readAt ? '' : 'unread'}`}
              >
                <div className="mobile-notification-kind-icon">{notificationIcon(record)}</div>
                <div>
                  <strong>{record.envelope.title}</strong>
                  {record.envelope.body ? <p>{record.envelope.body}</p> : null}
                  <small>
                    {new Date(
                      record.envelope.scheduledAt ?? record.envelope.createdAt,
                    ).toLocaleString()}
                  </small>
                </div>
                <div className="mobile-notification-actions">
                  {record.state === 'failed' ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Retry ${record.envelope.title}`}
                      onClick={() =>
                        void run(() => notificationRetry(profileId, record.envelope.id))
                      }
                    >
                      <RefreshCw size={16} />
                    </button>
                  ) : null}
                  {record.envelope.category === 'calendar.reminder' ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Snooze ${record.envelope.title}`}
                      onClick={() =>
                        void run(() => notificationSnooze(profileId, record.envelope.id, 10))
                      }
                    >
                      <Clock3 size={16} />
                    </button>
                  ) : null}
                  {!record.readAt ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Mark ${record.envelope.title} read`}
                      onClick={() =>
                        void run(() => notificationMarkRead(profileId, record.envelope.id))
                      }
                    >
                      <Check size={16} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Dismiss ${record.envelope.title}`}
                    onClick={() =>
                      void run(() => notificationDismiss(profileId, record.envelope.id))
                    }
                  >
                    <X size={16} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function MobileScopeGroup({
  id,
  label,
  sources,
  preferences,
  onToggle,
  expanded,
  onExpandedChange,
}: {
  id: 'servers' | 'vaults' | 'calendars';
  label: string;
  sources: Array<{ key: string; label: string; description?: string; color?: string }>;
  preferences: NotificationPreferences;
  onToggle: (scopeKey: string) => void;
  expanded: boolean;
  onExpandedChange: () => void;
}) {
  const mutedCount = sources.filter(
    (source) => preferences.scopeEnabled[source.key] === false,
  ).length;
  return (
    <div className="mobile-notification-source-group">
      <button
        type="button"
        className="mobile-notification-source-trigger"
        aria-expanded={expanded}
        aria-controls={`mobile-notification-source-${id}`}
        onClick={onExpandedChange}
      >
        <span>
          <strong>{label}</strong>
          <small>
            {sources.length === 0
              ? `No ${label.toLowerCase()}`
              : `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}${mutedCount ? `, ${mutedCount} muted` : ''}`}
          </small>
        </span>
        <ChevronDown aria-hidden="true" className={expanded ? 'expanded' : ''} />
      </button>
      {expanded && sources.length > 0 ? (
        <div id={`mobile-notification-source-${id}`} className="mobile-notification-source-content">
          {sources.map((source) => (
            <label className="toggle-row" key={source.key}>
              <span>
                <strong>
                  {source.color ? <i style={{ backgroundColor: source.color }} /> : null}
                  {source.label}
                </strong>
                {source.description ? <small>{source.description}</small> : null}
              </span>
              <input
                type="checkbox"
                aria-label={`${source.label} notifications`}
                checked={preferences.scopeEnabled[source.key] !== false}
                onChange={() => onToggle(source.key)}
              />
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
