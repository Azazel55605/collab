import type {
  CalendarItem,
  CalendarReminderScheduleEntry,
  CalendarReminderScheduler,
  CalendarTimeValue,
} from '../types/calendar';

export const noOpCalendarReminderScheduler: CalendarReminderScheduler = {
  async reconcileProfile() {},
  async cancelProfile() {},
};

function itemStart(item: CalendarItem): CalendarTimeValue | undefined {
  if (item.kind === 'event') return item.start;
  if (item.kind === 'task') return item.start ?? item.due;
  return { kind: 'date', date: item.date };
}

function reminderFireAt(start: CalendarTimeValue, minutesBefore: number): string {
  const instant = start.kind === 'date'
    ? new Date(`${start.date}T09:00:00`)
    : new Date(start.dateTime);
  return new Date(instant.getTime() - minutesBefore * 60_000).toISOString();
}

export function calendarReminderEntries(items: CalendarItem[]): CalendarReminderScheduleEntry[] {
  return items.flatMap((item) => {
    const start = itemStart(item);
    if (!start || item.deletedAt) return [];
    return item.reminders.flatMap((reminder, index) => {
      const fireAt = reminder.kind === 'absolute'
        ? reminder.at
        : reminderFireAt(start, reminder.minutesBefore);
      if (!Number.isFinite(Date.parse(fireAt))) return [];
      return [{
        scheduleId: `${item.id}:${index}:${fireAt}`,
        profileId: '',
        itemId: item.id,
        recurrenceId: item.recurrenceId,
        fireAt,
        title: item.title,
        body: item.description,
      }];
    });
  });
}

export async function reconcileCalendarReminders(
  scheduler: CalendarReminderScheduler,
  profileId: string,
  items: CalendarItem[],
): Promise<void> {
  const entries = calendarReminderEntries(items).map((entry) => ({ ...entry, profileId }));
  await scheduler.reconcileProfile(profileId, entries);
}
