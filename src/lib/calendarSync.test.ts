import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tauriCommands } from './tauri';
import {
  normalizeHostedCalendarOrigins,
  syncHostedCalendarOrigin,
  syncHostedCalendars,
} from './calendarSync';
import { createCalendarDefinition, normalizeCalendarItem } from '../types/calendar';

vi.mock('./tauri', () => ({
  tauriCommands: {
    hostedCalendarRequest: vi.fn(),
    calendarSave: vi.fn(),
    calendarReadSyncState: vi.fn(),
    calendarWriteSyncState: vi.fn(),
    calendarListPendingOperations: vi.fn(),
    calendarAcknowledgeOperations: vi.fn(),
    calendarMarkOperationFailed: vi.fn(),
    calendarApplyRemoteChanges: vi.fn(),
  },
}));

vi.mock('./vaultReplica', () => ({
  isLikelyConnectivityError: (error: unknown) => String(error).toLowerCase().includes('offline'),
}));

const origin = { serverUrl: 'https://calendar.example', userId: 'user-1' };
const remoteCalendar = createCalendarDefinition({
  id: 'calendar-1',
  globalId: 'global-1',
  location: { kind: 'hosted', serverUrl: 'https://wrong.example', userId: 'user-1' },
  name: 'Hosted',
  color: '#60a5fa',
  defaultTimeZone: 'Europe/Berlin',
  now: '2026-07-22T08:00:00Z',
});
const remoteItem = normalizeCalendarItem({
  id: 'event-1',
  uid: 'event-1@collab.local',
  calendarId: remoteCalendar.id,
  kind: 'event',
  title: 'Planning',
  reminders: [],
  start: { kind: 'date', date: '2026-07-22' },
  end: { kind: 'date', date: '2026-07-23' },
  revision: 0,
  createdAt: '2026-07-22T08:00:00Z',
  updatedAt: '2026-07-22T08:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(tauriCommands.calendarSave).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarReadSyncState).mockResolvedValue(null);
  vi.mocked(tauriCommands.calendarWriteSyncState).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarAcknowledgeOperations).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarMarkOperationFailed).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarApplyRemoteChanges).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarListPendingOperations).mockResolvedValue([]);
});

describe('calendarSync', () => {
  it('normalizes hosted origins into a stable deduplicated order', () => {
    expect(normalizeHostedCalendarOrigins([
      { serverUrl: 'https://second.example/', userId: 'user-b' },
      { serverUrl: 'https://first.example', userId: 'user-a' },
      { serverUrl: 'https://second.example', userId: 'user-b' },
    ])).toEqual([
      { serverUrl: 'https://first.example', userId: 'user-a' },
      { serverUrl: 'https://second.example', userId: 'user-b' },
    ]);
  });

  it('replays queued operations before atomically applying remote pages', async () => {
    const pending = {
      clientOperationId: 'operation-1',
      deviceId: 'device-1',
      expectedRevision: 0,
      mutation: { type: 'upsertItem' as const, item: remoteItem },
    };
    vi.mocked(tauriCommands.calendarListPendingOperations).mockResolvedValue([pending]);
    vi.mocked(tauriCommands.hostedCalendarRequest).mockImplementation(
      async (_serverUrl, method, path) => {
        if (method === 'GET' && path === '/api/v1/calendars') return [remoteCalendar];
        if (method === 'POST') return [{ clientOperationId: pending.clientOperationId, applied: true }];
        return {
          changes: [
            {
              sequence: 1,
              entityType: 'calendar',
              entityId: remoteCalendar.id,
              operation: 'upsert',
              payload: remoteCalendar,
              changedAt: '2026-07-22T09:00:00Z',
            },
            {
              sequence: 2,
              entityType: 'item',
              entityId: remoteItem.id,
              operation: 'upsert',
              payload: remoteItem,
              changedAt: '2026-07-22T09:00:00Z',
            },
          ],
          cursor: 2,
          hasMore: false,
        };
      },
    );

    const result = await syncHostedCalendarOrigin('profile-1', origin, []);

    expect(result).toMatchObject({ appliedChanges: 2, replayedOperations: 1, failedOperations: 0 });
    expect(tauriCommands.calendarAcknowledgeOperations).toHaveBeenCalledWith(
      'profile-1',
      ['operation-1'],
    );
    expect(tauriCommands.calendarApplyRemoteChanges).toHaveBeenCalledWith(
      'profile-1',
      [
        expect.objectContaining({
          payload: expect.objectContaining({ location: { kind: 'hosted', ...origin } }),
        }),
        expect.objectContaining({ entityId: remoteItem.id }),
      ],
      expect.objectContaining({ cursor: '2', originKey: 'https://calendar.example::user-1' }),
    );
  });

  it('preserves generated Kanban calendars and attaches their hosted origin', async () => {
    const generatedCalendar = {
      ...remoteCalendar,
      id: 'kanban-calendar-1',
      globalId: 'kanban-calendar-1',
      location: { kind: 'kanban', originKey: 'hosted-vault:vault-1' },
      name: 'Assigned tasks · Project',
      readOnly: true,
    };
    const generatedTask = normalizeCalendarItem({
      id: 'kanban-task-1',
      uid: 'kanban:vault-1:file-1:card-1',
      calendarId: generatedCalendar.id,
      kind: 'task',
      title: 'Review launch checklist',
      reminders: [],
      attachments: [],
      sourceBinding: {
        kind: 'kanban',
        vaultId: 'vault-1',
        fileId: 'file-1',
        cardId: 'card-1',
        sourceRevision: 4,
      },
      due: { kind: 'date', date: '2026-07-24' },
      status: 'needs-action',
      revision: 1,
      createdAt: '2026-07-22T08:00:00Z',
      updatedAt: '2026-07-24T08:00:00Z',
    });
    vi.mocked(tauriCommands.hostedCalendarRequest).mockImplementation(
      async (_serverUrl, _method, path) => {
        if (path === '/api/v1/calendars') return [generatedCalendar];
        return {
          changes: [
            {
              sequence: 1,
              entityType: 'calendar',
              entityId: generatedCalendar.id,
              operation: 'upsert',
              payload: generatedCalendar,
              changedAt: '2026-07-24T08:00:00Z',
            },
            {
              sequence: 2,
              entityType: 'item',
              entityId: generatedTask.id,
              operation: 'upsert',
              payload: generatedTask,
              changedAt: '2026-07-24T08:00:00Z',
            },
          ],
          cursor: 2,
          hasMore: false,
        };
      },
    );

    await syncHostedCalendarOrigin('profile-1', origin, []);

    expect(tauriCommands.calendarSave).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({
        id: generatedCalendar.id,
        location: {
          kind: 'kanban',
          originKey: 'https://calendar.example::hosted-vault:vault-1',
        },
        readOnly: true,
      }),
    );
    expect(tauriCommands.calendarApplyRemoteChanges).toHaveBeenCalledWith(
      'profile-1',
      [
        expect.objectContaining({
          payload: expect.objectContaining({
            location: {
              kind: 'kanban',
              originKey: 'https://calendar.example::hosted-vault:vault-1',
            },
          }),
        }),
        expect.objectContaining({
          payload: expect.objectContaining({
            sourceBinding: expect.objectContaining({
              kind: 'kanban',
              serverUrl: 'https://calendar.example',
              vaultId: 'vault-1',
              fileId: 'file-1',
              cardId: 'card-1',
            }),
          }),
        }),
      ],
      expect.objectContaining({ cursor: '2' }),
    );
  });

  it('reports bounded upload and download progress', async () => {
    const progress = vi.fn();
    vi.mocked(tauriCommands.hostedCalendarRequest).mockImplementation(
      async (_serverUrl, method, path) => {
        if (method === 'GET' && path === '/api/v1/calendars') return [remoteCalendar];
        return { changes: [], cursor: 0, hasMore: false };
      },
    );

    await syncHostedCalendarOrigin('profile-1', origin, [], progress);

    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'discovering' }));
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'uploading', totalItems: 0 }));
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'downloading', processedItems: 0 }));
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'complete' }));
  });

  it('isolates rejected operations and does not pull over unresolved local edits', async () => {
    const first = {
      clientOperationId: 'operation-1',
      deviceId: 'device-1',
      mutation: { type: 'upsertItem' as const, item: remoteItem },
    };
    const second = {
      ...first,
      clientOperationId: 'operation-2',
      mutation: {
        type: 'deleteItem' as const,
        calendarId: remoteCalendar.id,
        itemId: remoteItem.id,
        deletedAt: '2026-07-22T10:00:00Z',
      },
    };
    vi.mocked(tauriCommands.calendarListPendingOperations).mockResolvedValue([first, second]);
    vi.mocked(tauriCommands.hostedCalendarRequest).mockImplementation(
      async (_serverUrl, method, path, body) => {
        if (method === 'GET' && path === '/api/v1/calendars') return [remoteCalendar];
        if (method === 'POST') {
          const operations = (body as { operations: typeof first[] }).operations;
          if (operations.length > 1 || operations[0].clientOperationId === second.clientOperationId) {
            throw new Error('revision conflict');
          }
          return [];
        }
        throw new Error('remote changes must not be pulled while a conflict is unresolved');
      },
    );

    const result = await syncHostedCalendarOrigin('profile-1', origin, []);

    expect(result).toMatchObject({
      replayedOperations: 1,
      failedOperations: 1,
      appliedChanges: 0,
      error: '1 calendar change need attention.',
    });
    expect(tauriCommands.calendarAcknowledgeOperations).toHaveBeenCalledWith('profile-1', ['operation-1']);
    expect(tauriCommands.calendarMarkOperationFailed).toHaveBeenCalledWith(
      'profile-1',
      'operation-2',
      'revision conflict',
      expect.any(String),
    );
    expect(tauriCommands.calendarApplyRemoteChanges).not.toHaveBeenCalled();
  });

  it('keeps connectivity failures pending for the next sync pass', async () => {
    const pending = {
      clientOperationId: 'operation-1',
      deviceId: 'device-1',
      mutation: { type: 'upsertItem' as const, item: remoteItem },
    };
    vi.mocked(tauriCommands.calendarListPendingOperations).mockResolvedValue([pending]);
    vi.mocked(tauriCommands.hostedCalendarRequest).mockImplementation(
      async (_serverUrl, method, path) => {
        if (method === 'GET' && path === '/api/v1/calendars') return [remoteCalendar];
        throw new Error('offline');
      },
    );

    const result = await syncHostedCalendarOrigin('profile-1', origin, []);

    expect(result).toMatchObject({ error: 'offline', failedOperations: 0 });
    expect(tauriCommands.calendarMarkOperationFailed).not.toHaveBeenCalled();
    expect(tauriCommands.calendarAcknowledgeOperations).not.toHaveBeenCalled();
  });

  it('turns an initial local sync-state lock into a reported sync error', async () => {
    vi.mocked(tauriCommands.calendarReadSyncState).mockRejectedValue(
      new Error('database is locked'),
    );

    const result = await syncHostedCalendarOrigin('profile-1', origin, []);

    expect(result).toMatchObject({
      serverUrl: origin.serverUrl,
      appliedChanges: 0,
      replayedOperations: 0,
      failedOperations: 0,
      error: 'database is locked',
    });
    expect(tauriCommands.calendarWriteSyncState).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ cursor: '0', lastError: 'database is locked' }),
    );
  });

  it('isolates failures between connected servers', async () => {
    vi.mocked(tauriCommands.hostedCalendarRequest).mockImplementation(
      async (serverUrl, _method, path) => {
        if (serverUrl.includes('offline')) throw new Error('offline');
        if (path === '/api/v1/calendars') return [];
        return { changes: [], cursor: 0, hasMore: false };
      },
    );

    const results = await syncHostedCalendars('profile-1', [
      { serverUrl: 'https://offline.example', userId: 'user-a' },
      { serverUrl: 'https://online.example', userId: 'user-b' },
    ], []);

    expect(results[0]).toMatchObject({ serverUrl: 'https://offline.example', error: 'offline' });
    expect(results[1]).toMatchObject({ serverUrl: 'https://online.example' });
    expect(results[1].error).toBeUndefined();
  });
});
