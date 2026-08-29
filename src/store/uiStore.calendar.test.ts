import { describe, expect, it } from 'vitest';

import { formatTime, isSupportedTimeZone, useUiStore } from './uiStore';

describe('calendar time formatting', () => {
  const morning = new Date(2026, 6, 22, 9, 5);
  const afternoon = new Date(2026, 6, 22, 15, 45);

  it('forces 24-hour output when selected', () => {
    expect(formatTime(morning, '24-hour')).toMatch(/09:05/);
    expect(formatTime(afternoon, '24-hour')).toMatch(/15:45/);
  });

  it('forces a day period for 12-hour output', () => {
    expect(formatTime(morning, '12-hour')).toMatch(/09:05.*AM/i);
    expect(formatTime(afternoon, '12-hour')).toMatch(/03:45.*PM/i);
  });

  it('persists only recognized default calendar time zones', () => {
    useUiStore.getState().setCalendarDefaultTimeZone('Europe/Berlin');
    expect(useUiStore.getState().calendarDefaultTimeZone).toBe('Europe/Berlin');

    useUiStore.getState().setCalendarDefaultTimeZone('not/a-zone');
    expect(useUiStore.getState().calendarDefaultTimeZone).toBe('Europe/Berlin');
    expect(isSupportedTimeZone('UTC')).toBe(true);
    expect(isSupportedTimeZone('not/a-zone')).toBe(false);
  });

  it('validates calendar defaults before updating them', () => {
    const state = useUiStore.getState();
    state.setCalendarDefaultDurationMinutes(90);
    state.setCalendarWorkingHoursStart('07:30');
    state.setCalendarWorkingHoursEnd('18:15');
    state.setCalendarDefaultReminderMinutes(45);
    state.setCalendarHideWeekends(true);
    state.setCalendarShowDeclined(false);

    expect(useUiStore.getState()).toMatchObject({
      calendarDefaultDurationMinutes: 90,
      calendarWorkingHoursStart: '07:30',
      calendarWorkingHoursEnd: '18:15',
      calendarDefaultReminderMinutes: 45,
      calendarHideWeekends: true,
      calendarShowDeclined: false,
    });

    state.setCalendarWorkingHoursStart('25:00');
    state.setCalendarDefaultReminderMinutes(-1);
    expect(useUiStore.getState().calendarWorkingHoursStart).toBe('07:30');
    expect(useUiStore.getState().calendarDefaultReminderMinutes).toBe(45);
  });
});
