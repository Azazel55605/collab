import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsCalendarSection from './SettingsCalendarSection';

describe('SettingsCalendarSection', () => {
  it('handles date format and week start changes', () => {
    const setDateFormat = vi.fn();
    const setWeekStart = vi.fn();
    const setTimeFormat = vi.fn();
    const setDefaultTimeZone = vi.fn();

    render(
      <SettingsCalendarSection
        dateFormat="YYYY_MM_DD"
        setDateFormat={setDateFormat}
        weekStart={1}
        setWeekStart={setWeekStart}
        timeFormat="system"
        setTimeFormat={setTimeFormat}
        defaultTimeZone="Europe/Berlin"
        setDefaultTimeZone={setDefaultTimeZone}
        defaultDurationMinutes={60}
        setDefaultDurationMinutes={vi.fn()}
        workingHoursStart="08:00"
        setWorkingHoursStart={vi.fn()}
        workingHoursEnd="17:00"
        setWorkingHoursEnd={vi.fn()}
        defaultReminderMinutes={10}
        setDefaultReminderMinutes={vi.fn()}
        hideWeekends={false}
        setHideWeekends={vi.fn()}
        showDeclined
        setShowDeclined={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /04\/01\/2026/i }));
    expect(setDateFormat).toHaveBeenCalledWith('MM_DD_YYYY');

    fireEvent.click(screen.getByRole('button', { name: 'Sunday' }));
    expect(setWeekStart).toHaveBeenCalledWith(0);

    fireEvent.click(screen.getByRole('button', { name: '24 hour' }));
    expect(setTimeFormat).toHaveBeenCalledWith('24-hour');

    expect(screen.getByRole('combobox', { name: 'Default calendar time zone' }).textContent).toContain('Europe/Berlin');
  });
});
