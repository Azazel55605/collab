import { useMemo, useState } from 'react';

import { toast } from 'sonner';

import { type HostedCalendarOrigin, hostedCalendarOriginKey } from '../../../lib/calendarSync';
import { useCalendarStore } from '../../../store/calendarStore';
import { useServerStore } from '../../../store/serverStore';
import { confirmAction } from '../../ui/confirm-dialog';

type CalendarState = ReturnType<typeof useCalendarStore.getState>;

export function calendarOperationLabel(
  operation: CalendarState['conflicts'][number]['operation'],
): string {
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

export function calendarProgressLabel(progress: CalendarState['syncProgress'][string]): string {
  if (progress.phase === 'discovering') return 'Checking calendars';
  if (progress.phase === 'uploading') {
    return `Uploading ${progress.processedItems}${progress.totalItems == null ? '' : ` of ${progress.totalItems}`} changes`;
  }
  if (progress.phase === 'downloading') return `Downloaded ${progress.processedItems} changes`;
  return progress.phase === 'error' ? 'Sync needs attention' : 'Sync complete';
}

export function mirrorProgressLabel(
  progress: CalendarState['mirrorProgress'][string] | undefined,
): string | null {
  if (!progress) return null;
  if (progress.phase === 'checking') return 'Checking calendars';
  if (progress.phase === 'applying') {
    return `Applying ${progress.processedOperations}${progress.totalOperations == null ? '' : ` of ${progress.totalOperations}`} changes${progress.detail ? ` · ${progress.detail}` : ''}`;
  }
  return progress.error ?? progress.detail ?? null;
}

/** Hosted calendar sync across every server: origins, conflicts, mirrors and actions. */
export function useCalendarSync() {
  const connections = useServerStore((state) => state.connections);
  const syncing = useCalendarStore((state) => state.syncing);
  const results = useCalendarStore((state) => state.syncResults);
  const progress = useCalendarStore((state) => state.syncProgress);
  const calendars = useCalendarStore((state) => state.calendars);
  const conflicts = useCalendarStore((state) => state.conflicts);
  const mirrorGroups = useCalendarStore((state) => state.mirrorGroups);
  const mirrorConflicts = useCalendarStore((state) => state.mirrorConflicts);
  const mirrorStatuses = useCalendarStore((state) => state.mirrorStatuses);
  const mirrorProgress = useCalendarStore((state) => state.mirrorProgress);
  const syncHosted = useCalendarStore((state) => state.syncHosted);
  const retryConflict = useCalendarStore((state) => state.retryConflict);
  const discardConflict = useCalendarStore((state) => state.discardConflict);
  const removeHostedCache = useCalendarStore((state) => state.removeHostedCache);
  const [activeConflict, setActiveConflict] = useState<string | null>(null);

  const connectedOrigins = useMemo(
    () =>
      Object.values(connections).flatMap((connection) => {
        const { status } = connection;
        return status.connected && status.serverUrl && status.user
          ? [{ serverUrl: status.serverUrl, userId: status.user.id }]
          : [];
      }),
    [connections],
  );
  const origins = useMemo(
    () =>
      Array.from(
        new Map(
          [
            ...connectedOrigins,
            ...calendars.flatMap((calendar) =>
              calendar.location.kind === 'hosted'
                ? [{ serverUrl: calendar.location.serverUrl, userId: calendar.location.userId }]
                : [],
            ),
          ].map((origin) => [hostedCalendarOriginKey(origin), origin]),
        ).values(),
      ),
    [calendars, connectedOrigins],
  );
  const connectedOriginKeys = useMemo(
    () => new Set(connectedOrigins.map(hostedCalendarOriginKey)),
    [connectedOrigins],
  );

  const failures = results.filter((result) => result.error);
  const latest = results.reduce<string | undefined>(
    (value, result) => (!value || result.completedAt > value ? result.completedAt : value),
    undefined,
  );
  const activeMirrorProgress = Object.values(mirrorProgress).filter(
    (entry) => entry.phase === 'checking' || entry.phase === 'applying',
  );
  const mirrorErrors = mirrorStatuses.filter((status) => status.state === 'error');
  const waitingMirrors = mirrorStatuses.filter((status) => status.state === 'waiting');
  const conflictCount = conflicts.length + mirrorConflicts.length;
  const busy = syncing || activeMirrorProgress.length > 0;
  const issueCount = conflicts.length + failures.length + mirrorErrors.length;

  const sync = () => syncHosted(connectedOrigins);

  const retry = async (clientOperationId: string) => {
    setActiveConflict(clientOperationId);
    try {
      await retryConflict(clientOperationId);
      await syncHosted(connectedOrigins);
    } finally {
      setActiveConflict(null);
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

  const removeCache = async (origin: HostedCalendarOrigin) => {
    const host = new URL(origin.serverUrl).host;
    const confirmed = await confirmAction({
      title: `Remove cached calendars from ${host}?`,
      description: 'Only the copy on this device goes; the calendars on the server stay intact.',
      confirmLabel: 'Remove cache',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await removeHostedCache(origin);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  return {
    active: origins.length > 0,
    origins,
    connectedOrigins,
    connectedOriginKeys,
    results,
    progress,
    calendarCount: calendars.filter((calendar) => calendar.location.kind === 'hosted').length,
    conflicts,
    failures,
    latest,
    mirrorGroups,
    mirrorConflicts,
    mirrorStatuses,
    mirrorProgress,
    activeMirrorProgress,
    mirrorErrors,
    waitingMirrors,
    conflictCount,
    issueCount,
    syncing,
    busy,
    activeConflict,
    sync,
    retry,
    discard,
    removeCache,
  };
}

export type CalendarSyncModel = ReturnType<typeof useCalendarSync>;
