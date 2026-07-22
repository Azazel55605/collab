import { describe, expect, it } from 'vitest';
import { addMinutesToTime } from './time-picker';

describe('addMinutesToTime', () => {
  it('sets a normal one-hour default', () => {
    expect(addMinutesToTime('09:30', 60)).toEqual({ time: '10:30', dayOffset: 0 });
  });

  it('advances the date when crossing midnight', () => {
    expect(addMinutesToTime('23:30', 60)).toEqual({ time: '00:30', dayOffset: 1 });
  });
});
