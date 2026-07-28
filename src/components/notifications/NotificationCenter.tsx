import { useCallback, useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Bell,
  CalendarDays,
  Check,
  CircleAlert,
  Clock3,
  Gift,
  MessageSquare,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react';
import { tauriCommands } from '../../lib/tauri';
import { cn } from '../../lib/utils';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';
import type { NotificationRecord } from '../../types/notification';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

function kindIcon(record: NotificationRecord) {
  switch (record.envelope.kind) {
    case 'calendar.birthday-reminder':
      return <Gift size={14} />;
    case 'calendar.event-reminder':
    case 'calendar.task-reminder':
    case 'calendar.invitation':
    case 'calendar.invitation-update':
      return <CalendarDays size={14} />;
    case 'collaboration.message':
    case 'collaboration.mention':
      return <MessageSquare size={14} />;
    case 'sync.conflict':
    case 'sync.authentication-required':
    case 'sync.permission-denied':
      return <CircleAlert size={14} />;
    default:
      return <Bell size={14} />;
  }
}

function relativeTime(value: string): string {
  const deltaMinutes = Math.round((Date.parse(value) - Date.now()) / 60_000);
  if (Math.abs(deltaMinutes) < 1) return 'now';
  if (Math.abs(deltaMinutes) < 60) return `${Math.abs(deltaMinutes)}m ${deltaMinutes < 0 ? 'ago' : 'from now'}`;
  const hours = Math.round(Math.abs(deltaMinutes) / 60);
  if (hours < 24) return `${hours}h ${deltaMinutes < 0 ? 'ago' : 'from now'}`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
    .format(new Date(value));
}

export default function NotificationCenter() {
  const profileId = useCollabStore((state) => state.myUserId);
  const setActiveView = useUiStore((state) => state.setActiveView);
  const openSettings = useUiStore((state) => state.openSettings);
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<NotificationRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!profileId) return;
    setLoading(true);
    try {
      setRecords(await tauriCommands.notificationListInbox(profileId, false, 200));
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    void refresh();
    const unlisteners: Array<() => void> = [];
    void listen<{ profileId?: string }>('notifications:inbox-changed', ({ payload }) => {
      if (!payload.profileId || payload.profileId === profileId) void refresh();
    }).then((unlisten) => unlisteners.push(unlisten));
    void listen('notifications:open-center', () => {
      setOpen(true);
      void refresh();
    }).then((unlisten) => unlisteners.push(unlisten));
    return () => unlisteners.forEach((unlisten) => unlisten());
  }, [profileId, refresh]);

  const unread = useMemo(
    () => records.filter((record) => !record.readAt && record.state !== 'dismissed').length,
    [records],
  );

  const markRead = async (record: NotificationRecord) => {
    await tauriCommands.notificationMarkRead(profileId, record.envelope.id, true);
    await refresh();
  };

  const dismiss = async (record: NotificationRecord) => {
    await tauriCommands.notificationDismiss(profileId, record.envelope.id);
    await refresh();
  };

  const snooze = async (record: NotificationRecord) => {
    await tauriCommands.notificationSnooze(profileId, record.envelope.id, 10);
    await refresh();
  };

  const openRecord = async (record: NotificationRecord) => {
    await markRead(record);
    const destination = record.envelope.destination;
    if (destination.kind === 'calendar-item' || destination.kind === 'calendar-invitations') {
      setActiveView('calendar');
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('calendar:open-notification', { detail: destination }));
      }, 0);
    } else if (destination.kind === 'settings') {
      openSettings();
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('settings:open-tab', {
          detail: { tab: destination.section === 'notifications' ? 'notifications' : destination.section },
        }));
      }, 0);
    }
    setOpen(false);
  };

  const openNotificationSettings = () => {
    openSettings();
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('settings:open-tab', {
        detail: { tab: 'notifications' },
      }));
    }, 0);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) void refresh();
    }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative flex size-5 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
          title="Notifications"
        >
          <Bell size={11} />
          {unread > 0 && (
            <span className="absolute -right-1.5 -top-1.5 min-w-3 rounded-full bg-primary px-0.5 text-center text-[8px] font-semibold leading-3 text-primary-foreground">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[360px] overflow-hidden p-0">
        <div className="flex h-10 items-center justify-between border-b border-border/50 px-3">
          <div className="flex items-center gap-2">
            <Bell size={14} />
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && <span className="text-[10px] text-muted-foreground">{unread} unread</span>}
          </div>
          <Button variant="ghost" size="icon" className="size-7" onClick={openNotificationSettings} title="Notification settings">
            <Settings size={13} />
          </Button>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {loading && records.length === 0 ? (
            <div className="flex h-28 items-center justify-center text-muted-foreground">
              <RefreshCw size={15} className="app-spin-soft" />
            </div>
          ) : records.length === 0 ? (
            <div className="flex h-28 flex-col items-center justify-center gap-2 text-muted-foreground">
              <Bell size={18} />
              <span className="text-xs">No notifications</span>
            </div>
          ) : records.map((record) => {
            const timestamp = record.envelope.scheduledAt ?? record.envelope.createdAt;
            return (
              <div
                key={record.envelope.id}
                className={cn(
                  'group border-b border-border/40 px-3 py-2.5 last:border-b-0',
                  !record.readAt && 'bg-primary/[0.04]',
                )}
              >
                <button type="button" className="flex w-full gap-2.5 text-left" onClick={() => void openRecord(record)}>
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                    {kindIcon(record)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{record.envelope.title}</span>
                    {record.envelope.body && (
                      <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">
                        {record.envelope.body}
                      </span>
                    )}
                    <span className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/70">
                      <Clock3 size={9} />
                      {relativeTime(timestamp)}
                      {record.state === 'failed' && <span className="text-destructive">Delivery failed</span>}
                    </span>
                  </span>
                </button>
                <div className="mt-1.5 flex justify-end gap-1">
                  {record.state === 'failed' && (
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => void tauriCommands.notificationRetry(profileId, record.envelope.id).then(refresh)}>
                      <RefreshCw size={10} /> Retry
                    </Button>
                  )}
                  {record.envelope.category === 'calendar.reminder' && (
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => void snooze(record)}>
                      <Clock3 size={10} /> 10 min
                    </Button>
                  )}
                  {!record.readAt && (
                    <Button variant="ghost" size="icon" className="size-6" onClick={() => void markRead(record)} title="Mark read">
                      <Check size={11} />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="size-6" onClick={() => void dismiss(record)} title="Dismiss">
                    <X size={11} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
