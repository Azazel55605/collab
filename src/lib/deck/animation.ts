import type { DeckAnimation } from '../../types/deck';

export interface DeckAnimationCue extends DeckAnimation {
  /** Zero runs when the slide opens; positive values consume one advance click. */
  step: number;
  /** Milliseconds from the beginning of this step. */
  startMs: number;
}

export interface DeckAnimationTimeline {
  cues: DeckAnimationCue[];
  /** The last click-driven step. Zero means that advancing should change slide. */
  lastStep: number;
  durationMs: number[];
}

/**
 * Compiles the stored linear list into bounded click steps. `withPrevious`
 * starts with the preceding cue; `afterPrevious` follows it in the same step.
 * Cues before the first explicit click are the automatic slide-entry step 0.
 */
export function animationTimeline(
  animations: readonly DeckAnimation[] = [],
): DeckAnimationTimeline {
  const cues: DeckAnimationCue[] = [];
  const durationMs = [0];
  let step = 0;
  let previousStart = 0;
  let previousEnd = 0;

  for (const animation of animations) {
    if (animation.trigger === 'click') step += 1;
    const delay = Math.max(0, animation.delayMs ?? 0);
    const startMs =
      animation.trigger === 'withPrevious'
        ? previousStart + delay
        : animation.trigger === 'afterPrevious'
          ? previousEnd + delay
          : delay;
    const end = startMs + Math.max(0, animation.durationMs);
    cues.push({ ...animation, step, startMs });
    durationMs[step] = Math.max(durationMs[step] ?? 0, end);
    previousStart = startMs;
    previousEnd = end;
  }

  return { cues, lastStep: step, durationMs };
}

function cssString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\n\r\f]/g, '');
}

function finalRule(animation: DeckAnimation): string {
  if (animation.phase === 'exit') return 'opacity:0;visibility:hidden;';
  return 'opacity:1;visibility:visible;';
}

function pendingRule(animation: DeckAnimation): string {
  return animation.phase === 'entrance' ? 'opacity:0;visibility:hidden;' : finalRule(animation);
}

function keyframes(animation: DeckAnimation): string {
  if (animation.phase === 'entrance') {
    switch (animation.effect) {
      case 'appear':
        return 'deck-anim-appear-in';
      case 'fade':
        return 'deck-anim-fade-in';
      case 'fly':
        return 'deck-anim-fly-in';
      case 'zoom':
        return 'deck-anim-zoom-in';
    }
  }
  if (animation.phase === 'exit') {
    switch (animation.effect) {
      case 'appear':
        return 'deck-anim-appear-out';
      case 'fade':
        return 'deck-anim-fade-out';
      case 'fly':
        return 'deck-anim-fly-out';
      case 'zoom':
        return 'deck-anim-zoom-out';
    }
  }
  switch (animation.effect) {
    case 'appear':
    case 'fade':
      return 'deck-anim-pulse';
    case 'fly':
      return 'deck-anim-motion';
    case 'zoom':
      return 'deck-anim-grow';
  }
}

/** CSS applied above the shared SVG renderer. It never changes stored geometry. */
export function animationCss(
  animations: readonly DeckAnimation[] | undefined,
  step: number,
  reducedMotion = false,
): string {
  const timeline = animationTimeline(animations);
  const rules: string[] = [];
  for (const cue of timeline.cues) {
    const selector = `.deck-playback-animation-scope [data-element="${cssString(cue.elementId)}"]`;
    if (cue.step > step) {
      rules.push(`${selector}{${pendingRule(cue)}}`);
      continue;
    }
    if (cue.step < step || reducedMotion) {
      rules.push(`${selector}{${finalRule(cue)}}`);
      continue;
    }
    const duration = Math.max(1, cue.durationMs);
    rules.push(
      `${selector}{visibility:visible;transform-box:fill-box;transform-origin:center;` +
        `animation:${keyframes(cue)} ${duration}ms ease ${cue.startMs}ms both;}`,
    );
  }
  return rules.join('');
}
