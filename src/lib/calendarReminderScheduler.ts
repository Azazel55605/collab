import type {
  CalendarItem,
  CalendarReminderScheduleEntry,
  CalendarReminderScheduler,
  CalendarTimeValue,
} from '../types/calendar';
import { calendarTimeValueKey } from '../types/calendar';
import type {
  NotificationAction,
  NotificationEnvelope,
  NotificationKind,
} from '../types/notification';

import { expandRecurringItem } from './calendarRecurrence';
import {
  createNotificationId,
  defaultPrivacyForNotification,
  validateNotificationEnvelope,
} from './notificationContract';
import { tauriCommands } from './tauri';

export const noOpCalendarReminderScheduler: CalendarReminderScheduler = {
  async reconcileProfile() {},
  async cancelProfile() {},
};

const REMINDER_CATEGORY = 'calendar.reminder' as const;
const REMINDER_HORIZON_DAYS = 366;
const MAX_REMINDER_OCCURRENCES = 20_000;

export const nativeCalendarReminderScheduler: CalendarReminderScheduler = {
  async reconcileProfile(profileId, entries) {
    const createdAt = new Date().toISOString();
    await tauriCommands.notificationReconcile(
      profileId,
      REMINDER_CATEGORY,
      entries.map((entry) => reminderEnvelope(entry, createdAt)),
    );
  },
  async cancelProfile(profileId) {
    await tauriCommands.notificationCancelCategory(profileId, REMINDER_CATEGORY);
  },
};

function itemStart(item: CalendarItem): CalendarTimeValue | undefined {
  if (item.kind === 'event') return item.start;
  if (item.kind === 'task') return item.start ?? item.due;
  return { kind: 'date', date: item.date };
}

function reminderFireAt(start: CalendarTimeValue, minutesBefore: number): string {
  const instant =
    start.kind === 'date' ? new Date(`${start.date}T09:00:00`) : new Date(start.dateTime);
  return new Date(instant.getTime() - minutesBefore * 60_000).toISOString();
}

function reminderKind(itemKind: CalendarReminderScheduleEntry['itemKind']): NotificationKind {
  if (itemKind === 'task') return 'calendar.task-reminder';
  if (itemKind === 'birthday') return 'calendar.birthday-reminder';
  return 'calendar.event-reminder';
}

function reminderActions(
  itemKind: CalendarReminderScheduleEntry['itemKind'],
): NotificationAction[] {
  const actions: NotificationAction[] = [
    { kind: 'open' },
    { kind: 'dismiss' },
    { kind: 'snooze', minutes: 10 },
  ];
  if (itemKind === 'task') actions.push({ kind: 'calendar.task.complete' });
  return actions;
}

export function reminderEnvelope(
  entry: CalendarReminderScheduleEntry,
  createdAt = new Date().toISOString(),
): NotificationEnvelope {
  const kind = reminderKind(entry.itemKind);
  const occurrenceKey = entry.recurrenceId ? calendarTimeValueKey(entry.recurrenceId) : undefined;
  const envelope: NotificationEnvelope = {
    schemaVersion: 1,
    id: createNotificationId({
      category: REMINDER_CATEGORY,
      accountKey: entry.profileId,
      sourceId: entry.itemId,
      occurrenceKey,
      deliveryKey: entry.scheduleId,
    }),
    category: REMINDER_CATEGORY,
    kind,
    channel: 'calendar',
    accountKey: entry.profileId,
    sourceId: entry.itemId,
    ...(occurrenceKey ? { occurrenceKey } : {}),
    deliveryKey: entry.scheduleId,
    createdAt,
    scheduledAt: entry.fireAt,
    title: entry.title.slice(0, 500),
    ...(entry.body?.trim() ? { body: entry.body.slice(0, 4_096) } : {}),
    privacy: defaultPrivacyForNotification(kind),
    priority: 'time-sensitive',
    destination: {
      kind: 'calendar-item',
      profileId: entry.profileId,
      calendarId: entry.calendarId,
      itemId: entry.itemId,
      ...(occurrenceKey ? { occurrenceKey } : {}),
    },
    actions: reminderActions(entry.itemKind),
    requiresInbox: true,
  };
  return validateNotificationEnvelope(envelope);
}

export function expandReminderHorizon(items: CalendarItem[], now = Date.now()): CalendarItem[] {
  const from = now - 24 * 60 * 60_000;
  const to = now + REMINDER_HORIZON_DAYS * 24 * 60 * 60_000;
  const exceptions = new Map(
    items
      .filter((item) => item.recurrenceId && item.recurrenceSeriesId)
      .map((item) => [
        `${item.recurrenceSeriesId}:${calendarTimeValueKey(item.recurrenceId!)}`,
        item,
      ]),
  );
  const expanded: CalendarItem[] = [];
  for (const item of items) {
    if (expanded.length >= MAX_REMINDER_OCCURRENCES) break;
    if (item.recurrenceId && item.recurrenceSeriesId) continue;
    if (item.kind === 'birthday') {
      const [birthYear, month, day] = item.date.split('-').map(Number);
      const firstYear = new Date(from).getUTCFullYear();
      const lastYear = new Date(to).getUTCFullYear();
      for (let year = firstYear; year <= lastYear; year += 1) {
        if (expanded.length >= MAX_REMINDER_OCCURRENCES) break;
        const occurrenceDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const occurrenceTime = Date.parse(`${occurrenceDate}T00:00:00.000Z`);
        if (occurrenceTime < from || occurrenceTime >= to) continue;
        expanded.push({
          ...item,
          id: `${item.id}::${occurrenceDate}`,
          date: occurrenceDate,
          birthYear: item.birthYear ?? birthYear,
          recurrenceId: { kind: 'date', date: occurrenceDate },
          recurrenceSeriesId: item.id,
        });
      }
      continue;
    }
    if (!item.recurrence) {
      expanded.push(item);
      continue;
    }
    for (const occurrence of expandRecurringItem(
      item,
      from,
      to,
      MAX_REMINDER_OCCURRENCES - expanded.length,
    )) {
      const key = occurrence.recurrenceId
        ? `${item.id}:${calendarTimeValueKey(occurrence.recurrenceId)}`
        : '';
      expanded.push(exceptions.get(key) ?? occurrence);
    }
  }
  return expanded;
}

export function calendarReminderEntries(items: CalendarItem[]): CalendarReminderScheduleEntry[] {
  return items.flatMap((item) => {
    const start = itemStart(item);
    if (!start || item.deletedAt) return [];
    return item.reminders.flatMap((reminder, index) => {
      const fireAt =
        reminder.kind === 'absolute' ? reminder.at : reminderFireAt(start, reminder.minutesBefore);
      if (!Number.isFinite(Date.parse(fireAt))) return [];
      const itemId = item.recurrenceSeriesId ?? item.id;
      const occurrence = item.recurrenceId ? `:${calendarTimeValueKey(item.recurrenceId)}` : '';
      return [
        {
          scheduleId: `${itemId}${occurrence}:${index}:${fireAt}`,
          profileId: '',
          calendarId: item.calendarId,
          itemId,
          itemKind: item.kind,
          recurrenceId: item.recurrenceId,
          fireAt,
          title: item.title,
          body: item.description,
        },
      ];
    });
  });
}

export async function reconcileCalendarReminders(
  scheduler: CalendarReminderScheduler,
  profileId: string,
  items: CalendarItem[],
): Promise<void> {
  const entries = calendarReminderEntries(expandReminderHorizon(items)).map((entry) => ({
    ...entry,
    profileId,
  }));
  await scheduler.reconcileProfile(profileId, entries);
}

export async function reconcileProfileCalendarReminders(profileId: string): Promise<void> {
  const now = Date.now();
  const from = new Date(now - 24 * 60 * 60_000).toISOString();
  const to = new Date(now + REMINDER_HORIZON_DAYS * 24 * 60 * 60_000).toISOString();
  const items = await tauriCommands.calendarListItems(profileId, from, to, 5_000, false);
  await reconcileCalendarReminders(nativeCalendarReminderScheduler, profileId, items);
}
