import { describe, expect, it } from 'vitest';

import { planRecurringEdit, splitRecurrence } from './calendarRecurringEdit';
import { normalizeCalendarItem, type CalendarItem } from '../types/calendar';

const now = '2026-07-22T12:00:00.000Z';

function master(): CalendarItem {
  return normalizeCalendarItem({
    id: 'series-1',
    uid: 'series-1@collab.local',
    calendarId: 'calendar-1',
    kind: 'event',
    title: 'Standup',
    reminders: [],
    start: { kind: 'dateTime', dateTime: '2026-03-22T08:00:00Z', timeZone: 'Europe/Berlin' },
    end: { kind: 'dateTime', dateTime: '2026-03-22T09:00:00Z', timeZone: 'Europe/Berlin' },
    recurrence: { rrule: 'FREQ=WEEKLY;COUNT=6' },
    revision: 2,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  });
}

function occurrence(): CalendarItem {
  return normalizeCalendarItem({
    ...master(),
    id: 'series-1::2026-04-05T07:00:00.000Z',
    start: { kind: 'dateTime', dateTime: '2026-04-05T07:00:00Z', timeZone: 'Europe/Berlin' },
    end: { kind: 'dateTime', dateTime: '2026-04-05T08:00:00Z', timeZone: 'Europe/Berlin' },
    recurrenceId: { kind: 'dateTime', dateTime: '2026-04-05T07:00:00Z', timeZone: 'Europe/Berlin' },
    recurrenceSeriesId: 'series-1',
  });
}

describe('recurring edit planner', () => {
  it('creates a detached occurrence exception with the original recurrence ID', () => {
    const edited = normalizeCalendarItem({ ...occurrence(), title: 'Moved standup' });
    const plan = planRecurringEdit({
      master: master(),
      originalOccurrence: occurrence(),
      editedOccurrence: edited,
      scope: 'occurrence',
      exceptionId: 'exception-1',
      now,
    });

    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0]).toMatchObject({
      id: 'exception-1',
      uid: 'series-1@collab.local',
      title: 'Moved standup',
      recurrenceId: { kind: 'dateTime', dateTime: '2026-04-05T07:00:00.000Z' },
      recurrenceSeriesId: 'series-1',
      revision: 0,
    });
    expect(plan.upserts[0].recurrence).toBeUndefined();
  });

  it('maps an occurrence time edit back onto the master without a DST shift', () => {
    const edited = normalizeCalendarItem({
      ...occurrence(),
      start: { kind: 'dateTime', dateTime: '2026-04-05T08:00:00Z', timeZone: 'Europe/Berlin' },
      end: { kind: 'dateTime', dateTime: '2026-04-05T09:30:00Z', timeZone: 'Europe/Berlin' },
    });
    const plan = planRecurringEdit({
      master: master(),
      originalOccurrence: occurrence(),
      editedOccurrence: edited,
      scope: 'series',
      now,
    });
    const updated = plan.upserts[0];

    expect(updated.kind === 'event' && updated.start).toEqual({
      kind: 'dateTime',
      dateTime: '2026-03-22T09:00:00.000Z',
      timeZone: 'Europe/Berlin',
    });
    expect(updated.kind === 'event' && updated.end).toEqual({
      kind: 'dateTime',
      dateTime: '2026-03-22T10:30:00.000Z',
      timeZone: 'Europe/Berlin',
    });
    expect(updated.id).toBe('series-1');
    expect(updated.recurrenceId).toBeUndefined();
  });

  it('splits count-limited rules deterministically for following edits', () => {
    expect(splitRecurrence(
      { rrule: 'FREQ=WEEKLY;COUNT=6' },
      { kind: 'date', date: '2026-04-05' },
      2,
    )).toEqual({
      previous: { rrule: 'FREQ=WEEKLY;COUNT=2', rdates: undefined, exdates: undefined },
      following: { rrule: 'FREQ=WEEKLY;COUNT=4', rdates: undefined, exdates: undefined },
    });

    const plan = planRecurringEdit({
      master: master(),
      originalOccurrence: occurrence(),
      editedOccurrence: occurrence(),
      scope: 'following',
      followingSeriesId: 'series-2',
      priorOccurrences: 2,
      now,
    });
    expect(plan.upserts.map((item) => [item.id, item.recurrence?.rrule])).toEqual([
      ['series-1', 'FREQ=WEEKLY;COUNT=2'],
      ['series-2', 'FREQ=WEEKLY;COUNT=4'],
    ]);
  });
});
