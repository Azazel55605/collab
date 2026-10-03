import { describe, expect, it } from 'vitest';

import { DECK_ANIMATION_EFFECTS } from '../../types/deck';
import type { DeckAnimation } from '../../types/deck';

import { animationCss, animationTimeline, EMPHASIS_EFFECTS } from './animation';

const animation = (
  id: string,
  trigger: DeckAnimation['trigger'],
  durationMs = 300,
): DeckAnimation => ({
  id,
  elementId: `element-${id}`,
  effect: 'fade',
  phase: 'entrance',
  trigger,
  durationMs,
});

describe('deck animation timeline', () => {
  it('groups automatic, click, with-previous, and after-previous cues', () => {
    const timeline = animationTimeline([
      animation('automatic', 'afterPrevious', 100),
      animation('click', 'click', 200),
      { ...animation('together', 'withPrevious', 400), delayMs: 20 },
      { ...animation('after', 'afterPrevious', 50), delayMs: 30 },
      animation('click-2', 'click', 100),
    ]);

    expect(timeline.cues.map((cue) => [cue.step, cue.startMs])).toEqual([
      [0, 0],
      [1, 0],
      [1, 20],
      [1, 450],
      [2, 0],
    ]);
    expect(timeline.lastStep).toBe(2);
    expect(timeline.durationMs).toEqual([100, 500, 100]);
  });

  it('keeps future entrances hidden and resolves exit state without geometry edits', () => {
    const animations: DeckAnimation[] = [
      animation('in', 'click'),
      { ...animation('out', 'click'), phase: 'exit', effect: 'fly' },
    ];
    expect(animationCss(animations, 0)).toContain(
      '[data-element="element-in"]{opacity:0;visibility:hidden;}',
    );
    expect(animationCss(animations, 1)).toContain('deck-anim-fade-in');
    expect(animationCss(animations, 2, true)).toContain(
      '[data-element="element-out"]{opacity:0;visibility:hidden;}',
    );
  });

  it('maps the expanded PowerPoint-style effect vocabulary to playback keyframes', () => {
    const emphasis = new Set(EMPHASIS_EFFECTS.map(({ value }) => value));
    expect(DECK_ANIMATION_EFFECTS).toHaveLength(36);
    for (const effect of DECK_ANIMATION_EFFECTS) {
      const phase = emphasis.has(effect) ? 'emphasis' : 'entrance';
      expect(animationCss([{ ...animation('effect', 'click'), effect, phase }], 1)).toContain(
        'deck-anim-',
      );
    }
  });
});
