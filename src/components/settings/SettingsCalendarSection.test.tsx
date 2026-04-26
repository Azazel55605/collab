import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SettingsCalendarSection from './SettingsCalendarSection';

describe('SettingsCalendarSection', () => {
  it('handles date format and week start changes', () => {
    const setDateFormat = vi.fn();
    const setWeekStart = vi.fn();

    render(
      <SettingsCalendarSection
        dateFormat="YYYY_MM_DD"
        setDateFormat={setDateFormat}
        weekStart={1}
        setWeekStart={setWeekStart}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /04\/01\/2026/i }));
    expect(setDateFormat).toHaveBeenCalledWith('MM_DD_YYYY');

    fireEvent.click(screen.getByRole('button', { name: 'Sunday' }));
    expect(setWeekStart).toHaveBeenCalledWith(0);
  });
});
