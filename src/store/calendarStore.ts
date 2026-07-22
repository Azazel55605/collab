import { create } from 'zustand';
import { tauriCommands } from '../lib/tauri';
import { expandRecurringItem } from '../lib/calendarRecurrence';
import {
  planRecurringEdit,
  splitRecurrence,
  type CalendarRecurrenceEditScope,
} from '../lib/calendarRecurringEdit';
import {
  calendarItemRange,
  calendarTimeValueKey,
  createCalendarDefinition,
  normalizeCalendarItem,
  queryCalendarItems,
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
  sourceItems: CalendarItem[];
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
  saveItem: (item: CalendarItem, scope?: CalendarRecurrenceEditScope) => Promise<CalendarItem>;
  deleteItem: (item: CalendarItem, scope?: CalendarRecurrenceEditScope) => Promise<void>;
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

function projectedItems(
  sourceItems: CalendarItem[],
  range: { from: string; to: string } | null,
): CalendarItem[] {
  return range
    ? queryCalendarItems(sourceItems, { ...range, limit: 5_000 })
    : sourceItems.filter((item) => item.deletedAt == null);
}

function replaceSourceItems(sourceItems: CalendarItem[], replacements: CalendarItem[]): CalendarItem[] {
  const replacementIds = new Set(replacements.map((item) => item.id));
  return [...sourceItems.filter((item) => !replacementIds.has(item.id)), ...replacements];
}

function recurrenceInstant(item: CalendarItem): number {
  if (!item.recurrenceId) return Number.NaN;
  return item.recurrenceId.kind === 'date'
    ? Date.parse(`${item.recurrenceId.date}T00:00:00.000Z`)
    : Date.parse(item.recurrenceId.dateTime);
}

function priorOccurrenceCount(master: CalendarItem, occurrence: CalendarItem): number {
  const range = calendarItemRange(master);
  const selected = recurrenceInstant(occurrence);
  if (!range || !Number.isFinite(selected)) return 0;
  return Math.max(0, expandRecurringItem(master, range.start - 1, selected + 1, 20_000).length - 1);
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
  sourceItems: [],
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
      const storedItems = await tauriCommands.calendarListItems(profileId, from, to, 5_000, true);
      const items = queryCalendarItems(storedItems, { from, to, limit: 5_000 });
      if (get().profileId === profileId && get().range?.from === from && get().range?.to === to) {
        set({ sourceItems: storedItems, items });
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
      set((state) => {
        const sourceItems = replaceSourceItems(state.sourceItems, [event]);
        return { sourceItems, items: projectedItems(sourceItems, state.range) };
      });
      return event;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  saveItem: async (input, scope = 'series') => {
    const profileId = get().profileId;
    if (!profileId) throw new Error('Calendar profile is not initialized.');
    const now = new Date().toISOString();
    const originalOccurrence = get().items.find((item) => item.id === input.id) ?? input;
    let plannedInputs = [input];
    if (input.recurrenceId && input.recurrenceSeriesId) {
      const master = get().sourceItems.find((item) => item.id === input.recurrenceSeriesId);
      if (!master?.recurrence) throw new Error('The recurring series is not available in the local calendar cache.');
      const recurrenceKey = calendarTimeValueKey(input.recurrenceId);
      const existingException = get().sourceItems.find((item) => item.uid === master.uid
        && item.recurrenceId != null
        && calendarTimeValueKey(item.recurrenceId) === recurrenceKey);
      plannedInputs = planRecurringEdit({
        master,
        originalOccurrence,
        editedOccurrence: input,
        scope,
        now,
        exceptionId: existingException?.id ?? crypto.randomUUID(),
        followingSeriesId: crypto.randomUUID(),
        priorOccurrences: priorOccurrenceCount(master, originalOccurrence),
      }).upserts;
    }
    set({ saving: true, error: null });
    try {
      const savedItems: CalendarItem[] = [];
      for (const planned of plannedInputs) {
        const existing = get().sourceItems.find((item) => item.id === planned.id);
        const item = normalizeCalendarItem({
          ...planned,
          revision: existing ? existing.revision + 1 : planned.revision,
          createdAt: existing?.createdAt ?? planned.createdAt,
          updatedAt: now,
        });
        const calendar = get().calendars.find((entry) => entry.id === item.calendarId);
        if (!calendar) throw new Error('Calendar is not available.');
        const operation = operationFor(item, existing?.revision ?? 0);
        await tauriCommands.calendarUpsertItem(profileId, item, operation);
        await pushHostedOperation(profileId, calendar, operation);
        savedItems.push(item);
      }
      set((state) => {
        const sourceItems = replaceSourceItems(state.sourceItems, savedItems);
        return { sourceItems, items: projectedItems(sourceItems, state.range) };
      });
      return savedItems[savedItems.length - 1];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  deleteItem: async (item, scope = 'occurrence') => {
    const profileId = get().profileId;
    if (!profileId) throw new Error('Calendar is not available.');
    if (item.recurrenceId && item.recurrenceSeriesId) {
      const master = get().sourceItems.find((entry) => entry.id === item.recurrenceSeriesId);
      if (!master?.recurrence) throw new Error('The recurring series is not available in the local calendar cache.');
      if (scope === 'occurrence') {
        const exdates = [...(master.recurrence.exdates ?? [])];
        const key = calendarTimeValueKey(item.recurrenceId);
        if (!exdates.some((value) => calendarTimeValueKey(value) === key)) exdates.push(item.recurrenceId);
        await get().saveItem({ ...master, recurrence: { ...master.recurrence, exdates } }, 'series');
        return;
      }
      if (scope === 'following') {
        const recurrence = splitRecurrence(
          master.recurrence,
          item.recurrenceId,
          priorOccurrenceCount(master, item),
        ).previous;
        if (recurrence) {
          await get().saveItem({ ...master, recurrence }, 'series');
          return;
        }
      }
      item = master;
    }
    const calendar = get().calendars.find((entry) => entry.id === item.calendarId);
    if (!calendar) throw new Error('Calendar is not available.');
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
      set((state) => {
        const tombstone = { ...item, revision: item.revision + 1, updatedAt: deletedAt, deletedAt };
        const sourceItems = replaceSourceItems(state.sourceItems, [tombstone]);
        return { sourceItems, items: projectedItems(sourceItems, state.range) };
      });
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
