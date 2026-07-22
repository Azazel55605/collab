import ICAL from 'ical.js';
import type { CalendarItem, CalendarTimeValue } from '../types/calendar';

const MAX_RECURRENCE_ITERATIONS = 20_000;

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function validateRecurrenceRule(value: string): void {
  ICAL.Recur.fromString(value.replace(/^RRULE:/i, ''));
}

function wallTimeAt(instant: Date, timeZone: string): WallTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function wallTimeNumber(value: WallTime): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
}

function instantForWallTime(value: WallTime, timeZone: string): Date {
  const target = wallTimeNumber(value);
  let candidate = target;
  for (let index = 0; index < 4; index += 1) {
    const represented = wallTimeNumber(wallTimeAt(new Date(candidate), timeZone));
    const correction = target - represented;
    if (correction === 0) break;
    candidate += correction;
  }
  return new Date(candidate);
}

function timeValueInstant(value: CalendarTimeValue): Date {
  return value.kind === 'dateTime'
    ? new Date(value.dateTime)
    : new Date(`${value.date}T00:00:00.000Z`);
}

function recurrenceBase(item: CalendarItem): CalendarTimeValue | null {
  if (item.kind === 'event') return item.start;
  if (item.kind === 'task') return item.start ?? item.due ?? null;
  return { kind: 'date', date: item.date };
}

function icalTimeForValue(value: CalendarTimeValue): InstanceType<typeof ICAL.Time> {
  if (value.kind === 'date') {
    const [year, month, day] = value.date.split('-').map(Number);
    return ICAL.Time.fromData({ year, month, day, isDate: true });
  }
  const wall = wallTimeAt(new Date(value.dateTime), value.timeZone);
  return ICAL.Time.fromData({ ...wall, isDate: false });
}

function occurrenceInstant(
  occurrence: InstanceType<typeof ICAL.Time>,
  base: CalendarTimeValue,
): Date {
  if (base.kind === 'date') {
    return new Date(Date.UTC(occurrence.year, occurrence.month - 1, occurrence.day));
  }
  return instantForWallTime({
    year: occurrence.year,
    month: occurrence.month,
    day: occurrence.day,
    hour: occurrence.hour,
    minute: occurrence.minute,
    second: occurrence.second,
  }, base.timeZone);
}

function shiftTimeValue(value: CalendarTimeValue, deltaMs: number): CalendarTimeValue {
  if (value.kind === 'dateTime') {
    return { ...value, dateTime: new Date(new Date(value.dateTime).getTime() + deltaMs).toISOString() };
  }
  const shifted = new Date(new Date(`${value.date}T00:00:00.000Z`).getTime() + deltaMs);
  return { kind: 'date', date: shifted.toISOString().slice(0, 10) };
}

function shiftedOccurrence(item: CalendarItem, base: CalendarTimeValue, start: Date): CalendarItem {
  const delta = start.getTime() - timeValueInstant(base).getTime();
  const recurrenceId = shiftTimeValue(base, delta);
  const id = `${item.id}::${recurrenceId.kind === 'date' ? recurrenceId.date : recurrenceId.dateTime}`;
  if (item.kind === 'event') {
    return { ...item, id, recurrenceId, start: shiftTimeValue(item.start, delta), end: shiftTimeValue(item.end, delta) };
  }
  if (item.kind === 'task') {
    return {
      ...item,
      id,
      recurrenceId,
      start: item.start ? shiftTimeValue(item.start, delta) : undefined,
      due: item.due ? shiftTimeValue(item.due, delta) : undefined,
    };
  }
  const shifted = shiftTimeValue({ kind: 'date', date: item.date }, delta);
  return { ...item, id, recurrenceId, date: shifted.kind === 'date' ? shifted.date : item.date };
}

function itemDuration(item: CalendarItem, base: CalendarTimeValue): number {
  if (item.kind === 'event') return timeValueInstant(item.end).getTime() - timeValueInstant(item.start).getTime();
  if (item.kind === 'task') {
    const end = item.due ?? item.start ?? base;
    return Math.max(1, timeValueInstant(end).getTime() - timeValueInstant(base).getTime());
  }
  return 86_400_000;
}

export function expandRecurringItem(
  item: CalendarItem,
  from: number,
  to: number,
  limit: number,
): CalendarItem[] {
  if (!item.recurrence || limit <= 0) return [item];
  const base = recurrenceBase(item);
  if (!base) return [];
  const component = new ICAL.Component('vevent');
  component.addPropertyWithValue('dtstart', icalTimeForValue(base));
  component.addPropertyWithValue('rrule', ICAL.Recur.fromString(item.recurrence.rrule));
  for (const value of item.recurrence.rdates ?? []) component.addPropertyWithValue('rdate', icalTimeForValue(value));
  for (const value of item.recurrence.exdates ?? []) component.addPropertyWithValue('exdate', icalTimeForValue(value));
  const iterator = new ICAL.RecurExpansion({ component, dtstart: icalTimeForValue(base) });
  const duration = itemDuration(item, base);
  const results: CalendarItem[] = [];
  for (let iterations = 0; iterations < MAX_RECURRENCE_ITERATIONS && results.length < limit; iterations += 1) {
    const next = iterator.next();
    if (!next) break;
    const instant = occurrenceInstant(next, base);
    if (instant.getTime() >= to) break;
    if (instant.getTime() + duration > from) results.push(shiftedOccurrence(item, base, instant));
  }
  return results;
}
