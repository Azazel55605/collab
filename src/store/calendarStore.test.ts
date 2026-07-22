import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tauriCommands } from '../lib/tauri';
import { useCalendarStore } from './calendarStore';
import { normalizeCalendarItem } from '../types/calendar';

vi.mock('../lib/tauri', () => ({
  tauriCommands: {
    calendarList: vi.fn(),
    calendarSave: vi.fn(),
    calendarListItems: vi.fn(),
    calendarUpsertItem: vi.fn(),
    calendarDeleteItem: vi.fn(),
    calendarAcknowledgeOperations: vi.fn(),
    hostedCalendarRequest: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useCalendarStore.setState({
    profileId: null,
    calendars: [],
    items: [],
    visibleCalendarIds: [],
    range: null,
    loading: false,
    saving: false,
    error: null,
  });
  vi.mocked(tauriCommands.calendarSave).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarListItems).mockResolvedValue([]);
  vi.mocked(tauriCommands.calendarUpsertItem).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarDeleteItem).mockResolvedValue(undefined);
  vi.mocked(tauriCommands.calendarAcknowledgeOperations).mockResolvedValue(undefined);
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
