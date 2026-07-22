import { useMemo, useState } from 'react';
import { AlertTriangle, CalendarDays, Check, Loader2, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useCalendarStore } from '../../store/calendarStore';
import { useServerStore } from '../../store/serverStore';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { cn } from '../../lib/utils';
import { hostedCalendarOriginKey, type HostedCalendarOrigin } from '../../lib/calendarSync';

function syncTime(value: string | undefined): string {
  if (!value) return 'not synced yet';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

function operationLabel(operation: ReturnType<typeof useCalendarStore.getState>['conflicts'][number]['operation']): string {
  switch (operation.mutation.type) {
    case 'createCalendar':
    case 'updateCalendar':
      return operation.mutation.calendar.name;
    case 'deleteCalendar':
      return `Calendar ${operation.mutation.calendarId}`;
    case 'upsertItem':
      return operation.mutation.item.title;
    case 'deleteItem':
      return `Deleted item ${operation.mutation.itemId}`;
  }
}

function progressLabel(progress: ReturnType<typeof useCalendarStore.getState>['syncProgress'][string]): string {
  if (progress.phase === 'discovering') return 'Checking calendars';
  if (progress.phase === 'uploading') {
    return `Uploading ${progress.processedItems}${progress.totalItems == null ? '' : ` of ${progress.totalItems}`} changes`;
  }
  if (progress.phase === 'downloading') return `Downloaded ${progress.processedItems} changes`;
  return progress.phase === 'error' ? 'Sync needs attention' : 'Sync complete';
}

export default function CalendarSyncStatusIndicator() {
  const connections = useServerStore((state) => state.connections);
  const syncing = useCalendarStore((state) => state.syncing);
  const results = useCalendarStore((state) => state.syncResults);
  const progress = useCalendarStore((state) => state.syncProgress);
  const calendars = useCalendarStore((state) => state.calendars);
  const conflicts = useCalendarStore((state) => state.conflicts);
  const syncHosted = useCalendarStore((state) => state.syncHosted);
  const retryConflict = useCalendarStore((state) => state.retryConflict);
  const discardConflict = useCalendarStore((state) => state.discardConflict);
  const removeHostedCache = useCalendarStore((state) => state.removeHostedCache);
  const [open, setOpen] = useState(false);
  const [activeConflict, setActiveConflict] = useState<string | null>(null);
  const connectedOrigins = useMemo(() => Object.values(connections).flatMap((connection) => {
    const { status } = connection;
    return status.connected && status.serverUrl && status.user
      ? [{ serverUrl: status.serverUrl, userId: status.user.id }]
      : [];
  }), [connections]);
  const origins = useMemo(() => Array.from(new Map([
    ...connectedOrigins,
    ...calendars.flatMap((calendar) => calendar.location.kind === 'hosted'
      ? [{ serverUrl: calendar.location.serverUrl, userId: calendar.location.userId }]
      : []),
  ].map((origin) => [hostedCalendarOriginKey(origin), origin])).values()), [calendars, connectedOrigins]);
  const connectedOriginKeys = useMemo(
    () => new Set(connectedOrigins.map(hostedCalendarOriginKey)),
    [connectedOrigins],
  );
  if (origins.length === 0) return null;

  const failures = results.filter((result) => result.error);
  const latest = results.reduce<string | undefined>((value, result) => (
    !value || result.completedAt > value ? result.completedAt : value
  ), undefined);
  const label = syncing
    ? 'Calendars syncing'
    : conflicts.length > 0
      ? `${conflicts.length} calendar conflict${conflicts.length === 1 ? '' : 's'}`
      : failures.length > 0
      ? `${failures.length} calendar issue${failures.length === 1 ? '' : 's'}`
      : 'Calendars synced';
  const hasIssues = failures.length > 0 || conflicts.length > 0;

  const retry = async (clientOperationId: string) => {
    setActiveConflict(clientOperationId);
    try {
      await retryConflict(clientOperationId);
      await syncHosted(connectedOrigins);
    } finally {
      setActiveConflict(null);
    }
  };

  const removeCache = async (origin: HostedCalendarOrigin) => {
    const host = new URL(origin.serverUrl).host;
    if (!window.confirm(`Remove cached calendars from ${host}? This keeps the server calendars intact.`)) return;
    try {
      await removeHostedCache(origin);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };

  const discard = async (clientOperationId: string) => {
    setActiveConflict(clientOperationId);
    try {
      await discardConflict(clientOperationId);
    } finally {
      setActiveConflict(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'flex items-center gap-1 transition-colors app-motion-fast',
            hasIssues ? 'text-destructive hover:text-destructive' : 'hover:text-foreground',
          )}
          title="Calendar sync status"
        >
          {syncing
            ? <RefreshCw size={11} className="app-spin-soft" />
            : hasIssues
              ? <AlertTriangle size={11} />
              : <CalendarDays size={11} />}
          <span className="text-[10px]">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-0 text-xs app-fade-scale-in">
        <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
          <div>
            <p className="font-medium text-foreground">Hosted calendars</p>
            <p className="text-[10px] text-muted-foreground">last synced {syncTime(latest)}</p>
          </div>
          <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" disabled={syncing || connectedOrigins.length === 0} onClick={() => void syncHosted(connectedOrigins)}>
            {syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            Sync now
          </Button>
        </div>
        <div className="max-h-64 space-y-1 overflow-y-auto p-2">
          {conflicts.length > 0 && (
            <div className="mb-2 border-b border-border/50 pb-2">
              <p className="px-2 pb-1 text-[10px] font-medium uppercase text-muted-foreground">Needs attention</p>
              {conflicts.map((conflict) => {
                const operationId = conflict.operation.clientOperationId;
                const busy = activeConflict === operationId;
                return (
                  <div key={operationId} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0 text-destructive" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-medium text-foreground">{operationLabel(conflict.operation)}</p>
                      <p className="line-clamp-2 text-[10px] text-destructive" title={conflict.lastError}>{conflict.lastError}</p>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0"
                      disabled={activeConflict != null || syncing}
                      title="Retry change"
                      onClick={() => void retry(operationId)}
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
                      disabled={activeConflict != null || syncing}
                      title="Discard pending change"
                      onClick={() => void discard(operationId)}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
          {origins.map((origin) => {
            const result = results.find((entry) => entry.serverUrl === origin.serverUrl);
            const originKey = hostedCalendarOriginKey(origin);
            const activeProgress = progress[originKey];
            const connected = connectedOriginKeys.has(originKey);
            return (
              <div key={`${origin.serverUrl}:${origin.userId}`} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40">
                {result?.error
                  ? <AlertTriangle size={12} className="mt-0.5 shrink-0 text-destructive" />
                  : result
                    ? <Check size={12} className="mt-0.5 shrink-0 text-emerald-500" />
                    : <CalendarDays size={12} className="mt-0.5 shrink-0 text-muted-foreground" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-medium text-foreground">{new URL(origin.serverUrl).host}</p>
                  <p className={cn('truncate text-[10px] text-muted-foreground', result?.error && 'text-destructive')} title={result?.error}>
                    {activeProgress && activeProgress.phase !== 'complete' && activeProgress.phase !== 'error'
                      ? progressLabel(activeProgress)
                      : result?.error ?? (result
                      ? `${result.replayedOperations} uploaded, ${result.appliedChanges} downloaded`
                      : connected ? 'Waiting for first sync' : 'Cached offline')}
                  </p>
                </div>
                {!connected ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                    disabled={syncing || activeConflict != null}
                    title="Remove cached calendars"
                    onClick={() => void removeCache(origin)}
                  >
                    <Trash2 size={12} />
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
