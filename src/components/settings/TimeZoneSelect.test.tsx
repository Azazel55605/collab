import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import TimeZoneSelect, { supportedTimeZones } from './TimeZoneSelect';

describe('supportedTimeZones', () => {
  it('returns a sorted unique IANA list with UTC', () => {
    const zones = supportedTimeZones();
    expect(zones).toContain('UTC');
    expect(zones).toEqual([...new Set(zones)].sort());
    expect(zones.length).toBeGreaterThan(10);
  });

  it('searches and selects an IANA time zone', async () => {
    const onValueChange = vi.fn();
    render(<TimeZoneSelect value="Europe/Berlin" onValueChange={onValueChange} />);

    fireEvent.click(screen.getByRole('combobox', { name: 'Default calendar time zone' }));
    fireEvent.change(await screen.findByPlaceholderText('Search time zones...'), {
      target: { value: 'Tokyo' },
    });
    fireEvent.click(await screen.findByText('Asia/Tokyo'));

    expect(onValueChange).toHaveBeenCalledWith('Asia/Tokyo');
  });

  it('contains wheel scrolling inside its list viewport', async () => {
    const parentWheel = vi.fn();
    const { container } = render(<div onWheel={parentWheel}><TimeZoneSelect value="UTC" onValueChange={vi.fn()} /></div>);

    fireEvent.click(screen.getByRole('combobox', { name: 'Default calendar time zone' }));
    const list = document.querySelector<HTMLElement>('[data-slot="command-list"]');
    expect(list).not.toBeNull();
    expect(list?.className).toContain('overflow-y-scroll');
    fireEvent.wheel(list!, { deltaY: 120 });

    expect(parentWheel).not.toHaveBeenCalled();
    expect(container).toBeTruthy();
  });
});
