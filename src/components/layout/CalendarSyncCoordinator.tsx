import { useCallback, useEffect, useMemo } from 'react';

import { listen } from '@tauri-apps/api/event';

import { subscribeBackgroundPoll } from '../../lib/backgroundPolls';
import { type HostedCalendarOrigin, normalizeHostedCalendarOrigins } from '../../lib/calendarSync';
import { CoalescedTask } from '../../lib/coalescedTask';
import {
  type CalendarFileChange,
  calendarInvalidationPaths,
  projectLocalKanbanCalendar,
} from '../../lib/kanbanCalendarProjection';
import type { LocalKanbanProjectionSource } from '../../lib/kanbanCalendarProjection';
import { registerDocumentResourceCleanup } from '../../lib/sharedDocumentResources';
import { tauriCommands } from '../../lib/tauri';
import { createVaultClient } from '../../lib/vaultClient';
import { vaultTreeIndex } from '../../lib/vaultTreeIndex';
import { useCalendarStore } from '../../store/calendarStore';
import { useCollabStore } from '../../store/collabStore';
import { useServerStore } from '../../store/serverStore';
import { useVaultStore } from '../../store/vaultStore';

const BACKGROUND_SYNC_INTERVAL_MS = 60_000;

type SourceCache = Map<string, { stamp: string; source: LocalKanbanProjectionSource }>;
const sourceCaches = new Map<string, SourceCache>();
let sourceGeneration = 0;
registerDocumentResourceCleanup(() => {
  sourceGeneration++;
  sourceCaches.clear();
  sourceEpochs.clear();
});
const sourceEpochs = new Map<string, number>();
const localTasks = new Map<string, CoalescedTask>();
function scopeKey(
  profileId: string,
  vault: NonNullable<ReturnType<typeof useVaultStore.getState>['vault']>,
) {
  return JSON.stringify([profileId, vault.id, vault.kind === 'local' ? vault.path : 'hosted']);
}
function invalidateSource(
  profileId: string,
  vault: NonNullable<ReturnType<typeof useVaultStore.getState>['vault']>,
  path: string,
) {
  const key = scopeKey(profileId, vault);
  sourceEpochs.set(key, (sourceEpochs.get(key) ?? 0) + 1);
  const cache = sourceCaches.get(key);
  for (const [source, entry] of cache ?? [])
    if (source === path || source.startsWith(`${path}/`)) entry.stamp = '';
}
export async function syncLocalKanbanProjection(
  profileId: string,
  vault: NonNullable<ReturnType<typeof useVaultStore.getState>['vault']>,
): Promise<void> {
  const key = scopeKey(profileId, vault);
  let task = localTasks.get(key);
  if (!task) {
    task = new CoalescedTask();
    localTasks.set(key, task);
  }
  try {
    await task.run(() => projectLocal(profileId, vault));
  } finally {
    if (localTasks.get(key) === task) localTasks.delete(key);
  }
}
async function projectLocal(
  profileId: string,
  vault: NonNullable<ReturnType<typeof useVaultStore.getState>['vault']>,
): Promise<void> {
  if (vault.kind === 'hosted') return;
  const client = createVaultClient(vault);
  const key = scopeKey(profileId, vault);
  const generation = sourceGeneration;
  const state = useVaultStore.getState();
  if (state.isVaultLocked) return;
  if (state.vault?.id === vault.id && state.isLoading) return;
  const tree = state.vault?.id === vault.id ? state.fileTree : await client.listFiles();
  const files = vaultTreeIndex(tree).files.filter((file) =>
    file.relativePath.toLowerCase().endsWith('.kanban'),
  );
  const epoch = sourceEpochs.get(key) ?? 0;
  const previous = sourceCaches.get(key);
  const initial = !previous;
  const cache = new Map(previous);
  const present = new Set(files.map((file) => file.relativePath));
  let changed = initial;
  for (const path of cache.keys())
    if (!present.has(path)) {
      cache.delete(path);
      changed = true;
    }
  const sources: LocalKanbanProjectionSource[] = [];
  let retainedBytes = 0;
  for (const file of files) {
    const stamp = JSON.stringify([file.modifiedAt, file.size, file.contentRevision]);
    const hit = cache.get(file.relativePath);
    if (hit?.stamp === stamp) {
      sources.push(hit.source);
      retainedBytes += hit.source.content.length * 2;
      continue;
    }
    try {
      const document = await client.readDocument(file.relativePath);
      const source = {
        fileId: file.relativePath,
        path: file.relativePath,
        sourceRevision: Math.max(0, Math.trunc(file.modifiedAt)),
        content: document.content,
      };
      sources.push(source);
      changed = true;
      retainedBytes += source.content.length * 2;
      if (retainedBytes <= 4 * 1024 * 1024) cache.set(file.relativePath, { stamp, source });
      else cache.delete(file.relativePath);
    } catch {
      // Keep an established projection for transiently unreadable boards.
      // Actual deletions are removed by the indexed file set above.
      if (hit) sources.push(hit.source);
      else changed = true;
    }
  }
  if (!changed || generation !== sourceGeneration || useVaultStore.getState().isVaultLocked) return;
  const projection = projectLocalKanbanCalendar({
    profileId,
    originKey: `local-vault:${client.id}`,
    vaultName: client.name,
    sources,
  });
  await tauriCommands.calendarReplaceGeneratedKanban(
    profileId,
    projection.calendar,
    projection.items,
  );
  if (generation === sourceGeneration && (sourceEpochs.get(key) ?? 0) === epoch) {
    sourceCaches.set(key, cache);
    while (sourceCaches.size > 8) {
      const oldest = sourceCaches.keys().next().value!;
      sourceCaches.delete(oldest);
      sourceEpochs.delete(oldest);
    }
  } else sourceCaches.delete(key);
  const calendars = await tauriCommands.calendarList(profileId);
  if (useCalendarStore.getState().profileId !== profileId) return;
  useCalendarStore.setState((state) => {
    const activeIds = calendars
      .filter((calendar) => !calendar.archived)
      .map((calendar) => calendar.id);
    return {
      calendars,
      visibleCalendarIds: Array.from(
        new Set([
          ...state.visibleCalendarIds.filter((id) => activeIds.includes(id)),
          ...activeIds.filter((id) => !state.calendars.some((calendar) => calendar.id === id)),
        ]),
      ),
    };
  });
  const { range, loadRange } = useCalendarStore.getState();
  if (range) {
    await loadRange(range.from, range.to, range.includeUnscheduledTasks);
  }
}

export default function CalendarSyncCoordinator() {
  const profileId = useCollabStore((state) => state.myUserId);
  const connections = useServerStore((state) => state.connections);
  const vault = useVaultStore((state) => state.vault);
  const initialize = useCalendarStore((state) => state.initialize);
  const syncHosted = useCalendarStore((state) => state.syncHosted);
  const originsJson = JSON.stringify(
    normalizeHostedCalendarOrigins(
      Object.values(connections).flatMap((connection) => {
        const { status } = connection;
        return status.connected && status.serverUrl && status.user
          ? [{ serverUrl: status.serverUrl, userId: status.user.id }]
          : [];
      }),
    ),
  );
  const origins = useMemo(() => JSON.parse(originsJson) as HostedCalendarOrigin[], [originsJson]);

  const sync = useCallback(async () => {
    if (!profileId) return;
    await initialize(profileId);
    if (useCollabStore.getState().myUserId !== profileId) return;
    if (vault?.kind === 'local') await syncLocalKanbanProjection(profileId, vault);
    if (useCalendarStore.getState().profileId === profileId && origins.length > 0)
      await syncHosted(origins);
  }, [initialize, origins, profileId, syncHosted, vault]);

  const runSync = useCallback(() => {
    return sync().catch((error) => {
      if (useCalendarStore.getState().profileId !== profileId) throw error;
      useCalendarStore.setState({
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  }, [sync, profileId]);

  useEffect(() => {
    void runSync().catch(() => {});
  }, [runSync]);

  useEffect(() => {
    return subscribeBackgroundPoll(runSync, BACKGROUND_SYNC_INTERVAL_MS);
  }, [runSync]);

  useEffect(() => {
    if (!profileId || vault?.kind !== 'local') return undefined;
    let timer: number | null = null;
    let disposed = false;
    let unlisten: Array<() => void> = [];
    const handleKanbanChange = (event: { payload: CalendarFileChange }) => {
      const paths = calendarInvalidationPaths(event.payload, vault.path);
      if (!paths.length) return;
      const cache = sourceCaches.get(scopeKey(profileId, vault));
      const affected = paths.some(
        (path) =>
          path.toLowerCase().endsWith('.kanban') ||
          [...(cache?.keys() ?? [])].some(
            (source) => source === path || source.startsWith(`${path}/`),
          ),
      );
      if (!affected && !event.payload.oldPath && !event.payload.newPath) return;
      for (const path of paths) invalidateSource(profileId, vault, path);
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void syncLocalKanbanProjection(profileId, vault).catch((error) => {
          if (useCalendarStore.getState().profileId !== profileId) return;
          useCalendarStore.setState({
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 250);
    };
    void Promise.all([
      listen<CalendarFileChange>('vault:file-created', handleKanbanChange),
      listen<CalendarFileChange>('vault:file-deleted', handleKanbanChange),
      listen<CalendarFileChange>('vault:file-renamed', handleKanbanChange),
      listen<CalendarFileChange>('vault:file-modified', handleKanbanChange),
    ]).then((dispose) => {
      if (disposed) dispose.forEach((callback) => callback());
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      if (timer != null) window.clearTimeout(timer);
      unlisten.forEach((callback) => callback());
    };
  }, [profileId, vault]);

  return null;
}
