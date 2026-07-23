import type { CalendarItem, CalendarTimeValue } from '../types/calendar';

export const CALENDAR_MINUTES_PER_DAY = 24 * 60;
export const CALENDAR_TIMED_MINIMUM_MINUTES = 30;
export const CALENDAR_DRAG_SNAP_MINUTES = 15;

export interface CalendarTimedLayoutEntry {
  item: CalendarItem;
  startMinute: number;
  endMinute: number;
  column: number;
  columnCount: number;
}

function localDayBounds(dateKey: string): { start: number; end: number } {
  const [year, month, day] = dateKey.split('-').map(Number);
  const start = new Date(year, month - 1, day).getTime();
  return { start, end: new Date(year, month - 1, day + 1).getTime() };
}

function timestamp(value: CalendarTimeValue | undefined): number | null {
  return value?.kind === 'dateTime' ? new Date(value.dateTime).getTime() : null;
}

function localDateTime(dateKey: string, minute: number): number {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day, Math.floor(minute / 60), minute % 60).getTime();
}

export function snapCalendarMinute(
  minute: number,
  increment: number = CALENDAR_DRAG_SNAP_MINUTES,
): number {
  const boundedIncrement = Math.max(1, Math.min(CALENDAR_MINUTES_PER_DAY, Math.round(increment)));
  const snapped = Math.round(minute / boundedIncrement) * boundedIncrement;
  return Math.max(0, Math.min(CALENDAR_MINUTES_PER_DAY - boundedIncrement, snapped));
}

export function snapCalendarEndMinute(
  minute: number,
  minimumMinute: number = CALENDAR_DRAG_SNAP_MINUTES,
  increment: number = CALENDAR_DRAG_SNAP_MINUTES,
): number {
  const boundedIncrement = Math.max(1, Math.min(CALENDAR_MINUTES_PER_DAY, Math.round(increment)));
  const minimum = Math.ceil(Math.max(0, minimumMinute) / boundedIncrement) * boundedIncrement;
  const snapped = Math.round(minute / boundedIncrement) * boundedIncrement;
  return Math.max(minimum, Math.min(CALENDAR_MINUTES_PER_DAY, snapped));
}

function shiftTimedValue(value: CalendarTimeValue | undefined, deltaMs: number): CalendarTimeValue | undefined {
  if (value?.kind !== 'dateTime') return value;
  return { ...value, dateTime: new Date(Date.parse(value.dateTime) + deltaMs).toISOString() };
}

function dateDay(value: string): number {
  const [year, month, day] = value.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function shiftDateValue(value: CalendarTimeValue | undefined, deltaDays: number): CalendarTimeValue | undefined {
  if (value?.kind !== 'date') return value;
  const shifted = new Date((dateDay(value.date) + deltaDays) * 86_400_000);
  return { kind: 'date', date: shifted.toISOString().slice(0, 10) };
}

export function rescheduleCalendarAllDayItem(
  item: CalendarItem,
  dateKey: string,
  sourceDateKey?: string,
): CalendarItem | null {
  if (item.kind === 'birthday') return { ...item, date: dateKey };
  if (item.kind === 'event') {
    if (item.start.kind !== 'date' || item.end.kind !== 'date') return null;
    const deltaDays = dateDay(dateKey) - dateDay(sourceDateKey ?? item.start.date);
    return {
      ...item,
      start: shiftDateValue(item.start, deltaDays)!,
      end: shiftDateValue(item.end, deltaDays)!,
    };
  }

  const anchor = item.start?.kind === 'date'
    ? item.start
    : item.due?.kind === 'date'
      ? item.due
      : undefined;
  if (!anchor) return null;
  const deltaDays = dateDay(dateKey) - dateDay(sourceDateKey ?? anchor.date);
  return {
    ...item,
    start: shiftDateValue(item.start, deltaDays),
    due: shiftDateValue(item.due, deltaDays),
  };
}

export function rescheduleCalendarTimedItem(
  item: CalendarItem,
  dateKey: string,
  minute: number,
): CalendarItem | null {
  if (item.kind === 'birthday') return null;
  const snappedMinute = snapCalendarMinute(minute);
  const target = localDateTime(dateKey, snappedMinute);

  if (item.kind === 'event') {
    const start = timestamp(item.start);
    const end = timestamp(item.end);
    if (start == null || end == null) return null;
    const deltaMs = target - start;
    return {
      ...item,
      start: shiftTimedValue(item.start, deltaMs)!,
      end: shiftTimedValue(item.end, deltaMs)!,
    };
  }

  const anchor = timestamp(item.start) ?? timestamp(item.due);
  if (anchor == null) return null;
  const deltaMs = target - anchor;
  return {
    ...item,
    start: shiftTimedValue(item.start, deltaMs),
    due: shiftTimedValue(item.due, deltaMs),
  };
}

export function resizeCalendarTimedItem(
  item: CalendarItem,
  dateKey: string,
  endMinute: number,
): CalendarItem | null {
  if (item.kind === 'birthday') return null;
  const snappedEnd = snapCalendarEndMinute(endMinute);
  let target = localDateTime(dateKey, snappedEnd);

  if (item.kind === 'event') {
    const start = timestamp(item.start);
    if (start == null || item.end.kind !== 'dateTime') return null;
    target = Math.max(target, start + CALENDAR_DRAG_SNAP_MINUTES * 60_000);
    return {
      ...item,
      end: { ...item.end, dateTime: new Date(target).toISOString() },
    };
  }

  const start = timestamp(item.start);
  if (start == null || item.start?.kind !== 'dateTime') return null;
  target = Math.max(target, start + CALENDAR_DRAG_SNAP_MINUTES * 60_000);
  const timeZone = item.due?.kind === 'dateTime' ? item.due.timeZone : item.start.timeZone;
  return {
    ...item,
    due: { kind: 'dateTime', dateTime: new Date(target).toISOString(), timeZone },
  };
}

function itemTimedRange(item: CalendarItem): { start: number; end: number } | null {
  if (item.kind === 'birthday') return null;
  if (item.kind === 'event') {
    const start = timestamp(item.start);
    const end = timestamp(item.end);
    return start == null || end == null ? null : { start, end };
  }

  const start = timestamp(item.start) ?? timestamp(item.due);
  if (start == null) return null;
  const end = timestamp(item.due);
  return { start, end: end != null && end > start ? end : start + CALENDAR_TIMED_MINIMUM_MINUTES * 60_000 };
}

export function calendarTimedRangeForDay(
  item: CalendarItem,
  dateKey: string,
): { startMinute: number; endMinute: number } | null {
  const range = itemTimedRange(item);
  if (!range) return null;
  const day = localDayBounds(dateKey);
  if (range.start >= day.end || range.end <= day.start) return null;

  const startMinute = Math.max(0, (range.start - day.start) / 60_000);
  const actualEndMinute = Math.min(CALENDAR_MINUTES_PER_DAY, (range.end - day.start) / 60_000);
  return {
    startMinute,
    endMinute: Math.min(
      CALENDAR_MINUTES_PER_DAY,
      Math.max(actualEndMinute, startMinute + CALENDAR_TIMED_MINIMUM_MINUTES),
    ),
  };
}

export function layoutCalendarTimedItems(
  items: CalendarItem[],
  dateKey: string,
): CalendarTimedLayoutEntry[] {
  const entries = items
    .flatMap((item) => {
      const range = calendarTimedRangeForDay(item, dateKey);
      return range ? [{ item, ...range, column: 0, columnCount: 1 }] : [];
    })
    .sort((left, right) => (
      left.startMinute - right.startMinute
      || right.endMinute - left.endMinute
      || left.item.id.localeCompare(right.item.id)
    ));

  let cluster: CalendarTimedLayoutEntry[] = [];
  let clusterEnd = -1;
  const finishCluster = () => {
    if (cluster.length === 0) return;
    const activeEnds: number[] = [];
    let columnCount = 1;
    for (const entry of cluster) {
      let column = activeEnds.findIndex((endMinute) => endMinute <= entry.startMinute);
      if (column === -1) {
        column = activeEnds.length;
        activeEnds.push(entry.endMinute);
      } else {
        activeEnds[column] = entry.endMinute;
      }
      entry.column = column;
      columnCount = Math.max(columnCount, activeEnds.length);
    }
    for (const entry of cluster) entry.columnCount = columnCount;
    cluster = [];
    clusterEnd = -1;
  };

  for (const entry of entries) {
    if (cluster.length > 0 && entry.startMinute >= clusterEnd) finishCluster();
    cluster.push(entry);
    clusterEnd = Math.max(clusterEnd, entry.endMinute);
  }
  finishCluster();

  return entries;
}
