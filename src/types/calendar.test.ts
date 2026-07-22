import { describe, expect, it } from 'vitest';

import {
  CalendarValidationError,
  createCalendarDefinition,
  isCalendarDate,
  normalizeCalendarDefinition,
  normalizeCalendarItem,
  normalizeCalendarTimeValue,
  queryCalendarItems,
  type CalendarItem,
} from './calendar';

const createdAt = '2026-07-22T08:00:00Z';

function baseItem(overrides: Record<string, unknown>) {
  return {
    id: 'item-1',
    uid: 'item-1@collab.local',
    calendarId: 'calendar-1',
    title: 'Planning',
    reminders: [],
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe('calendar domain', () => {
  it('creates a local calendar with stable profile ownership', () => {
    const calendar = createCalendarDefinition({
      id: 'calendar-1',
      globalId: 'global-1',
      location: { kind: 'local', profileId: 'profile-1' },
      name: 'Personal',
      color: '#A855F7',
      defaultTimeZone: 'Europe/Berlin',
      now: createdAt,
    });

    expect(calendar).toEqual({
      schemaVersion: 1,
      id: 'calendar-1',
      globalId: 'global-1',
      location: { kind: 'local', profileId: 'profile-1' },
      name: 'Personal',
      color: '#a855f7',
      defaultTimeZone: 'Europe/Berlin',
      archived: false,
      readOnly: false,
      revision: 0,
      createdAt: '2026-07-22T08:00:00.000Z',
      updatedAt: '2026-07-22T08:00:00.000Z',
    });
  });

  it('normalizes hosted origins and forces generated calendars read-only', () => {
    const hosted = normalizeCalendarDefinition({
      id: 'calendar-1',
      globalId: 'global-1',
      location: { kind: 'hosted', serverUrl: 'https://calendar.example.test/', userId: 'user-1' },
      name: 'Work',
      color: '#2563eb',
      defaultTimeZone: 'UTC',
      revision: 2,
      createdAt,
      updatedAt: createdAt,
    });
    const projected = normalizeCalendarDefinition({
      ...hosted,
      id: 'tasks',
      location: { kind: 'kanban', originKey: 'https://calendar.example.test|vault-1' },
      readOnly: false,
    });

    expect(hosted.location).toEqual({
      kind: 'hosted',
      serverUrl: 'https://calendar.example.test',
      userId: 'user-1',
    });
    expect(projected.readOnly).toBe(true);
  });

  it('preserves date-only values and canonicalizes offset timestamps to UTC', () => {
    expect(normalizeCalendarTimeValue({ kind: 'date', date: '2026-03-29' })).toEqual({
      kind: 'date',
      date: '2026-03-29',
    });
    expect(normalizeCalendarTimeValue({
      kind: 'dateTime',
      dateTime: '2026-03-29T10:30:00+02:00',
      timeZone: 'Europe/Berlin',
    })).toEqual({
      kind: 'dateTime',
      dateTime: '2026-03-29T08:30:00.000Z',
      timeZone: 'Europe/Berlin',
    });
  });

  it('rejects impossible dates, floating timestamps, and unknown time zones', () => {
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(() => normalizeCalendarTimeValue({
      kind: 'dateTime',
      dateTime: '2026-07-22T10:30:00',
      timeZone: 'Europe/Berlin',
    })).toThrow(/offset/i);
    expect(() => normalizeCalendarTimeValue({
      kind: 'dateTime',
      dateTime: '2026-07-22T10:30:00Z',
      timeZone: 'Mars/Olympus',
    })).toThrow(/IANA/i);
  });

  it('uses exclusive all-day event ends and rejects mixed time semantics', () => {
    const event = normalizeCalendarItem(baseItem({
      kind: 'event',
      start: { kind: 'date', date: '2026-07-22' },
      end: { kind: 'date', date: '2026-07-23' },
      availability: 'busy',
    }));

    expect(event.kind).toBe('event');
    expect(() => normalizeCalendarItem(baseItem({
      kind: 'event',
      start: { kind: 'date', date: '2026-07-22' },
      end: { kind: 'dateTime', dateTime: '2026-07-23T10:00:00Z', timeZone: 'UTC' },
    }))).toThrow(/both be dates/i);
  });

  it('normalizes task, birthday, reminder, recurrence, and source-binding fields', () => {
    const task = normalizeCalendarItem(baseItem({
      kind: 'task',
      due: { kind: 'date', date: '2026-07-25' },
      priority: 'high',
      status: 'in-progress',
      reminders: [{ kind: 'relative', minutesBefore: 30 }],
      recurrence: {
        rrule: 'RRULE:FREQ=WEEKLY;COUNT=4',
        exdates: [{ kind: 'date', date: '2026-08-01' }],
      },
      sourceBinding: {
        kind: 'kanban',
        serverUrl: 'https://server.test',
        vaultId: 'vault-1',
        fileId: 'file-1',
        cardId: 'card-1',
        sourceRevision: 4,
      },
    }));
    const birthday = normalizeCalendarItem(baseItem({
      id: 'birthday-1',
      uid: 'birthday-1@collab.local',
      kind: 'birthday',
      date: '1990-04-12',
      birthYear: 1990,
    }));

    expect(task).toMatchObject({
      kind: 'task',
      status: 'in-progress',
      recurrence: { rrule: 'FREQ=WEEKLY;COUNT=4' },
      sourceBinding: { kind: 'kanban', cardId: 'card-1', sourceRevision: 4 },
    });
    expect(birthday).toMatchObject({ kind: 'birthday', date: '1990-04-12', birthYear: 1990 });
  });

  it('normalizes hosted attendees, typed attachments, and legacy location strings', () => {
    const event = normalizeCalendarItem(baseItem({
      kind: 'event',
      start: { kind: 'dateTime', dateTime: '2026-07-22T10:00:00Z', timeZone: 'Europe/Berlin' },
      end: { kind: 'dateTime', dateTime: '2026-07-22T11:00:00Z', timeZone: 'Europe/Berlin' },
      location: 'Alexanderplatz, Berlin',
      attendees: [{
        id: 'attendee-1',
        kind: 'collabUser',
        serverUrl: 'https://calendar.example.test/',
        userId: 'user-1',
        displayName: 'Ada',
        response: 'accepted',
        role: 'required',
      }],
      attachments: [{
        id: 'attachment-1',
        kind: 'kanbanTask',
        name: 'Release task',
        vaultId: 'vault-1',
        fileId: 'board-1',
        cardId: 'card-1',
      }],
    }));

    expect(event).toMatchObject({
      kind: 'event',
      location: { label: 'Alexanderplatz, Berlin' },
      attendees: [{ serverUrl: 'https://calendar.example.test', response: 'accepted' }],
      attachments: [{ kind: 'kanbanTask', cardId: 'card-1' }],
    });
  });

  it('returns overlapping non-deleted items in stable order and enforces query bounds', () => {
    const items: CalendarItem[] = [
      normalizeCalendarItem(baseItem({
        id: 'later',
        uid: 'later@collab.local',
        title: 'Later',
        kind: 'event',
        start: { kind: 'dateTime', dateTime: '2026-07-22T12:00:00Z', timeZone: 'UTC' },
        end: { kind: 'dateTime', dateTime: '2026-07-22T13:00:00Z', timeZone: 'UTC' },
      })),
      normalizeCalendarItem(baseItem({
        id: 'all-day',
        uid: 'all-day@collab.local',
        title: 'All day',
        kind: 'event',
        start: { kind: 'date', date: '2026-07-22' },
        end: { kind: 'date', date: '2026-07-23' },
      })),
      normalizeCalendarItem(baseItem({
        id: 'deleted',
        uid: 'deleted@collab.local',
        title: 'Deleted',
        kind: 'task',
        due: { kind: 'date', date: '2026-07-22' },
        deletedAt: '2026-07-22T09:00:00Z',
      })),
    ];

    expect(queryCalendarItems(items, {
      from: '2026-07-22',
      to: '2026-07-23',
    }).map((item) => item.id)).toEqual(['all-day', 'later']);
    expect(() => queryCalendarItems(items, {
      from: '2026-07-23',
      to: '2026-07-22',
    })).toThrow(CalendarValidationError);
    expect(() => queryCalendarItems(items, {
      from: '2026-07-22',
      to: '2026-07-23',
      limit: 5_001,
    })).toThrow(/limit/i);
  });
});
