import { describe, expect, it } from 'vitest';

import type { CalendarEvent, CalendarTask } from '../types/calendar';

import {
  calendarTimedRangeForDay,
  layoutCalendarTimedItems,
  rescheduleCalendarAllDayItem,
  rescheduleCalendarTimedItem,
  resizeCalendarTimedItem,
  snapCalendarEndMinute,
  snapCalendarMinute,
} from './calendarTimedLayout';

function event(id: string, start: string, end: string): CalendarEvent {
  return {
    kind: 'event',
    id,
    uid: `${id}@test`,
    calendarId: 'calendar',
    title: id,
    reminders: [],
    attendees: [],
    attachments: [],
    start: { kind: 'dateTime', dateTime: start, timeZone: 'UTC' },
    end: { kind: 'dateTime', dateTime: end, timeZone: 'UTC' },
    availability: 'busy',
    revision: 0,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
}

function localTime(day: number, hour: number, minute = 0): string {
  return new Date(2026, 6, day, hour, minute).toISOString();
}

describe('calendar timed layout', () => {
  it('clips cross-midnight items to the visible day', () => {
    const item = event('overnight', localTime(22, 23, 30), localTime(23, 1, 30));
    expect(calendarTimedRangeForDay(item, '2026-07-23')).toEqual({
      startMinute: 0,
      endMinute: 90,
    });
  });

  it('assigns overlapping entries to separate columns', () => {
    const entries = layoutCalendarTimedItems(
      [
        event('first', localTime(23, 9), localTime(23, 11)),
        event('second', localTime(23, 9, 30), localTime(23, 10, 30)),
        event('third', localTime(23, 10, 30), localTime(23, 12)),
      ],
      '2026-07-23',
    );

    expect(
      entries.map(({ item, column, columnCount }) => ({
        id: item.id,
        column,
        columnCount,
      })),
    ).toEqual([
      { id: 'first', column: 0, columnCount: 2 },
      { id: 'second', column: 1, columnCount: 2 },
      { id: 'third', column: 1, columnCount: 2 },
    ]);
  });

  it('starts a new width cluster after overlapping entries end', () => {
    const entries = layoutCalendarTimedItems(
      [
        event('first', localTime(23, 9), localTime(23, 10)),
        event('second', localTime(23, 9, 15), localTime(23, 9, 45)),
        event('later', localTime(23, 10), localTime(23, 11)),
      ],
      '2026-07-23',
    );

    expect(entries.find((entry) => entry.item.id === 'later')).toMatchObject({
      column: 0,
      columnCount: 1,
    });
  });

  it('snaps dragged times to bounded 15-minute increments', () => {
    expect(snapCalendarMinute(67)).toBe(60);
    expect(snapCalendarMinute(68)).toBe(75);
    expect(snapCalendarMinute(1_439)).toBe(1_425);
    expect(snapCalendarEndMinute(1_439)).toBe(1_440);
    expect(snapCalendarEndMinute(61, 75)).toBe(75);
  });

  it('moves a timed event while preserving its duration', () => {
    const item = event('planning', localTime(23, 9), localTime(23, 10, 30));
    const moved = rescheduleCalendarTimedItem(item, '2026-07-24', 14 * 60 + 8) as CalendarEvent;

    expect(new Date(moved.start.kind === 'dateTime' ? moved.start.dateTime : 0)).toEqual(
      new Date(2026, 6, 24, 14, 15),
    );
    expect(
      Date.parse(moved.end.kind === 'dateTime' ? moved.end.dateTime : '') -
        Date.parse(moved.start.kind === 'dateTime' ? moved.start.dateTime : ''),
    ).toBe(90 * 60_000);
  });

  it('moves a due-only task without inventing a start', () => {
    const item: CalendarTask = {
      ...event('deadline', localTime(23, 9), localTime(23, 10)),
      kind: 'task',
      start: undefined,
      due: { kind: 'dateTime', dateTime: localTime(23, 10), timeZone: 'UTC' },
      status: 'needs-action',
    };
    const moved = rescheduleCalendarTimedItem(item, '2026-07-24', 11 * 60) as CalendarTask;

    expect(moved.start).toBeUndefined();
    expect(new Date(moved.due?.kind === 'dateTime' ? moved.due.dateTime : 0)).toEqual(
      new Date(2026, 6, 24, 11),
    );
  });

  it('resizes event ends and task deadlines without moving their starts', () => {
    const item = event('planning', localTime(23, 9), localTime(23, 10));
    const resized = resizeCalendarTimedItem(item, '2026-07-23', 11 * 60 + 8) as CalendarEvent;
    expect(resized.start).toEqual(item.start);
    expect(new Date(resized.end.kind === 'dateTime' ? resized.end.dateTime : 0)).toEqual(
      new Date(2026, 6, 23, 11, 15),
    );

    const task: CalendarTask = {
      ...item,
      kind: 'task',
      start: item.start,
      due: item.end,
      status: 'needs-action',
    };
    const resizedTask = resizeCalendarTimedItem(task, '2026-07-23', 12 * 60) as CalendarTask;
    expect(resizedTask.start).toEqual(task.start);
    expect(new Date(resizedTask.due?.kind === 'dateTime' ? resizedTask.due.dateTime : 0)).toEqual(
      new Date(2026, 6, 23, 12),
    );
  });

  it('does not add a start when resizing a due-only task', () => {
    const task: CalendarTask = {
      ...event('deadline', localTime(23, 9), localTime(23, 10)),
      kind: 'task',
      start: undefined,
      due: { kind: 'dateTime', dateTime: localTime(23, 10), timeZone: 'UTC' },
      status: 'needs-action',
    };
    expect(resizeCalendarTimedItem(task, '2026-07-23', 12 * 60)).toBeNull();
  });

  it('moves an all-day event while preserving its multi-day span', () => {
    const item: CalendarEvent = {
      ...event('conference', localTime(23, 9), localTime(23, 10)),
      start: { kind: 'date', date: '2026-07-23' },
      end: { kind: 'date', date: '2026-07-26' },
    };
    const moved = rescheduleCalendarAllDayItem(item, '2026-08-02') as CalendarEvent;

    expect(moved.start).toEqual({ kind: 'date', date: '2026-08-02' });
    expect(moved.end).toEqual({ kind: 'date', date: '2026-08-05' });
  });

  it('preserves the grabbed segment offset for multi-day events', () => {
    const item: CalendarEvent = {
      ...event('conference', localTime(23, 9), localTime(23, 10)),
      start: { kind: 'date', date: '2026-07-23' },
      end: { kind: 'date', date: '2026-07-26' },
    };
    const moved = rescheduleCalendarAllDayItem(item, '2026-08-02', '2026-07-24') as CalendarEvent;

    expect(moved.start).toEqual({ kind: 'date', date: '2026-08-01' });
    expect(moved.end).toEqual({ kind: 'date', date: '2026-08-04' });
  });

  it('moves all-day task dates and birthdays without changing their shape', () => {
    const task: CalendarTask = {
      ...event('task', localTime(23, 9), localTime(23, 10)),
      kind: 'task',
      start: { kind: 'date', date: '2026-07-23' },
      due: { kind: 'date', date: '2026-07-25' },
      status: 'needs-action',
    };
    const movedTask = rescheduleCalendarAllDayItem(task, '2026-07-30') as CalendarTask;
    expect(movedTask.start).toEqual({ kind: 'date', date: '2026-07-30' });
    expect(movedTask.due).toEqual({ kind: 'date', date: '2026-08-01' });

    const birthday = {
      ...task,
      kind: 'birthday' as const,
      date: '2026-07-23',
      birthYear: 1990,
    };
    expect(rescheduleCalendarAllDayItem(birthday, '2026-08-04')).toMatchObject({
      kind: 'birthday',
      date: '2026-08-04',
      birthYear: 1990,
    });
  });
});
