import type { DeckAnimation, DeckAnimationEffect } from '../../types/deck';

export const ENTRANCE_EXIT_EFFECTS: readonly {
  value: DeckAnimationEffect;
  label: string;
}[] = [
  { value: 'appear', label: 'Appear' },
  { value: 'fade', label: 'Fade' },
  { value: 'fly', label: 'Fly In / Out' },
  { value: 'float', label: 'Float In / Out' },
  { value: 'split', label: 'Split' },
  { value: 'wipe', label: 'Wipe' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'swivel', label: 'Swivel' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'blinds', label: 'Blinds' },
  { value: 'box', label: 'Box' },
  { value: 'checkerboard', label: 'Checkerboard' },
  { value: 'circle', label: 'Circle' },
  { value: 'crawl', label: 'Crawl In / Out' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'dissolve', label: 'Dissolve' },
  { value: 'growAndTurn', label: 'Grow & Turn' },
  { value: 'peek', label: 'Peek In / Out' },
  { value: 'randomBars', label: 'Random Bars' },
  { value: 'shape', label: 'Shape' },
  { value: 'spiral', label: 'Spiral In / Out' },
  { value: 'stretch', label: 'Stretch' },
  { value: 'strips', label: 'Strips' },
  { value: 'wheel', label: 'Wheel' },
];

export const EMPHASIS_EFFECTS: readonly { value: DeckAnimationEffect; label: string }[] = [
  { value: 'pulse', label: 'Pulse' },
  { value: 'spin', label: 'Spin' },
  { value: 'growShrink', label: 'Grow / Shrink' },
  { value: 'teeter', label: 'Teeter' },
  { value: 'transparency', label: 'Transparency' },
  { value: 'blink', label: 'Blink' },
  { value: 'colorPulse', label: 'Color Pulse' },
  { value: 'darken', label: 'Darken' },
  { value: 'desaturate', label: 'Desaturate' },
  { value: 'flicker', label: 'Flicker' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'wave', label: 'Wave' },
];

export function animationEffectsForPhase(
  phase: DeckAnimation['phase'],
): readonly { value: DeckAnimationEffect; label: string }[] {
  return phase === 'emphasis' ? EMPHASIS_EFFECTS : ENTRANCE_EXIT_EFFECTS;
}

export function animationEffectLabel(effect: DeckAnimationEffect): string {
  return [...ENTRANCE_EXIT_EFFECTS, ...EMPHASIS_EFFECTS].find((entry) => entry.value === effect)!
    .label;
}

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
      case 'float':
        return 'deck-anim-float-in';
      case 'split':
        return 'deck-anim-split-in';
      case 'wipe':
        return 'deck-anim-wipe-in';
      case 'zoom':
        return 'deck-anim-zoom-in';
      case 'swivel':
        return 'deck-anim-swivel-in';
      case 'bounce':
        return 'deck-anim-bounce-in';
      case 'blinds':
        return 'deck-anim-blinds-in';
      case 'box':
        return 'deck-anim-box-in';
      case 'checkerboard':
        return 'deck-anim-checkerboard-in';
      case 'circle':
      case 'shape':
        return 'deck-anim-circle-in';
      case 'crawl':
        return 'deck-anim-crawl-in';
      case 'diamond':
        return 'deck-anim-diamond-in';
      case 'dissolve':
        return 'deck-anim-dissolve-in';
      case 'growAndTurn':
        return 'deck-anim-grow-turn-in';
      case 'peek':
        return 'deck-anim-peek-in';
      case 'randomBars':
        return 'deck-anim-random-bars-in';
      case 'spiral':
        return 'deck-anim-spiral-in';
      case 'stretch':
        return 'deck-anim-stretch-in';
      case 'strips':
        return 'deck-anim-strips-in';
      case 'wheel':
        return 'deck-anim-wheel-in';
      default:
        return emphasisKeyframes(animation.effect);
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
      case 'float':
        return 'deck-anim-float-out';
      case 'split':
        return 'deck-anim-split-out';
      case 'wipe':
        return 'deck-anim-wipe-out';
      case 'zoom':
        return 'deck-anim-zoom-out';
      case 'swivel':
        return 'deck-anim-swivel-out';
      case 'bounce':
        return 'deck-anim-bounce-out';
      case 'blinds':
      case 'checkerboard':
      case 'dissolve':
      case 'randomBars':
      case 'strips':
        return 'deck-anim-fade-out';
      case 'box':
      case 'circle':
      case 'diamond':
      case 'shape':
      case 'stretch':
        return 'deck-anim-zoom-out';
      case 'crawl':
      case 'peek':
        return 'deck-anim-fly-out';
      case 'growAndTurn':
      case 'spiral':
      case 'wheel':
        return 'deck-anim-swivel-out';
      default:
        return 'deck-anim-fade-out';
    }
  }
  return emphasisKeyframes(animation.effect);
}

function emphasisKeyframes(effect: DeckAnimationEffect): string {
  switch (effect) {
    case 'appear':
    case 'fade':
    case 'pulse':
      return 'deck-anim-pulse';
    case 'fly':
    case 'float':
      return 'deck-anim-motion';
    case 'zoom':
    case 'growShrink':
      return 'deck-anim-grow';
    case 'spin':
      return 'deck-anim-spin';
    case 'teeter':
      return 'deck-anim-teeter';
    case 'transparency':
      return 'deck-anim-transparency';
    case 'split':
    case 'wipe':
      return 'deck-anim-wipe-emphasis';
    case 'swivel':
      return 'deck-anim-swivel-emphasis';
    case 'bounce':
      return 'deck-anim-bounce-emphasis';
    case 'blink':
      return 'deck-anim-blink';
    case 'colorPulse':
      return 'deck-anim-color-pulse';
    case 'darken':
      return 'deck-anim-darken';
    case 'desaturate':
      return 'deck-anim-desaturate';
    case 'flicker':
      return 'deck-anim-flicker';
    case 'lighten':
      return 'deck-anim-lighten';
    case 'wave':
      return 'deck-anim-wave';
    case 'blinds':
    case 'box':
    case 'checkerboard':
    case 'circle':
    case 'crawl':
    case 'diamond':
    case 'dissolve':
    case 'growAndTurn':
    case 'peek':
    case 'randomBars':
    case 'shape':
    case 'spiral':
    case 'stretch':
    case 'strips':
    case 'wheel':
      return 'deck-anim-pulse';
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
