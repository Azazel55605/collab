import { useCallback, useEffect, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useCalendarStore } from '../../store/calendarStore';
import { useCollabStore } from '../../store/collabStore';
import { useServerStore } from '../../store/serverStore';
import { useVaultStore } from '../../store/vaultStore';
import {
  normalizeHostedCalendarOrigins,
  type HostedCalendarOrigin,
} from '../../lib/calendarSync';
import { createVaultClient } from '../../lib/vaultClient';
import { projectLocalKanbanCalendar } from '../../lib/kanbanCalendarProjection';
import { tauriCommands } from '../../lib/tauri';
import type { NoteFile } from '../../types/vault';

const BACKGROUND_SYNC_INTERVAL_MS = 60_000;

function flattenFiles(files: NoteFile[]): NoteFile[] {
  return files.flatMap((file) => [file, ...(file.children ? flattenFiles(file.children) : [])]);
}

export async function syncLocalKanbanProjection(
  profileId: string,
  vault: NonNullable<ReturnType<typeof useVaultStore.getState>['vault']>,
): Promise<void> {
  if (vault.kind === 'hosted') return;
  const client = createVaultClient(vault);
  const files = flattenFiles(await client.listFiles())
    .filter((file) => !file.isFolder && file.relativePath.toLowerCase().endsWith('.kanban'));
  const sources = [];
  for (const file of files) {
    try {
      const document = await client.readDocument(file.relativePath);
      sources.push({
        fileId: file.relativePath,
        path: file.relativePath,
        sourceRevision: Math.max(0, Math.trunc(file.modifiedAt)),
        content: document.content,
      });
    } catch {
      // One unreadable board must not hide assignments from the other boards.
    }
  }
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
  const calendars = await tauriCommands.calendarList(profileId);
  useCalendarStore.setState((state) => {
    const activeIds = calendars.filter((calendar) => !calendar.archived).map((calendar) => calendar.id);
    return {
      calendars,
      visibleCalendarIds: Array.from(new Set([
        ...state.visibleCalendarIds.filter((id) => activeIds.includes(id)),
        ...activeIds.filter((id) => !state.calendars.some((calendar) => calendar.id === id)),
      ])),
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
  const originsJson = JSON.stringify(normalizeHostedCalendarOrigins(Object.values(connections).flatMap((connection) => {
    const { status } = connection;
    return status.connected && status.serverUrl && status.user
      ? [{ serverUrl: status.serverUrl, userId: status.user.id }]
      : [];
  })));
  const origins = useMemo(
    () => JSON.parse(originsJson) as HostedCalendarOrigin[],
    [originsJson],
  );

  const sync = useCallback(async () => {
    if (!profileId) return;
    await initialize(profileId);
    if (vault?.kind === 'local') await syncLocalKanbanProjection(profileId, vault);
    if (origins.length > 0) await syncHosted(origins);
  }, [initialize, origins, profileId, syncHosted, vault]);

  const runSync = useCallback(() => {
    void sync().catch((error) => {
      useCalendarStore.setState({
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, [sync]);

  useEffect(() => {
    runSync();
  }, [runSync]);

  useEffect(() => {
    const runWhenVisible = () => {
      if (document.visibilityState === 'visible') runSync();
    };
    const timer = window.setInterval(runWhenVisible, BACKGROUND_SYNC_INTERVAL_MS);
    window.addEventListener('focus', runWhenVisible);
    window.addEventListener('online', runWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', runWhenVisible);
      window.removeEventListener('online', runWhenVisible);
    };
  }, [runSync]);

  useEffect(() => {
    if (!profileId || vault?.kind !== 'local') return undefined;
    let timer: number | null = null;
    let disposed = false;
    let unlisten: Array<() => void> = [];
    const handleKanbanChange = (event: { payload: { path: string } }) => {
      if (!event.payload.path.toLowerCase().endsWith('.kanban')) return;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void syncLocalKanbanProjection(profileId, vault).catch((error) => {
          useCalendarStore.setState({
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 250);
    };
    void Promise.all([
      listen<{ path: string }>('vault:file-created', handleKanbanChange),
      listen<{ path: string }>('vault:file-deleted', handleKanbanChange),
      listen<{ path: string }>('vault:file-renamed', handleKanbanChange),
      listen<{ path: string }>('vault:file-modified', handleKanbanChange),
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
