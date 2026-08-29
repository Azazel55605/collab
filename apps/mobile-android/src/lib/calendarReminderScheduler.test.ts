import { describe, expect, it, vi } from 'vitest';

import {
  calendarReminderEntries,
  reconcileCalendarReminders,
} from '../../../../src/lib/calendarReminderScheduler';
import type { CalendarItem, CalendarReminderScheduler } from '../../../../src/types/calendar';

const item: CalendarItem = {
  id: 'event-1',
  uid: 'event-1@collab.test',
  calendarId: 'calendar-1',
  kind: 'event',
  title: 'Planning',
  description: 'Bring notes',
  start: { kind: 'dateTime', dateTime: '2026-07-23T10:00:00.000Z', timeZone: 'UTC' },
  end: { kind: 'dateTime', dateTime: '2026-07-23T11:00:00.000Z', timeZone: 'UTC' },
  availability: 'busy',
  reminders: [{ kind: 'relative', minutesBefore: 30 }],
  attendees: [],
  attachments: [],
  revision: 0,
  createdAt: '2026-07-22T10:00:00.000Z',
  updatedAt: '2026-07-22T10:00:00.000Z',
};

describe('calendar reminder scheduler connector', () => {
  it('derives stable native scheduling entries', () => {
    expect(calendarReminderEntries([item])).toEqual([
      expect.objectContaining({
        scheduleId: 'event-1:0:2026-07-23T09:30:00.000Z',
        itemId: 'event-1',
        fireAt: '2026-07-23T09:30:00.000Z',
        title: 'Planning',
        body: 'Bring notes',
      }),
    ]);
  });

  it('reconciles through the scheduler boundary with the active profile', async () => {
    const reconcileProfile = vi.fn().mockResolvedValue(undefined);
    const scheduler: CalendarReminderScheduler = {
      reconcileProfile,
      cancelProfile: vi.fn().mockResolvedValue(undefined),
    };
    await reconcileCalendarReminders(scheduler, 'mobile-profile', [item]);
    expect(reconcileProfile).toHaveBeenCalledWith('mobile-profile', [
      expect.objectContaining({ profileId: 'mobile-profile', itemId: 'event-1' }),
    ]);
  });
});
