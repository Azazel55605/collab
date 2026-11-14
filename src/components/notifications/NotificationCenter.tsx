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
import { toast } from 'sonner';

import { getConversation } from '../../lib/conversations';
import { tauriCommands } from '../../lib/tauri';
import { cn } from '../../lib/utils';
import { useCollabStore } from '../../store/collabStore';
import { useConversationNavigation } from '../../store/conversationNavigation';
import { useServerStore } from '../../store/serverStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import type { NotificationRecord } from '../../types/notification';
import { hostedVaultMeta } from '../../types/vault';
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

type NotificationFilter = 'all' | 'messages' | 'calendar' | 'sync';

const NOTIFICATION_FILTERS: { id: NotificationFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'messages', label: 'Messages' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'sync', label: 'Sync' },
];

function matchesFilter(record: NotificationRecord, filter: NotificationFilter): boolean {
  const kind = record.envelope.kind;
  if (filter === 'all') return true;
  if (filter === 'messages') return kind.startsWith('collaboration.');
  if (filter === 'calendar') return kind.startsWith('calendar.');
  return kind.startsWith('sync.');
}

function kindTone(record: NotificationRecord): string {
  const kind = record.envelope.kind;
  if (kind.startsWith('sync.')) return 'bg-destructive/12 text-destructive';
  if (kind.startsWith('calendar.')) return 'bg-amber-500/12 text-amber-600 dark:text-amber-300';
  if (kind.startsWith('collaboration.')) return 'bg-primary/12 text-primary';
  return 'bg-muted text-muted-foreground';
}

function dayLabel(value: string): string {
  const time = Date.parse(value);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (time >= start.getTime()) return 'Today';
  if (time >= start.getTime() - 86_400_000) return 'Yesterday';
  return 'Earlier';
}

function relativeTime(value: string): string {
  const deltaMinutes = Math.round((Date.parse(value) - Date.now()) / 60_000);
  if (Math.abs(deltaMinutes) < 1) return 'now';
  if (Math.abs(deltaMinutes) < 60)
    return `${Math.abs(deltaMinutes)}m ${deltaMinutes < 0 ? 'ago' : 'from now'}`;
  const hours = Math.round(Math.abs(deltaMinutes) / 60);
  if (hours < 24) return `${hours}h ${deltaMinutes < 0 ? 'ago' : 'from now'}`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(value),
  );
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
    if (!profileId) return;
    const catchUp = async () => {
      await tauriCommands.notificationSyncRemote(profileId).catch(() => []);
      window.setTimeout(() => void refresh(), 1_000);
      window.setTimeout(() => void refresh(), 5_000);
    };
    void refresh();
    void catchUp();
    const interval = window.setInterval(() => void catchUp(), 60_000);
    const unlisteners: Array<() => void> = [];
    void listen<{ profileId?: string }>('notifications:inbox-changed', ({ payload }) => {
      if (!payload.profileId || payload.profileId === profileId) void refresh();
    }).then((unlisten) => unlisteners.push(unlisten));
    void listen('notifications:open-center', () => {
      setOpen(true);
      void refresh();
    }).then((unlisten) => unlisteners.push(unlisten));
    return () => {
      window.clearInterval(interval);
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [profileId, refresh]);

  const unread = useMemo(
    () => records.filter((record) => !record.readAt && record.state !== 'dismissed').length,
    [records],
  );

  const [filter, setFilter] = useState<NotificationFilter>('all');
  const shown = records.filter(
    (record) => record.state !== 'dismissed' && matchesFilter(record, filter),
  );
  const groups: { label: string; items: NotificationRecord[] }[] = [];
  for (const record of shown) {
    const label = dayLabel(record.envelope.scheduledAt ?? record.envelope.createdAt);
    const group = groups[groups.length - 1];
    if (group?.label === label) group.items.push(record);
    else groups.push({ label, items: [record] });
  }

  const markAllRead = async () => {
    const unreadRecords = records.filter(
      (record) => !record.readAt && record.state !== 'dismissed',
    );
    await Promise.all(
      unreadRecords.map((record) =>
        tauriCommands.notificationMarkRead(profileId, record.envelope.id, true),
      ),
    );
    await refresh();
  };

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
        window.dispatchEvent(
          new CustomEvent('calendar:open-notification', { detail: destination }),
        );
      }, 0);
    } else if (destination.kind === 'conversation') {
      const serverUrl = record.envelope.serverUrl;
      const status = serverUrl
        ? useServerStore.getState().connections[serverUrl]?.status
        : undefined;
      if (serverUrl && status?.connected && status.user) {
        const account = { serverUrl, accountId: status.user.id };
        try {
          const conversation = await getConversation(
            account,
            destination.conversationId,
            record.envelope.accountKey,
          );
          if (destination.teamId && conversation.teamId !== destination.teamId)
            throw new Error('The channel team changed.');
          useConversationNavigation
            .getState()
            .open({ ...account, conversationId: destination.conversationId });
          setActiveView('chats');
        } catch {
          toast.error('This conversation is unavailable. Reconnect or check your membership.');
          return;
        }
      }
    } else if (destination.kind === 'vault-chat') {
      const current = useVaultStore.getState().vault;
      let targetAvailable =
        current?.kind === 'hosted' && current.hostedVaultId === destination.vaultId;
      if (current?.kind !== 'hosted' || current.hostedVaultId !== destination.vaultId) {
        const match = Object.entries(useServerStore.getState().connections)
          .flatMap(([serverUrl, connection]) =>
            connection.hostedVaults.map((vault) => ({ serverUrl, vault })),
          )
          .find(({ vault }) => vault.id === destination.vaultId);
        if (match) {
          await useVaultStore
            .getState()
            .openHostedVault(hostedVaultMeta(match.serverUrl, match.vault));
          targetAvailable = true;
        }
      }
      if (targetAvailable) {
        const ui = useUiStore.getState();
        ui.setCollabTab('chat');
        ui.openVaultSidebar('collab');
      }
    } else if (destination.kind === 'settings') {
      openSettings();
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('settings:open-tab', {
            detail: {
              tab: destination.section === 'notifications' ? 'notifications' : destination.section,
            },
          }),
        );
      }, 0);
    }
    setOpen(false);
  };

  const openNotificationSettings = () => {
    openSettings();
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('settings:open-tab', {
          detail: { tab: 'notifications' },
        }),
      );
    }, 0);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void refresh();
      }}
    >
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
      <PopoverContent align="end" sideOffset={8} className="w-[380px] gap-0 overflow-hidden p-0">
        <div className="flex items-center gap-1 px-3 pt-2.5 pb-2">
          <span className="flex-1 text-[13.5px] font-semibold">Notifications</span>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => void markAllRead()}
            >
              Mark all read
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            onClick={openNotificationSettings}
            title="Notification settings"
            aria-label="Notification settings"
          >
            <Settings size={13} />
          </Button>
        </div>
        <div className="flex gap-1.5 px-3 pb-2" role="group" aria-label="Show">
          {NOTIFICATION_FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
              className={cn(
                'h-6 rounded-full px-2.5 text-[11.5px] transition-colors',
                filter === option.id
                  ? 'bg-primary/15 font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="max-h-[440px] overflow-y-auto border-t border-border/50 pb-1">
          {loading && records.length === 0 ? (
            <div className="flex h-28 items-center justify-center text-muted-foreground">
              <RefreshCw size={15} className="app-spin-soft" />
            </div>
          ) : shown.length === 0 ? (
            <div className="flex h-28 flex-col items-center justify-center gap-2 text-muted-foreground">
              <Bell size={18} />
              <span className="text-xs">
                {records.length === 0 ? 'No notifications' : 'Nothing here'}
              </span>
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.label} aria-label={group.label}>
                <h3 className="px-3 pt-2.5 pb-1 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
                  {group.label}
                </h3>
                {group.items.map((record) => {
                  const timestamp = record.envelope.scheduledAt ?? record.envelope.createdAt;
                  const tone = kindTone(record);
                  return (
                    <div
                      key={record.envelope.id}
                      className={cn(
                        'group relative flex gap-2.5 px-3 py-2 transition-colors hover:bg-muted/40',
                        !record.readAt && 'bg-primary/[0.05]',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg',
                          tone,
                        )}
                      >
                        {kindIcon(record)}
                      </span>
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left outline-none focus-visible:underline"
                        onClick={() => void openRecord(record)}
                      >
                        <span className="block truncate text-[12.5px] font-medium">
                          {record.envelope.title}
                        </span>
                        {record.envelope.body && (
                          <span className="line-clamp-2 block text-[11.5px] leading-snug text-muted-foreground">
                            {record.envelope.body}
                          </span>
                        )}
                        {record.state === 'failed' && (
                          <span className="mt-0.5 block text-[11px] text-destructive">
                            Delivery failed
                          </span>
                        )}
                      </button>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-[11px] text-muted-foreground">
                          {relativeTime(timestamp)}
                        </span>
                        {!record.readAt && (
                          <span className="size-1.5 rounded-full bg-primary" aria-label="Unread" />
                        )}
                      </div>
                      <div className="absolute top-1.5 right-2 hidden items-center gap-0.5 rounded-md border border-border/60 bg-popover p-0.5 shadow-sm group-focus-within:flex group-hover:flex">
                        {record.state === 'failed' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            title="Retry"
                            onClick={() =>
                              void tauriCommands
                                .notificationRetry(profileId, record.envelope.id)
                                .then(refresh)
                            }
                          >
                            <RefreshCw size={11} />
                          </Button>
                        )}
                        {record.envelope.category === 'calendar.reminder' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            title="Remind me in 10 minutes"
                            onClick={() => void snooze(record)}
                          >
                            <Clock3 size={11} />
                          </Button>
                        )}
                        {!record.readAt && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            onClick={() => void markRead(record)}
                            title="Mark read"
                          >
                            <Check size={11} />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6"
                          onClick={() => void dismiss(record)}
                          title="Dismiss"
                        >
                          <X size={11} />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </section>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
