import ICAL from 'ical.js';

import {
  type CalendarAttachment,
  type CalendarAttendee,
  type CalendarDefinition,
  type CalendarItem,
  type CalendarReminder,
  type CalendarTaskPriority,
  type CalendarTaskStatus,
  type CalendarTimeValue,
  calendarTimeValueKey,
  normalizeCalendarItem,
} from '../types/calendar';

export const MAX_ICS_BYTES = 5 * 1024 * 1024;
export const MAX_ICS_ITEMS = 5_000;
export const MAX_ICS_LINE_LENGTH = 64 * 1024;

export type CalendarIcsImportAction = 'create' | 'update' | 'unchanged' | 'conflict';

export interface CalendarIcsImportEntry {
  key: string;
  action: CalendarIcsImportAction;
  item: CalendarItem;
  existing?: CalendarItem;
  reason?: string;
}

export interface CalendarIcsImportPreview {
  calendarName?: string;
  entries: CalendarIcsImportEntry[];
  warnings: string[];
  creates: number;
  updates: number;
  unchanged: number;
  conflicts: number;
}

function requiredText(component: InstanceType<typeof ICAL.Component>, name: string): string {
  const value = component.getFirstPropertyValue(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(
  component: InstanceType<typeof ICAL.Component>,
  name: string,
): string | undefined {
  const value = requiredText(component, name);
  return value || undefined;
}

function dateKey(time: InstanceType<typeof ICAL.Time>): string {
  return `${String(time.year).padStart(4, '0')}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
}

function timeValue(
  component: InstanceType<typeof ICAL.Component>,
  name: string,
  fallbackTimeZone: string,
): CalendarTimeValue | undefined {
  const property = component.getFirstProperty(name);
  const value = property?.getFirstValue();
  if (!(value instanceof ICAL.Time)) return undefined;
  if (value.isDate) return { kind: 'date', date: dateKey(value) };
  const preservedTimeZone = optionalText(component, `x-collab-${name}-timezone`);
  const timeZone =
    preservedTimeZone ||
    property?.getFirstParameter('tzid') ||
    (value.zone?.tzid && value.zone.tzid !== 'floating' ? value.zone.tzid : fallbackTimeZone);
  return {
    kind: 'dateTime',
    dateTime: value.toJSDate().toISOString(),
    timeZone,
  };
}

function addMilliseconds(value: CalendarTimeValue, milliseconds: number): CalendarTimeValue {
  if (value.kind === 'date') {
    const shifted = new Date(Date.parse(`${value.date}T00:00:00.000Z`) + milliseconds);
    return { kind: 'date', date: shifted.toISOString().slice(0, 10) };
  }
  return {
    kind: 'dateTime',
    dateTime: new Date(Date.parse(value.dateTime) + milliseconds).toISOString(),
    timeZone: value.timeZone,
  };
}

function recurrenceValues(
  component: InstanceType<typeof ICAL.Component>,
  name: string,
  fallbackTimeZone: string,
): CalendarTimeValue[] {
  const results: CalendarTimeValue[] = [];
  for (const property of component.getAllProperties(name)) {
    for (const value of property.getValues()) {
      if (!(value instanceof ICAL.Time)) continue;
      if (value.isDate) {
        results.push({ kind: 'date', date: dateKey(value) });
        continue;
      }
      const timeZone =
        property.getFirstParameter('tzid') ||
        (value.zone?.tzid && value.zone.tzid !== 'floating' && value.zone.tzid !== 'UTC'
          ? value.zone.tzid
          : fallbackTimeZone);
      results.push({
        kind: 'dateTime',
        dateTime: value.toJSDate().toISOString(),
        timeZone,
      });
    }
  }
  return results;
}

function reminders(component: InstanceType<typeof ICAL.Component>): CalendarReminder[] {
  const results: CalendarReminder[] = [];
  for (const alarm of component.getAllSubcomponents('valarm')) {
    const trigger = alarm.getFirstPropertyValue('trigger');
    if (trigger instanceof ICAL.Duration) {
      const seconds = trigger.toSeconds();
      if (seconds <= 0)
        results.push({ kind: 'relative', minutesBefore: Math.abs(Math.round(seconds / 60)) });
    }
    if (trigger instanceof ICAL.Time) {
      results.push({ kind: 'absolute', at: trigger.toJSDate().toISOString() });
    }
  }
  return results;
}

function attendanceResponse(value: string | undefined): CalendarAttendee['response'] {
  switch (value?.toLowerCase()) {
    case 'accepted':
      return 'accepted';
    case 'declined':
      return 'declined';
    case 'tentative':
      return 'tentative';
    default:
      return 'needs-action';
  }
}

function attendeeRole(value: string | undefined): CalendarAttendee['role'] {
  return value?.toLowerCase() === 'opt-participant' ? 'optional' : 'required';
}

function attendees(component: InstanceType<typeof ICAL.Component>): CalendarAttendee[] {
  return component.getAllProperties('attendee').flatMap((property, index) => {
    const value = property.getFirstValue();
    if (typeof value !== 'string' || !value.toLowerCase().startsWith('mailto:')) return [];
    const email = value.slice(7).trim().toLowerCase();
    if (!email) return [];
    return [
      {
        id: `ics-attendee-${index}`,
        kind: 'email' as const,
        email,
        displayName: property.getFirstParameter('cn') || undefined,
        response: attendanceResponse(property.getFirstParameter('partstat')),
        role: attendeeRole(property.getFirstParameter('role')),
      },
    ];
  });
}

function attachments(component: InstanceType<typeof ICAL.Component>): CalendarAttachment[] {
  return component.getAllProperties('attach').flatMap((property, index) => {
    const value = property.getFirstValue();
    if (typeof value !== 'string') return [];
    try {
      const url = new URL(value).toString();
      return [
        {
          id: `ics-attachment-${index}`,
          kind: 'externalUrl' as const,
          name: property.getFirstParameter('filename') || url,
          url,
        },
      ];
    } catch {
      return [];
    }
  });
}

function preservedProperties(component: InstanceType<typeof ICAL.Component>): string[] {
  return component
    .getAllProperties()
    .flatMap((property) => {
      if (!property.name.startsWith('x-') || property.name.startsWith('x-collab-')) return [];
      const line = property.toICALString().replace(/\r?\n[ \t]/g, '');
      return line.length <= 16_384 && !/[\r\n]/.test(line) ? [line] : [];
    })
    .slice(0, 64);
}

function taskStatus(value: string | undefined): CalendarTaskStatus {
  switch (value?.toLowerCase()) {
    case 'in-process':
      return 'in-progress';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'needs-action';
  }
}

function taskPriority(value: unknown): CalendarTaskPriority | undefined {
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority === 0) return undefined;
  if (priority <= 4) return 'high';
  if (priority === 5) return 'medium';
  return 'low';
}

function commonItemFields(
  component: InstanceType<typeof ICAL.Component>,
  calendarId: string,
  fallbackTimeZone: string,
  now: string,
) {
  const uid = requiredText(component, 'uid');
  if (!uid) throw new Error('A calendar item is missing its UID.');
  const rrule = component.getFirstPropertyValue('rrule');
  const rdates = recurrenceValues(component, 'rdate', fallbackTimeZone);
  const exdates = recurrenceValues(component, 'exdate', fallbackTimeZone);
  return {
    id: crypto.randomUUID(),
    uid,
    calendarId,
    title: optionalText(component, 'summary') ?? 'Untitled',
    description: optionalText(component, 'description'),
    url: optionalText(component, 'url'),
    reminders: reminders(component),
    attendees: attendees(component),
    attachments: attachments(component),
    recurrence:
      rrule instanceof ICAL.Recur
        ? {
            rrule: rrule.toString(),
            rdates: rdates.length ? rdates : undefined,
            exdates: exdates.length ? exdates : undefined,
          }
        : undefined,
    recurrenceId: timeValue(component, 'recurrence-id', fallbackTimeZone),
    icalendarProperties: preservedProperties(component),
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function parseComponent(
  component: InstanceType<typeof ICAL.Component>,
  calendar: CalendarDefinition,
  now: string,
): CalendarItem {
  const common = commonItemFields(component, calendar.id, calendar.defaultTimeZone, now);
  const collabKind = optionalText(component, 'x-collab-kind')?.toLowerCase();
  if (component.name === 'vtodo') {
    const completed = timeValue(component, 'completed', 'UTC');
    return normalizeCalendarItem({
      ...common,
      kind: 'task',
      start: timeValue(component, 'dtstart', calendar.defaultTimeZone),
      due: timeValue(component, 'due', calendar.defaultTimeZone),
      priority: taskPriority(component.getFirstPropertyValue('priority')),
      status: taskStatus(optionalText(component, 'status')),
      completedAt: completed?.kind === 'dateTime' ? completed.dateTime : undefined,
    });
  }
  const start = timeValue(component, 'dtstart', calendar.defaultTimeZone);
  if (!start) throw new Error(`Event "${common.title}" is missing DTSTART.`);
  if (collabKind === 'birthday' && start.kind === 'date') {
    return normalizeCalendarItem({
      ...common,
      kind: 'birthday',
      date: start.date,
      birthYear: Number(component.getFirstPropertyValue('x-collab-birth-year')) || undefined,
    });
  }
  const end =
    timeValue(component, 'dtend', calendar.defaultTimeZone) ??
    addMilliseconds(start, start.kind === 'date' ? 86_400_000 : 3_600_000);
  return normalizeCalendarItem({
    ...common,
    kind: 'event',
    start,
    end,
    location: optionalText(component, 'location'),
    availability:
      optionalText(component, 'transp')?.toLowerCase() === 'transparent' ? 'free' : 'busy',
  });
}

function importKey(item: Pick<CalendarItem, 'uid' | 'recurrenceId'>): string {
  return `${item.uid}\0${item.recurrenceId ? calendarTimeValueKey(item.recurrenceId) : 'master'}`;
}

function semanticValue(item: CalendarItem): string {
  const {
    id: _id,
    revision: _revision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    ...value
  } = item;
  return JSON.stringify(value);
}

export function previewCalendarIcsImport(
  content: string,
  calendar: CalendarDefinition,
  existingItems: CalendarItem[],
  now = new Date().toISOString(),
): CalendarIcsImportPreview {
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (byteLength > MAX_ICS_BYTES)
    throw new Error(`iCalendar files cannot exceed ${MAX_ICS_BYTES / 1024 / 1024} MB.`);
  for (const line of content.split(/\r?\n/)) {
    if (line.length > MAX_ICS_LINE_LENGTH)
      throw new Error('An iCalendar content line exceeds the supported limit.');
  }

  let root: InstanceType<typeof ICAL.Component>;
  try {
    root = new ICAL.Component(ICAL.parse(content));
  } catch {
    throw new Error('The selected file is not valid iCalendar data.');
  }
  if (root.name !== 'vcalendar') throw new Error('The selected file does not contain a VCALENDAR.');
  const components = [...root.getAllSubcomponents('vevent'), ...root.getAllSubcomponents('vtodo')];
  if (components.length > MAX_ICS_ITEMS)
    throw new Error(`iCalendar imports cannot contain more than ${MAX_ICS_ITEMS} items.`);

  const existingByKey = new Map(
    existingItems
      .filter((item) => item.calendarId === calendar.id)
      .map((item) => [importKey(item), item]),
  );
  const importedByKey = new Map<string, CalendarItem>();
  const entries: CalendarIcsImportEntry[] = [];
  const warnings: string[] = [];

  const parsedItems: CalendarItem[] = [];
  for (const component of components) {
    try {
      parsedItems.push(parseComponent(component, calendar, now));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }
  const seriesIds = new Map<string, string>();
  for (const existing of existingItems) {
    if (existing.calendarId === calendar.id && !existing.recurrenceId)
      seriesIds.set(existing.uid, existing.id);
  }
  for (const parsed of parsedItems) {
    if (!parsed.recurrenceId && !seriesIds.has(parsed.uid)) seriesIds.set(parsed.uid, parsed.id);
  }

  for (const parsedInput of parsedItems) {
    try {
      const parsed =
        parsedInput.recurrenceId && seriesIds.has(parsedInput.uid)
          ? normalizeCalendarItem({
              ...parsedInput,
              recurrenceSeriesId: seriesIds.get(parsedInput.uid),
            })
          : parsedInput;
      const key = importKey(parsed);
      const duplicate = importedByKey.get(key);
      if (duplicate) {
        if (semanticValue(duplicate) !== semanticValue(parsed)) {
          entries.push({
            key,
            action: 'conflict',
            item: parsed,
            reason: 'The file contains different items with the same UID and recurrence instance.',
          });
        } else {
          warnings.push(`Ignored duplicate item "${parsed.title}".`);
        }
        continue;
      }
      importedByKey.set(key, parsed);
      const existing = existingByKey.get(key);
      if (!existing) {
        entries.push({ key, action: 'create', item: parsed });
      } else {
        const updated = normalizeCalendarItem({
          ...parsed,
          id: existing.id,
          revision: existing.revision + 1,
          createdAt: existing.createdAt,
          updatedAt: now,
        });
        entries.push({
          key,
          action:
            !existing.deletedAt && semanticValue(existing) === semanticValue(updated)
              ? 'unchanged'
              : 'update',
          item: updated,
          existing,
        });
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    calendarName: optionalText(root, 'x-wr-calname'),
    entries,
    warnings,
    creates: entries.filter((entry) => entry.action === 'create').length,
    updates: entries.filter((entry) => entry.action === 'update').length,
    unchanged: entries.filter((entry) => entry.action === 'unchanged').length,
    conflicts: entries.filter((entry) => entry.action === 'conflict').length,
  };
}

function icalTime(value: CalendarTimeValue): InstanceType<typeof ICAL.Time> {
  if (value.kind === 'date') {
    const [year, month, day] = value.date.split('-').map(Number);
    return ICAL.Time.fromData({ year, month, day, isDate: true });
  }
  return ICAL.Time.fromJSDate(new Date(value.dateTime), true);
}

function addTimeProperty(
  component: InstanceType<typeof ICAL.Component>,
  name: string,
  value: CalendarTimeValue | undefined,
) {
  if (!value) return;
  component.addPropertyWithValue(name, icalTime(value));
  if (value.kind === 'dateTime' && value.timeZone !== 'UTC') {
    component.addPropertyWithValue(`x-collab-${name}-timezone`, value.timeZone);
  }
}

function addCommonProperties(component: InstanceType<typeof ICAL.Component>, item: CalendarItem) {
  component.addPropertyWithValue('uid', item.uid);
  component.addPropertyWithValue('summary', item.title);
  component.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(item.updatedAt), true));
  component.addPropertyWithValue('sequence', item.revision);
  if (item.description) component.addPropertyWithValue('description', item.description);
  if (item.url) component.addPropertyWithValue('url', item.url);
  if (item.recurrenceId) addTimeProperty(component, 'recurrence-id', item.recurrenceId);
  if (item.recurrence) {
    component.addPropertyWithValue('rrule', ICAL.Recur.fromString(item.recurrence.rrule));
    for (const value of item.recurrence.rdates ?? []) addTimeProperty(component, 'rdate', value);
    for (const value of item.recurrence.exdates ?? []) addTimeProperty(component, 'exdate', value);
  }
  for (const reminder of item.reminders) {
    const alarm = new ICAL.Component('valarm');
    alarm.addPropertyWithValue('action', 'DISPLAY');
    alarm.addPropertyWithValue('description', item.title);
    if (reminder.kind === 'relative') {
      alarm.addPropertyWithValue(
        'trigger',
        ICAL.Duration.fromSeconds(-reminder.minutesBefore * 60),
      );
    } else {
      alarm.addPropertyWithValue('trigger', ICAL.Time.fromJSDate(new Date(reminder.at), true));
    }
    component.addSubcomponent(alarm);
  }
  for (const attendee of item.attendees) {
    if (attendee.kind !== 'email') continue;
    const property = component.addPropertyWithValue('attendee', `mailto:${attendee.email}`);
    if (attendee.displayName) property.setParameter('cn', attendee.displayName);
    property.setParameter('partstat', attendee.response.toUpperCase());
    property.setParameter(
      'role',
      attendee.role === 'optional' ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT',
    );
  }
  for (const attachment of item.attachments) {
    if (attachment.kind !== 'externalUrl') continue;
    const property = component.addPropertyWithValue('attach', attachment.url);
    property.setParameter('filename', attachment.name);
  }
  for (const line of item.icalendarProperties ?? []) {
    try {
      const parsed = new ICAL.Component(
        ICAL.parse(
          [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            `BEGIN:${component.name.toUpperCase()}`,
            line,
            `END:${component.name.toUpperCase()}`,
            'END:VCALENDAR',
          ].join('\r\n'),
        ),
      );
      const property = parsed.getFirstSubcomponent(component.name)?.getFirstProperty();
      if (property?.name.startsWith('x-') && !property.name.startsWith('x-collab-')) {
        component.addProperty(property);
      }
    } catch {
      // Normalization rejects invalid preserved lines; ignore legacy malformed values defensively.
    }
  }
}

function componentForItem(item: CalendarItem): InstanceType<typeof ICAL.Component> {
  const component = new ICAL.Component(item.kind === 'task' ? 'vtodo' : 'vevent');
  addCommonProperties(component, item);
  if (item.kind === 'event') {
    addTimeProperty(component, 'dtstart', item.start);
    addTimeProperty(component, 'dtend', item.end);
    if (item.location) component.addPropertyWithValue('location', item.location.label);
    component.addPropertyWithValue(
      'transp',
      item.availability === 'free' ? 'TRANSPARENT' : 'OPAQUE',
    );
  } else if (item.kind === 'task') {
    addTimeProperty(component, 'dtstart', item.start);
    addTimeProperty(component, 'due', item.due);
    component.addPropertyWithValue(
      'status',
      item.status === 'in-progress' ? 'IN-PROCESS' : item.status.toUpperCase(),
    );
    if (item.completedAt)
      component.addPropertyWithValue(
        'completed',
        ICAL.Time.fromJSDate(new Date(item.completedAt), true),
      );
    if (item.priority)
      component.addPropertyWithValue(
        'priority',
        item.priority === 'high' ? 1 : item.priority === 'medium' ? 5 : 9,
      );
  } else {
    addTimeProperty(component, 'dtstart', { kind: 'date', date: item.date });
    component.addPropertyWithValue('x-collab-kind', 'BIRTHDAY');
    if (item.birthYear) component.addPropertyWithValue('x-collab-birth-year', item.birthYear);
  }
  return component;
}

export function exportCalendarIcs(calendar: CalendarDefinition, items: CalendarItem[]): string {
  const root = new ICAL.Component('vcalendar');
  root.addPropertyWithValue('version', '2.0');
  root.addPropertyWithValue('prodid', '-//Collab//Calendar//EN');
  root.addPropertyWithValue('calscale', 'GREGORIAN');
  root.addPropertyWithValue('x-wr-calname', calendar.name);
  for (const item of items
    .filter((entry) => entry.calendarId === calendar.id && !entry.deletedAt)
    .sort((left, right) => importKey(left).localeCompare(importKey(right)))) {
    root.addSubcomponent(componentForItem(item));
  }
  return `${root.toString().replace(/\r?\n/g, '\r\n')}\r\n`;
}

export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToUtf8(value: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
  );
}
