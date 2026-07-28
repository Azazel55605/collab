import { Bell, Check, Clock3, RefreshCw, Send, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type {
  NotificationPermissionStatus,
  NotificationRecord,
} from '../../../../src/types/notification';
import { mobileCalendarProfileId } from '../lib/calendarSync';
import {
  notificationAndroidExactAlarmStatus,
  notificationAndroidOpenExactAlarmSettings,
  notificationDismiss,
  notificationListInbox,
  notificationMarkRead,
  notificationPermissionStatus,
  notificationReconcilePlatformSchedule,
  notificationRequestPermission,
  notificationRetry,
  notificationSendTest,
  notificationSnooze,
  type AndroidExactAlarmStatus,
} from '../mobileTauri';

export function NotificationSettingsSection() {
  const profileId = mobileCalendarProfileId();
  const [permission, setPermission] = useState<NotificationPermissionStatus | null>(null);
  const [exactAlarm, setExactAlarm] = useState<AndroidExactAlarmStatus | null>(null);
  const [records, setRecords] = useState<NotificationRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextPermission, nextExactAlarm, nextRecords] = await Promise.all([
        notificationPermissionStatus(),
        notificationAndroidExactAlarmStatus(),
        notificationListInbox(profileId),
      ]);
      setPermission(nextPermission);
      setExactAlarm(nextExactAlarm);
      setRecords(nextRecords);
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
          <strong className="setting-value">{permission?.status.replace(/-/g, ' ') ?? 'Checking'}</strong>
        </div>
        {permission?.status !== 'granted' ? (
          <button
            type="button"
            className="primary-button"
            disabled={busy || permission?.supported === false}
            onClick={() => void run(notificationRequestPermission)}
          >
            <Bell size={16} aria-hidden />
            Enable notifications
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
                <div>
                  <strong>{record.envelope.title}</strong>
                  {record.envelope.body ? <p>{record.envelope.body}</p> : null}
                  <small>{new Date(record.envelope.scheduledAt ?? record.envelope.createdAt).toLocaleString()}</small>
                </div>
                <div className="mobile-notification-actions">
                  {record.state === 'failed' ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Retry ${record.envelope.title}`}
                      onClick={() => void run(() => notificationRetry(profileId, record.envelope.id))}
                    >
                      <RefreshCw size={16} />
                    </button>
                  ) : null}
                  {record.envelope.category === 'calendar.reminder' ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Snooze ${record.envelope.title}`}
                      onClick={() => void run(() => notificationSnooze(profileId, record.envelope.id, 10))}
                    >
                      <Clock3 size={16} />
                    </button>
                  ) : null}
                  {!record.readAt ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Mark ${record.envelope.title} read`}
                      onClick={() => void run(() => notificationMarkRead(profileId, record.envelope.id))}
                    >
                      <Check size={16} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Dismiss ${record.envelope.title}`}
                    onClick={() => void run(() => notificationDismiss(profileId, record.envelope.id))}
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
