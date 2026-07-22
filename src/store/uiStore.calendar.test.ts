import { describe, expect, it } from 'vitest';
import { formatTime } from './uiStore';

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
});
