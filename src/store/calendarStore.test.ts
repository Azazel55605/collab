import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tauriCommands } from '../lib/tauri';
import { syncHostedCalendars } from '../lib/calendarSync';
import { useCalendarStore } from './calendarStore';
import { createCalendarDefinition, normalizeCalendarItem } from '../types/calendar';

vi.mock('../lib/tauri', () => ({
  tauriCommands: {
    calendarList: vi.fn(),
    calendarSave: vi.fn(),
    calendarListItems: vi.fn(),
    calendarUpsertItem: vi.fn(),
    calendarDeleteItem: vi.fn(),
    calendarAcknowledgeOperations: vi.fn(),
    calendarListFailedOperations: vi.fn(),
    calendarRetryOperation: vi.fn(),
    calendarDiscardOperation: vi.fn(),
    calendarRemoveHostedCache: vi.fn(),
    hostedCalendarRequest: vi.fn(),
  },
}));

vi.mock('../lib/calendarSync', () => ({
  syncHostedCalendars: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useCalendarStore.setState({
    profileId: null,
    calendars: [],
    sourceItems: [],
    items: [],
    visibleCalendarIds: [],
    range: null,
    loading: false,
    saving: false,
    syncing: false,
    syncResults: [],
    syncProgress: {},
    conflicts: [],
    error: null,
  });
  vi.mocked(tauriCommands.calendarSave).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarListItems).mockResolvedValue([]);
  vi.mocked(tauriCommands.calendarUpsertItem).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarDeleteItem).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarAcknowledgeOperations).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarListFailedOperations).mockResolvedValue([]);
  vi.mocked(tauriCommands.calendarRetryOperation).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarDiscardOperation).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarRemoveHostedCache).mockResolvedValue({ calendarsRemoved: 0, itemsRemoved: 0 });
  vi.mocked(syncHostedCalendars).mockResolvedValue([]);
});

describe('calendarStore', () => {
  it('creates a profile default calendar once and exposes it', async () => {
    vi.mocked(tauriCommands.calendarList).mockResolvedValue([]);
    await useCalendarStore.getState().initialize('profile-1');

    expect(tauriCommands.calendarSave).toHaveBeenCalledOnce();
    expect(useCalendarStore.getState().calendars[0]).toMatchObject({
      name: 'Personal',
      location: { kind: 'local', profileId: 'profile-1' },
    });
    expect(useCalendarStore.getState().visibleCalendarIds).toEqual([
      useCalendarStore.getState().calendars[0].id,
    ]);
  });

  it('deduplicates concurrent profile initialization', async () => {
    vi.mocked(tauriCommands.calendarList).mockResolvedValue([]);
    await Promise.all([
      useCalendarStore.getState().initialize('profile-1'),
      useCalendarStore.getState().initialize('profile-1'),
    ]);

    expect(tauriCommands.calendarList).toHaveBeenCalledOnce();
    expect(tauriCommands.calendarSave).toHaveBeenCalledOnce();
  });

  it('deduplicates concurrent hosted sync passes and clears progress', async () => {
    vi.mocked(tauriCommands.calendarList).mockResolvedValue([]);
    await useCalendarStore.getState().initialize('profile-1');
    let finish!: (value: []) => void;
    vi.mocked(syncHostedCalendars).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const origins = [{ serverUrl: 'https://calendar.example', userId: 'user-1' }];

    const first = useCalendarStore.getState().syncHosted(origins);
    const second = useCalendarStore.getState().syncHosted(origins);
    expect(useCalendarStore.getState().syncing).toBe(true);
    expect(syncHostedCalendars).toHaveBeenCalledOnce();

    finish([]);
    await Promise.all([first, second]);
    expect(useCalendarStore.getState().syncing).toBe(false);
  });

  it('refreshes durable conflicts after retry and discard actions', async () => {
    const conflict = {
      operation: {
        clientOperationId: 'operation-1',
        deviceId: 'device-1',
        mutation: { type: 'deleteCalendar' as const, calendarId: 'calendar-1' },
      },
      attemptCount: 1,
      lastError: 'revision conflict',
      lastAttemptAt: '2026-07-22T10:00:00Z',
    };
    vi.mocked(tauriCommands.calendarList).mockResolvedValue([]);
    vi.mocked(tauriCommands.calendarListFailedOperations)
      .mockResolvedValueOnce([conflict])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await useCalendarStore.getState().initialize('profile-1');
    expect(useCalendarStore.getState().conflicts).toEqual([conflict]);

    await useCalendarStore.getState().retryConflict('operation-1');
    expect(tauriCommands.calendarRetryOperation).toHaveBeenCalledWith('profile-1', 'operation-1');
    expect(useCalendarStore.getState().conflicts).toEqual([]);

    useCalendarStore.setState({ conflicts: [conflict] });
    await useCalendarStore.getState().discardConflict('operation-1');
    expect(tauriCommands.calendarDiscardOperation).toHaveBeenCalledWith('profile-1', 'operation-1');
    expect(useCalendarStore.getState().conflicts).toEqual([]);
  });

  it('removes a disconnected hosted calendar cache and its visible items', async () => {
    const hosted = createCalendarDefinition({
      id: 'calendar-1',
      location: { kind: 'hosted', serverUrl: 'https://calendar.example', userId: 'user-1' },
      name: 'Hosted',
      color: '#60a5fa',
      defaultTimeZone: 'UTC',
    });
    vi.mocked(tauriCommands.calendarList)
      .mockResolvedValueOnce([hosted])
      .mockResolvedValueOnce([]);
    await useCalendarStore.getState().initialize('profile-1');
    await useCalendarStore.getState().removeHostedCache({
      serverUrl: 'https://calendar.example',
      userId: 'user-1',
    });

    expect(tauriCommands.calendarRemoveHostedCache).toHaveBeenCalledWith(
      'profile-1',
      'https://calendar.example',
      'user-1',
    );
    expect(useCalendarStore.getState().calendars).toEqual([]);
  });

  it('expands recurring masters returned by the native range query', async () => {
    vi.mocked(tauriCommands.calendarList).mockResolvedValue([]);
    await useCalendarStore.getState().initialize('profile-1');
    const calendarId = useCalendarStore.getState().calendars[0].id;
    vi.mocked(tauriCommands.calendarListItems).mockResolvedValue([
      normalizeCalendarItem({
        id: 'daily-event',
        uid: 'daily-event@collab.local',
        calendarId,
        kind: 'event',
        title: 'Daily event',
        reminders: [],
        start: { kind: 'date', date: '2026-07-20' },
        end: { kind: 'date', date: '2026-07-21' },
        recurrence: { rrule: 'FREQ=DAILY;COUNT=3' },
        revision: 0,
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
      }),
    ]);

    await useCalendarStore.getState().loadRange('2026-07-21', '2026-07-23');

    expect(tauriCommands.calendarListItems).toHaveBeenCalledWith(
      'profile-1',
      '2026-07-21',
      '2026-07-23',
      5_000,
      true,
    );
    expect(useCalendarStore.getState().items.map((item) => item.recurrenceId)).toEqual([
      { kind: 'date', date: '2026-07-21' },
      { kind: 'date', date: '2026-07-22' },
    ]);
  });

  it('writes events and tombstones through operation-bearing commands', async () => {
    vi.mocked(tauriCommands.calendarList).mockResolvedValue([]);
    await useCalendarStore.getState().initialize('profile-1');
    const calendarId = useCalendarStore.getState().calendars[0].id;
    const event = await useCalendarStore.getState().createEvent({
      calendarId,
      title: 'Planning',
      start: '2026-07-22',
      end: '2026-07-23',
      allDay: true,
    });

    expect(tauriCommands.calendarUpsertItem).toHaveBeenCalledWith(
      'profile-1',
      event,
      expect.objectContaining({
        expectedRevision: 0,
        mutation: { type: 'upsertItem', item: event },
      }),
    );
    expect(useCalendarStore.getState().items).toEqual([event]);

    const updated = await useCalendarStore.getState().saveItem({ ...event, title: 'Updated planning' });
    expect(updated).toMatchObject({ title: 'Updated planning', revision: 1 });
    expect(tauriCommands.calendarUpsertItem).toHaveBeenLastCalledWith(
      'profile-1',
      updated,
      expect.objectContaining({ expectedRevision: 0 }),
    );

    await useCalendarStore.getState().deleteItem(updated);
    expect(tauriCommands.calendarDeleteItem).toHaveBeenCalledWith(
      'profile-1',
      calendarId,
      updated.id,
      expect.any(String),
      expect.objectContaining({ expectedRevision: 1 }),
    );
    expect(useCalendarStore.getState().items).toEqual([]);
    expect(tauriCommands.calendarAcknowledgeOperations).toHaveBeenCalledTimes(3);
  });

  it('persists a recurring occurrence edit as a detached exception', async () => {
    vi.mocked(tauriCommands.calendarList).mockResolvedValue([]);
    await useCalendarStore.getState().initialize('profile-1');
    const calendarId = useCalendarStore.getState().calendars[0].id;
    const master = normalizeCalendarItem({
      id: crypto.randomUUID(),
      uid: 'daily-event@collab.local',
      calendarId,
      kind: 'event',
      title: 'Daily event',
      reminders: [],
      start: { kind: 'date', date: '2026-07-20' },
      end: { kind: 'date', date: '2026-07-21' },
      recurrence: { rrule: 'FREQ=DAILY;COUNT=3' },
      revision: 0,
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
    });
    vi.mocked(tauriCommands.calendarListItems).mockResolvedValue([master]);
    await useCalendarStore.getState().loadRange('2026-07-20', '2026-07-24');
    const occurrence = useCalendarStore.getState().items[1];

    await useCalendarStore.getState().saveItem(
      normalizeCalendarItem({ ...occurrence, title: 'Changed occurrence' }),
      'occurrence',
    );

    const upsertCalls = vi.mocked(tauriCommands.calendarUpsertItem).mock.calls;
    const saved = upsertCalls[upsertCalls.length - 1]?.[1];
    expect(saved).toMatchObject({
      uid: master.uid,
      title: 'Changed occurrence',
      recurrenceId: occurrence.recurrenceId,
      recurrenceSeriesId: master.id,
      revision: 0,
    });
    expect(saved?.id).not.toContain('::');
    expect(saved?.recurrence).toBeUndefined();
    expect(useCalendarStore.getState().items.map((item) => item.title)).toEqual([
      'Daily event',
      'Changed occurrence',
      'Daily event',
    ]);
  });

  it('deletes recurring occurrences through explicit scopes', async () => {
    vi.mocked(tauriCommands.calendarList).mockResolvedValue([]);
    await useCalendarStore.getState().initialize('profile-1');
    const calendarId = useCalendarStore.getState().calendars[0].id;
    const master = normalizeCalendarItem({
      id: crypto.randomUUID(),
      uid: 'scoped-delete@collab.local',
      calendarId,
      kind: 'event',
      title: 'Scoped delete',
      reminders: [],
      start: { kind: 'date', date: '2026-07-20' },
      end: { kind: 'date', date: '2026-07-21' },
      recurrence: { rrule: 'FREQ=DAILY;COUNT=3' },
      revision: 0,
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
    });
    vi.mocked(tauriCommands.calendarListItems).mockResolvedValue([master]);
    await useCalendarStore.getState().loadRange('2026-07-20', '2026-07-24');
    const secondOccurrence = useCalendarStore.getState().items[1];

    await useCalendarStore.getState().deleteItem(secondOccurrence, 'occurrence');

    const upsertCalls = vi.mocked(tauriCommands.calendarUpsertItem).mock.calls;
    expect(upsertCalls[upsertCalls.length - 1]?.[1]).toMatchObject({
      id: master.id,
      recurrence: { exdates: [secondOccurrence.recurrenceId] },
    });
    expect(tauriCommands.calendarDeleteItem).not.toHaveBeenCalled();
    expect(useCalendarStore.getState().items).toHaveLength(2);

    const remainingOccurrence = useCalendarStore.getState().items[0];
    await useCalendarStore.getState().deleteItem(remainingOccurrence, 'series');
    expect(tauriCommands.calendarDeleteItem).toHaveBeenCalledWith(
      'profile-1',
      calendarId,
      master.id,
      expect.any(String),
      expect.objectContaining({ expectedRevision: 1 }),
    );
    expect(useCalendarStore.getState().items).toEqual([]);
  });

  it('creates hosted calendars and pushes their item operations', async () => {
    vi.mocked(tauriCommands.calendarList).mockResolvedValue([]);
    vi.mocked(tauriCommands.hostedCalendarRequest).mockImplementation(
      async (_serverUrl, _method, path, body) => path === '/api/v1/calendars' ? body : [],
    );
    await useCalendarStore.getState().initialize('profile-1');
    const hosted = await useCalendarStore.getState().createCalendar(
      'Server calendar',
      '#60a5fa',
      { kind: 'hosted', serverUrl: 'https://calendar.example', userId: crypto.randomUUID() },
    );

    await useCalendarStore.getState().createEvent({
      calendarId: hosted.id,
      title: 'Synced event',
      start: '2026-07-22',
      end: '2026-07-23',
      allDay: true,
    });

    expect(tauriCommands.hostedCalendarRequest).toHaveBeenCalledWith(
      'https://calendar.example',
      'POST',
      '/api/v1/calendars',
      expect.objectContaining({ name: 'Server calendar' }),
    );
    expect(tauriCommands.hostedCalendarRequest).toHaveBeenLastCalledWith(
      'https://calendar.example',
      'POST',
      '/api/v1/calendars/operations',
      { operations: [expect.objectContaining({ mutation: expect.objectContaining({ type: 'upsertItem' }) })] },
    );
    expect(tauriCommands.calendarAcknowledgeOperations).toHaveBeenCalledOnce();
  });
});
