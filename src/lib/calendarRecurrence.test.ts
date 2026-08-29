import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';

import {
  type CalendarItem,
  MAX_CALENDAR_RECURRENCE_DATES,
  normalizeCalendarItem,
} from '../types/calendar';

import { expandRecurringItem } from './calendarRecurrence';

const createdAt = '2026-01-01T00:00:00Z';

function event(overrides: Record<string, unknown>): CalendarItem {
  return normalizeCalendarItem({
    id: 'event-1',
    uid: 'event-1@collab.local',
    calendarId: 'calendar-1',
    kind: 'event',
    title: 'Recurring event',
    reminders: [],
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  });
}

describe('calendar recurrence', () => {
  it('keeps a timed weekly event at the same wall time across DST', () => {
    const item = event({
      start: { kind: 'dateTime', dateTime: '2026-03-22T08:00:00Z', timeZone: 'Europe/Berlin' },
      end: { kind: 'dateTime', dateTime: '2026-03-22T09:00:00Z', timeZone: 'Europe/Berlin' },
      recurrence: { rrule: 'FREQ=WEEKLY;COUNT=3' },
    });

    const instances = expandRecurringItem(
      item,
      Date.parse('2026-03-20T00:00:00Z'),
      Date.parse('2026-04-10T00:00:00Z'),
      10,
    );

    expect(
      instances.map((instance) =>
        instance.kind === 'event' && instance.start.kind === 'dateTime'
          ? instance.start.dateTime
          : null,
      ),
    ).toEqual(['2026-03-22T08:00:00.000Z', '2026-03-29T07:00:00.000Z', '2026-04-05T07:00:00.000Z']);
  });

  it('preserves exclusive all-day ranges without shifting dates', () => {
    const item = event({
      start: { kind: 'date', date: '2026-07-20' },
      end: { kind: 'date', date: '2026-07-22' },
      recurrence: { rrule: 'FREQ=WEEKLY;COUNT=2' },
    });

    const instances = expandRecurringItem(
      item,
      Date.parse('2026-07-01T00:00:00Z'),
      Date.parse('2026-08-01T00:00:00Z'),
      10,
    );

    expect(
      instances.map((instance) =>
        instance.kind === 'event' ? [instance.start, instance.end] : null,
      ),
    ).toEqual([
      [
        { kind: 'date', date: '2026-07-20' },
        { kind: 'date', date: '2026-07-22' },
      ],
      [
        { kind: 'date', date: '2026-07-27' },
        { kind: 'date', date: '2026-07-29' },
      ],
    ]);
  });

  it('applies recurrence additions and exclusions', () => {
    const item = event({
      start: { kind: 'date', date: '2026-07-20' },
      end: { kind: 'date', date: '2026-07-21' },
      recurrence: {
        rrule: 'FREQ=DAILY;COUNT=3',
        rdates: [{ kind: 'date', date: '2026-07-25' }],
        exdates: [{ kind: 'date', date: '2026-07-21' }],
      },
    });

    const instances = expandRecurringItem(
      item,
      Date.parse('2026-07-19T00:00:00Z'),
      Date.parse('2026-07-27T00:00:00Z'),
      10,
    );

    expect(instances.map((instance) => instance.recurrenceId)).toEqual([
      { kind: 'date', date: '2026-07-20' },
      { kind: 'date', date: '2026-07-22' },
      { kind: 'date', date: '2026-07-25' },
    ]);
  });

  it('bounds an infinite recurrence to the requested result limit', () => {
    const item = event({
      start: { kind: 'date', date: '2026-01-01' },
      end: { kind: 'date', date: '2026-01-02' },
      recurrence: { rrule: 'FREQ=DAILY' },
    });

    expect(
      expandRecurringItem(
        item,
        Date.parse('2026-01-01T00:00:00Z'),
        Date.parse('2030-01-01T00:00:00Z'),
        25,
      ),
    ).toHaveLength(25);
  });

  it('keeps adversarial recurrence ranges bounded and ordered', () => {
    for (const interval of [1, 2, 7, 31]) {
      const item = event({
        start: { kind: 'date', date: '2026-01-01' },
        end: { kind: 'date', date: '2026-01-02' },
        recurrence: { rrule: `FREQ=DAILY;INTERVAL=${interval}` },
      });
      const instances = expandRecurringItem(
        item,
        Date.parse('2026-01-01T00:00:00Z'),
        Date.parse('2126-01-01T00:00:00Z'),
        64,
      );
      expect(instances).toHaveLength(64);
      const keys = instances.map((instance) => JSON.stringify(instance.recurrenceId));
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual([...keys].sort());
    }
  });

  it('rejects excessive explicit recurrence additions and exclusions', () => {
    const values = Array.from({ length: MAX_CALENDAR_RECURRENCE_DATES + 1 }, (_, index) => ({
      kind: 'date',
      date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
    }));
    expect(() =>
      event({
        start: { kind: 'date', date: '2026-01-01' },
        end: { kind: 'date', date: '2026-01-02' },
        recurrence: { rrule: 'FREQ=DAILY', rdates: values },
      }),
    ).toThrow(/cannot exceed/i);
  });

  it('rejects malformed recurrence rules during domain normalization', () => {
    expect(() =>
      event({
        start: { kind: 'date', date: '2026-01-01' },
        end: { kind: 'date', date: '2026-01-02' },
        recurrence: { rrule: 'FREQ=NOT-A-FREQUENCY' },
      }),
    ).toThrow(/RFC 5545/i);
  });

  it('parses and serializes the interoperability fixture without losing recurrence data', () => {
    const source = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Collab//Calendar fixture//EN',
      'BEGIN:VEVENT',
      'UID:fixture@collab.local',
      'DTSTART;VALUE=DATE:20260720',
      'RRULE:FREQ=WEEKLY;COUNT=2',
      'X-COLLAB-FIXTURE:preserve-me',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const serialized = new ICAL.Component(ICAL.parse(source)).toString();
    const reparsed = new ICAL.Component(ICAL.parse(serialized));
    const fixture = reparsed.getFirstSubcomponent('vevent');

    expect(fixture?.getFirstPropertyValue('uid')).toBe('fixture@collab.local');
    expect(fixture?.getFirstPropertyValue('rrule')?.toString()).toBe('FREQ=WEEKLY;COUNT=2');
    expect(fixture?.getFirstPropertyValue('x-collab-fixture')).toBe('preserve-me');
  });

  it('surfaces duplicate UIDs and rejects malformed calendar containers for import policy handling', () => {
    const duplicateUidSource = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:duplicate@collab.local',
      'DTSTART:20260720T100000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:duplicate@collab.local',
      'DTSTART:20260721T100000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const calendar = new ICAL.Component(ICAL.parse(duplicateUidSource));

    expect(
      calendar
        .getAllSubcomponents('vevent')
        .map((component) => component.getFirstPropertyValue('uid')),
    ).toEqual(['duplicate@collab.local', 'duplicate@collab.local']);
    expect(() => ICAL.parse('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:broken')).toThrow();
  });
});
