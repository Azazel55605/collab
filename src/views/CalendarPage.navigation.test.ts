import { describe, expect, it } from 'vitest';

import { calendarHorizontalGestureDelta, calendarPeriodDayStep } from './CalendarPage';

describe('calendar horizontal gesture navigation', () => {
  it('accepts horizontal-dominant touchpad movement', () => {
    expect(calendarHorizontalGestureDelta({ deltaX: 48, deltaY: 6 })).toBe(48);
    expect(calendarHorizontalGestureDelta({ deltaX: -32, deltaY: 4 })).toBe(-32);
  });

  it('leaves vertical and ambiguous scrolling untouched', () => {
    expect(calendarHorizontalGestureDelta({ deltaX: 4, deltaY: 40 })).toBe(0);
    expect(calendarHorizontalGestureDelta({ deltaX: 20, deltaY: 19 })).toBe(0);
  });

  it('normalizes line-based wheel deltas', () => {
    expect(calendarHorizontalGestureDelta({ deltaX: 6, deltaY: 0, deltaMode: 1 })).toBe(96);
  });

  it('moves week by seven days and day or agenda by one day', () => {
    expect(calendarPeriodDayStep('week')).toBe(7);
    expect(calendarPeriodDayStep('day')).toBe(1);
    expect(calendarPeriodDayStep('agenda')).toBe(1);
  });
});
