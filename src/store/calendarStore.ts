import { create } from 'zustand';
import { tauriCommands } from '../lib/tauri';
import { queryCalendarItems } from '../types/calendar';
import {
  createCalendarDefinition,
  normalizeCalendarItem,
  type CalendarDefinition,
  type CalendarEvent,
  type CalendarItem,
  type CalendarLocation,
  type CalendarOperation,
} from '../types/calendar';

const DEVICE_ID_KEY = 'collab-calendar-device-id';
const profileInitializations = new Map<string, Promise<void>>();

function deviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, created);
  return created;
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

interface CalendarStoreState {
  profileId: string | null;
  calendars: CalendarDefinition[];
  items: CalendarItem[];
  visibleCalendarIds: string[];
  range: { from: string; to: string } | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  initialize: (profileId: string) => Promise<void>;
  loadRange: (from: string, to: string) => Promise<void>;
  setCalendarVisible: (calendarId: string, visible: boolean) => void;
  createCalendar: (name: string, color: string, location?: CalendarLocation) => Promise<CalendarDefinition>;
  createEvent: (input: {
    calendarId: string;
    title: string;
    start: string;
    end: string;
    allDay: boolean;
    description?: string;
  }) => Promise<CalendarEvent>;
  saveItem: (item: CalendarItem) => Promise<CalendarItem>;
  deleteItem: (item: CalendarItem) => Promise<void>;
  clearError: () => void;
}

function operationFor(item: CalendarItem, expectedRevision: number): CalendarOperation {
  return {
    clientOperationId: crypto.randomUUID(),
    deviceId: deviceId(),
    expectedRevision,
    mutation: { type: 'upsertItem', item },
  };
}

async function pushHostedOperation(
  profileId: string,
  calendar: CalendarDefinition,
  operation: CalendarOperation,
): Promise<void> {
  if (calendar.location.kind !== 'hosted') {
    await tauriCommands.calendarAcknowledgeOperations(profileId, [operation.clientOperationId]);
    return;
  }
  try {
    await tauriCommands.hostedCalendarRequest(
      calendar.location.serverUrl,
      'POST',
      '/api/v1/calendars/operations',
      { operations: [operation] },
    );
    await tauriCommands.calendarAcknowledgeOperations(profileId, [operation.clientOperationId]);
  } catch {
    // The local store already contains the edit and its durable operation. A
    // later calendar sync pass will replay it after the server reconnects.
  }
}

export const useCalendarStore = create<CalendarStoreState>()((set, get) => ({
  profileId: null,
  calendars: [],
  items: [],
  visibleCalendarIds: [],
  range: null,
  loading: false,
  saving: false,
  error: null,

  initialize: async (profileId) => {
    const pending = profileInitializations.get(profileId);
    if (pending) return pending;
    const initialization = (async () => {
      set({ profileId, loading: true, error: null });
      try {
        let calendars = await tauriCommands.calendarList(profileId);
        if (calendars.length === 0) {
          const calendar = createCalendarDefinition({
            location: { kind: 'local', profileId },
            name: 'Personal',
            color: '#a78bfa',
            defaultTimeZone: localTimeZone(),
          });
          await tauriCommands.calendarSave(profileId, calendar);
          calendars = [calendar];
        }
        const activeIds = calendars.filter((calendar) => !calendar.archived).map((calendar) => calendar.id);
        set((state) => {
          const survivingIds = state.visibleCalendarIds.filter((id) => activeIds.includes(id));
          return {
            calendars,
            visibleCalendarIds: survivingIds.length > 0 ? survivingIds : activeIds,
          };
        });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        set({ loading: false });
      }
    })();
    profileInitializations.set(profileId, initialization);
    try {
      await initialization;
    } finally {
      profileInitializations.delete(profileId);
    }
  },

  loadRange: async (from, to) => {
    const profileId = get().profileId;
    if (!profileId) return;
    set({ loading: true, error: null, range: { from, to } });
    try {
      const storedItems = await tauriCommands.calendarListItems(profileId, from, to, 5_000);
      const items = queryCalendarItems(storedItems, { from, to, limit: 5_000 });
      if (get().profileId === profileId && get().range?.from === from && get().range?.to === to) {
        set({ items });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  setCalendarVisible: (calendarId, visible) => set((state) => ({
    visibleCalendarIds: visible
      ? Array.from(new Set([...state.visibleCalendarIds, calendarId]))
      : state.visibleCalendarIds.filter((id) => id !== calendarId),
  })),

  createCalendar: async (name, color, requestedLocation) => {
    const profileId = get().profileId;
    if (!profileId) throw new Error('Calendar profile is not initialized.');
    const location = requestedLocation ?? { kind: 'local' as const, profileId };
    let calendar = createCalendarDefinition({
      location,
      name,
      color,
      defaultTimeZone: localTimeZone(),
    });
    set({ saving: true, error: null });
    try {
      if (location.kind === 'hosted') {
        calendar = await tauriCommands.hostedCalendarRequest<CalendarDefinition>(
          location.serverUrl,
          'POST',
          '/api/v1/calendars',
          calendar,
        );
      }
      await tauriCommands.calendarSave(profileId, calendar);
      set((state) => ({
        calendars: [...state.calendars, calendar],
        visibleCalendarIds: [...state.visibleCalendarIds, calendar.id],
      }));
      return calendar;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  createEvent: async ({ calendarId, title, start, end, allDay, description }) => {
    const profileId = get().profileId;
    const calendar = get().calendars.find((entry) => entry.id === calendarId);
    if (!profileId || !calendar) throw new Error('Calendar is not available.');
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const event = normalizeCalendarItem({
      id,
      uid: `${id}@collab.local`,
      calendarId,
      kind: 'event',
      title,
      description,
      reminders: [],
      start: allDay
        ? { kind: 'date', date: start }
        : { kind: 'dateTime', dateTime: new Date(start).toISOString(), timeZone: calendar.defaultTimeZone },
      end: allDay
        ? { kind: 'date', date: end }
        : { kind: 'dateTime', dateTime: new Date(end).toISOString(), timeZone: calendar.defaultTimeZone },
      availability: 'busy',
      revision: 0,
      createdAt: now,
      updatedAt: now,
    }) as CalendarEvent;
    set({ saving: true, error: null });
    try {
      const operation = operationFor(event, 0);
      await tauriCommands.calendarUpsertItem(profileId, event, operation);
      await pushHostedOperation(profileId, calendar, operation);
      set((state) => ({ items: [...state.items.filter((item) => item.id !== event.id), event] }));
      return event;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  saveItem: async (input) => {
    const profileId = get().profileId;
    if (!profileId) throw new Error('Calendar profile is not initialized.');
    const existing = get().items.find((item) => item.id === input.id);
    const item = normalizeCalendarItem({
      ...input,
      revision: existing ? existing.revision + 1 : input.revision,
      createdAt: existing?.createdAt ?? input.createdAt,
      updatedAt: new Date().toISOString(),
    });
    const calendar = get().calendars.find((entry) => entry.id === item.calendarId);
    if (!calendar) throw new Error('Calendar is not available.');
    const operation = operationFor(item, existing?.revision ?? 0);
    set({ saving: true, error: null });
    try {
      await tauriCommands.calendarUpsertItem(profileId, item, operation);
      await pushHostedOperation(profileId, calendar, operation);
      set((state) => ({
        items: [...state.items.filter((entry) => entry.id !== item.id), item],
      }));
      return item;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  deleteItem: async (item) => {
    const profileId = get().profileId;
    const calendar = get().calendars.find((entry) => entry.id === item.calendarId);
    if (!profileId || !calendar) throw new Error('Calendar is not available.');
    const deletedAt = new Date().toISOString();
    const operation: CalendarOperation = {
      clientOperationId: crypto.randomUUID(),
      deviceId: deviceId(),
      expectedRevision: item.revision,
      mutation: { type: 'deleteItem', calendarId: item.calendarId, itemId: item.id, deletedAt },
    };
    set({ saving: true, error: null });
    try {
      await tauriCommands.calendarDeleteItem(profileId, item.calendarId, item.id, deletedAt, operation);
      await pushHostedOperation(profileId, calendar, operation);
      set((state) => ({ items: state.items.filter((entry) => entry.id !== item.id) }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  clearError: () => set({ error: null }),
}));
