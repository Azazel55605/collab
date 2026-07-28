import { describe, expect, it, vi } from 'vitest';

import type { CalendarEvent, CalendarReminderScheduler } from '../types/calendar';
import {
  calendarReminderEntries,
  expandReminderHorizon,
  reminderEnvelope,
  reconcileCalendarReminders,
} from './calendarReminderScheduler';

const event: CalendarEvent = {
  id: 'item-1',
  uid: 'event-uid',
  calendarId: 'calendar-1',
  kind: 'event',
  title: 'Project review',
  description: 'Bring release notes.',
  start: {
    kind: 'dateTime',
    dateTime: '2026-08-01T10:00:00Z',
    timeZone: 'UTC',
  },
  end: {
    kind: 'dateTime',
    dateTime: '2026-08-01T11:00:00Z',
    timeZone: 'UTC',
  },
  availability: 'busy',
  reminders: [{ kind: 'relative', minutesBefore: 15 }],
  attendees: [],
  attachments: [],
  revision: 1,
  createdAt: '2026-07-28T10:00:00Z',
  updatedAt: '2026-07-28T10:00:00Z',
};

describe('calendar reminder scheduler contract', () => {
  it('includes the item kind and calendar identity required for notification routing', () => {
    expect(calendarReminderEntries([event])).toEqual([{
      scheduleId: 'item-1:0:2026-08-01T09:45:00.000Z',
      profileId: '',
      calendarId: 'calendar-1',
      itemId: 'item-1',
      itemKind: 'event',
      fireAt: '2026-08-01T09:45:00.000Z',
      title: 'Project review',
      body: 'Bring release notes.',
    }]);
  });

  it('reconciles stable reminder entries under the selected profile', async () => {
    const scheduler: CalendarReminderScheduler = {
      reconcileProfile: vi.fn().mockResolvedValue(undefined),
      cancelProfile: vi.fn().mockResolvedValue(undefined),
    };

    await reconcileCalendarReminders(scheduler, 'profile-1', [event]);

    expect(scheduler.reconcileProfile).toHaveBeenCalledWith(
      'profile-1',
      [expect.objectContaining({
        profileId: 'profile-1',
        calendarId: 'calendar-1',
        itemKind: 'event',
      })],
    );
  });

  it('builds a validated task-aware native notification envelope', () => {
    const entry = {
      ...calendarReminderEntries([event])[0],
      profileId: 'profile-1',
      itemKind: 'task' as const,
    };

    expect(reminderEnvelope(entry, '2026-07-28T10:00:00Z')).toMatchObject({
      category: 'calendar.reminder',
      kind: 'calendar.task-reminder',
      channel: 'calendar',
      accountKey: 'profile-1',
      sourceId: 'item-1',
      scheduledAt: '2026-08-01T09:45:00.000Z',
      actions: [
        { kind: 'open' },
        { kind: 'dismiss' },
        { kind: 'snooze', minutes: 10 },
        { kind: 'calendar.task.complete' },
      ],
      destination: {
        kind: 'calendar-item',
        profileId: 'profile-1',
        calendarId: 'calendar-1',
        itemId: 'item-1',
      },
    });
  });

  it('expands recurring reminders within a bounded one-year horizon', () => {
    const recurring = {
      ...event,
      recurrence: { rrule: 'FREQ=DAILY;COUNT=3' },
    };

    const expanded = expandReminderHorizon(
      [recurring],
      Date.parse('2026-07-31T00:00:00Z'),
    );

    expect(expanded.map((item) => item.recurrenceId)).toEqual([
      { kind: 'dateTime', dateTime: '2026-08-01T10:00:00.000Z', timeZone: 'UTC' },
      { kind: 'dateTime', dateTime: '2026-08-02T10:00:00.000Z', timeZone: 'UTC' },
      { kind: 'dateTime', dateTime: '2026-08-03T10:00:00.000Z', timeZone: 'UTC' },
    ]);
    expect(calendarReminderEntries(expanded).map((entry) => entry.itemId))
      .toEqual(['item-1', 'item-1', 'item-1']);
  });
});
