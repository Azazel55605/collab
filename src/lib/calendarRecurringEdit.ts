import type { CalendarItem, CalendarRecurrence, CalendarTimeValue } from '../types/calendar';

export type CalendarRecurrenceEditScope = 'occurrence' | 'following' | 'series';

export interface CalendarRecurringEditPlan {
  scope: CalendarRecurrenceEditScope;
  seriesId: string;
  recurrenceId: CalendarTimeValue;
  upserts: CalendarItem[];
}

function timeValueMs(value: CalendarTimeValue): number {
  return value.kind === 'date'
    ? Date.parse(`${value.date}T00:00:00.000Z`)
    : Date.parse(value.dateTime);
}

function itemAnchor(item: CalendarItem): CalendarTimeValue {
  if (item.kind === 'event') return item.start;
  if (item.kind === 'task') {
    const anchor = item.start ?? item.due;
    if (!anchor) throw new Error('Recurring tasks require a start or deadline.');
    return anchor;
  }
  return { kind: 'date', date: item.date };
}

function shiftTimeValue(value: CalendarTimeValue, deltaMs: number): CalendarTimeValue {
  const shifted = new Date(timeValueMs(value) + deltaMs);
  return value.kind === 'date'
    ? { kind: 'date', date: shifted.toISOString().slice(0, 10) }
    : { ...value, dateTime: shifted.toISOString() };
}

function shiftItem(item: CalendarItem, deltaMs: number): CalendarItem {
  if (item.kind === 'event') {
    return {
      ...item,
      start: shiftTimeValue(item.start, deltaMs),
      end: shiftTimeValue(item.end, deltaMs),
    };
  }
  if (item.kind === 'task') {
    return {
      ...item,
      start: item.start ? shiftTimeValue(item.start, deltaMs) : undefined,
      due: item.due ? shiftTimeValue(item.due, deltaMs) : undefined,
    };
  }
  const shifted = shiftTimeValue({ kind: 'date', date: item.date }, deltaMs);
  return { ...item, date: shifted.kind === 'date' ? shifted.date : item.date };
}

function ruleParts(rule: string): Map<string, string> {
  return new Map(
    rule.split(';').map((part) => {
      const separator = part.indexOf('=');
      return [part.slice(0, separator).toUpperCase(), part.slice(separator + 1)];
    }),
  );
}

function serializeRule(parts: Map<string, string>): string {
  const preferred = ['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'WKST'];
  return [...parts.entries()]
    .sort(([left], [right]) => {
      const leftIndex = preferred.indexOf(left);
      const rightIndex = preferred.indexOf(right);
      if (leftIndex >= 0 || rightIndex >= 0) {
        return (
          (leftIndex < 0 ? preferred.length : leftIndex) -
          (rightIndex < 0 ? preferred.length : rightIndex)
        );
      }
      return left.localeCompare(right);
    })
    .map(([key, value]) => `${key}=${value}`)
    .join(';');
}

function untilBefore(value: CalendarTimeValue): string {
  if (value.kind === 'date') {
    const previous = new Date(Date.parse(`${value.date}T00:00:00.000Z`) - 86_400_000);
    return previous.toISOString().slice(0, 10).replace(/-/g, '');
  }
  return new Date(Date.parse(value.dateTime) - 1_000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('.000', '');
}

function splitValues(
  values: CalendarTimeValue[] | undefined,
  recurrenceId: CalendarTimeValue,
  side: 'before' | 'after',
): CalendarTimeValue[] | undefined {
  const boundary = timeValueMs(recurrenceId);
  const filtered = values?.filter((value) =>
    side === 'before' ? timeValueMs(value) < boundary : timeValueMs(value) >= boundary,
  );
  return filtered && filtered.length > 0 ? filtered : undefined;
}

export function splitRecurrence(
  recurrence: CalendarRecurrence,
  recurrenceId: CalendarTimeValue,
  priorOccurrences: number,
): { previous: CalendarRecurrence | null; following: CalendarRecurrence } {
  const previousParts = ruleParts(recurrence.rrule);
  const followingParts = ruleParts(recurrence.rrule);
  const count = Number(previousParts.get('COUNT'));

  if (Number.isSafeInteger(count) && count > 0) {
    previousParts.delete('UNTIL');
    followingParts.delete('UNTIL');
    previousParts.set('COUNT', String(priorOccurrences));
    followingParts.set('COUNT', String(Math.max(1, count - priorOccurrences)));
  } else {
    previousParts.delete('COUNT');
    previousParts.set('UNTIL', untilBefore(recurrenceId));
  }

  return {
    previous:
      priorOccurrences <= 0
        ? null
        : {
            rrule: serializeRule(previousParts),
            rdates: splitValues(recurrence.rdates, recurrenceId, 'before'),
            exdates: splitValues(recurrence.exdates, recurrenceId, 'before'),
          },
    following: {
      rrule: serializeRule(followingParts),
      rdates: splitValues(recurrence.rdates, recurrenceId, 'after'),
      exdates: splitValues(recurrence.exdates, recurrenceId, 'after'),
    },
  };
}

export function planRecurringEdit(input: {
  master: CalendarItem;
  originalOccurrence: CalendarItem;
  editedOccurrence: CalendarItem;
  scope: CalendarRecurrenceEditScope;
  now: string;
  exceptionId?: string;
  followingSeriesId?: string;
  priorOccurrences?: number;
}): CalendarRecurringEditPlan {
  const { master, originalOccurrence, editedOccurrence, scope, now } = input;
  const recurrenceId = originalOccurrence.recurrenceId;
  if (!master.recurrence || !recurrenceId) {
    throw new Error('A recurring master and occurrence are required.');
  }

  if (scope === 'occurrence') {
    if (!input.exceptionId) throw new Error('An exception ID is required.');
    return {
      scope,
      seriesId: master.id,
      recurrenceId,
      upserts: [
        {
          ...editedOccurrence,
          id: input.exceptionId,
          uid: master.uid,
          recurrence: undefined,
          recurrenceId,
          recurrenceSeriesId: master.id,
          revision: editedOccurrence.id === input.exceptionId ? editedOccurrence.revision : 0,
          createdAt: editedOccurrence.id === input.exceptionId ? editedOccurrence.createdAt : now,
          updatedAt: now,
          deletedAt: undefined,
        },
      ],
    };
  }

  const occurrenceOffset = timeValueMs(itemAnchor(master)) - timeValueMs(recurrenceId);
  if (scope === 'series') {
    const shifted = shiftItem(editedOccurrence, occurrenceOffset);
    return {
      scope,
      seriesId: master.id,
      recurrenceId,
      upserts: [
        {
          ...shifted,
          id: master.id,
          uid: master.uid,
          recurrence: editedOccurrence.recurrence,
          recurrenceId: undefined,
          recurrenceSeriesId: undefined,
          revision: master.revision,
          createdAt: master.createdAt,
          updatedAt: now,
          deletedAt: undefined,
        },
      ],
    };
  }

  if (!input.followingSeriesId) throw new Error('A following-series ID is required.');
  const split = splitRecurrence(master.recurrence, recurrenceId, input.priorOccurrences ?? 0);
  const upserts: CalendarItem[] = [];
  if (split.previous) {
    upserts.push({ ...master, recurrence: split.previous, updatedAt: now });
  }
  const followingRecurrence =
    editedOccurrence.recurrence?.rrule === master.recurrence.rrule
      ? split.following
      : editedOccurrence.recurrence;
  upserts.push({
    ...editedOccurrence,
    id: input.followingSeriesId,
    uid: `${input.followingSeriesId}@collab.local`,
    recurrence: followingRecurrence,
    recurrenceId: undefined,
    recurrenceSeriesId: undefined,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: undefined,
  });
  return { scope, seriesId: master.id, recurrenceId, upserts };
}
