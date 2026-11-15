import { expect, it } from 'vitest';

import { adjustCaptionTiming } from './mediaCaptionTiming';

it('adjusts captions from their original times and restores them after a reset', () => {
  const cue = { startTime: 0.5, endTime: 2 };
  const track = { cues: [cue] } as unknown as TextTrack;
  adjustCaptionTiming(track, -750);
  expect(cue).toEqual({ startTime: 0, endTime: 1.25 });
  adjustCaptionTiming(track, 250);
  expect(cue).toEqual({ startTime: 0.75, endTime: 2.25 });
  adjustCaptionTiming(track, 0);
  expect(cue).toEqual({ startTime: 0.5, endTime: 2 });
});
