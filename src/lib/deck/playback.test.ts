import { describe, expect, it } from 'vitest';

import { buildFixtureDeck } from './fixture';
import { handoutGrid, parseSlideRange } from './output';
import {
  eraseStrokes,
  extendStroke,
  formatElapsed,
  initialPlayback,
  inkAnnotationSvg,
  nextIndex,
  playbackKeyCommand,
  playbackProgress,
  playbackReducer,
  previousIndex,
  swipeCommand,
  timerElapsed,
  toggleTimer,
} from './playback';
import type {
  PlaybackAction,
  PlaybackSlide,
  PlaybackState,
  PlaybackStroke,
  PlaybackTimer,
} from './playback';
import { resolveSlide } from './resolve';
import { linkAt, slideTextRuns } from './textLayer';
import { createApproximateMeasurer } from './textLayout';

const slides: PlaybackSlide[] = [
  { id: 'a', hidden: false },
  { id: 'b', hidden: true },
  { id: 'c', hidden: false },
  { id: 'd', hidden: false },
];

function run(state: PlaybackState, ...actions: PlaybackAction[]): PlaybackState {
  return actions.reduce((current, action) => playbackReducer(slides, current, action), state);
}

describe('playback navigation', () => {
  it('skips hidden slides forwards and backwards, and ends after the last', () => {
    expect(nextIndex(slides, 0)).toBe(2);
    expect(previousIndex(slides, 2)).toBe(0);
    let state = run(initialPlayback(slides), { type: 'next' });
    expect(state.index).toBe(2);
    state = run(state, { type: 'next' }, { type: 'next' });
    expect(state).toMatchObject({ index: 3, ended: true });
    // Once ended, "next" stays; "previous" leaves the end screen first.
    expect(run(state, { type: 'next' })).toEqual(state);
    expect(run(state, { type: 'previous' })).toMatchObject({ index: 3, ended: false });
  });

  it('reaches a hidden slide by number and counts progress without hidden slides', () => {
    const state = run(
      initialPlayback(slides),
      { type: 'digit', digit: '2' },
      { type: 'commitNumber' },
    );
    expect(state).toMatchObject({ index: 1, pendingNumber: '' });
    expect(playbackProgress(slides, 1)).toEqual({ position: 2, total: 4 });
    expect(playbackProgress(slides, 2)).toEqual({ position: 2, total: 3 });
    expect(
      run(initialPlayback(slides), { type: 'digit', digit: '9' }, { type: 'commitNumber' }).index,
    ).toBe(0);
  });

  it('blanks without moving, and the next input unblanks first', () => {
    let state = run(initialPlayback(slides), { type: 'blank', blank: 'black' });
    expect(state).toMatchObject({ index: 0, blank: 'black' });
    state = run(state, { type: 'next' });
    expect(state).toMatchObject({ index: 0, blank: null });
    state = run(state, { type: 'blank', blank: 'white' }, { type: 'blank', blank: 'white' });
    expect(state.blank).toBeNull();
    expect(run(initialPlayback(slides, 3), { type: 'first' }).index).toBe(0);
    expect(run(initialPlayback(slides), { type: 'last' }).index).toBe(3);
  });

  it('maps keys like PowerPoint and ignores the rest', () => {
    expect(playbackKeyCommand('ArrowRight')).toEqual({ type: 'next' });
    expect(playbackKeyCommand(' ')).toEqual({ type: 'next' });
    expect(playbackKeyCommand('PageUp')).toEqual({ type: 'previous' });
    expect(playbackKeyCommand('b')).toEqual({ type: 'blank', blank: 'black' });
    expect(playbackKeyCommand(',')).toEqual({ type: 'blank', blank: 'white' });
    expect(playbackKeyCommand('5')).toEqual({ type: 'digit', digit: '5' });
    expect(playbackKeyCommand('Enter', {}, { pendingNumber: '5' })).toEqual({
      type: 'commitNumber',
    });
    expect(playbackKeyCommand('Enter', {}, { pendingNumber: '' })).toEqual({ type: 'next' });
    expect(playbackKeyCommand('p', { ctrl: true })).toEqual({ type: 'tool', tool: 'pen' });
    expect(playbackKeyCommand('Escape')).toEqual({ type: 'exit' });
    expect(playbackKeyCommand('q')).toBeNull();
    expect(playbackKeyCommand('r', { alt: true })).toBeNull();
  });

  it('turns horizontal swipes into navigation', () => {
    expect(swipeCommand(-120, 10)).toEqual({ type: 'next' });
    expect(swipeCommand(120, 10)).toEqual({ type: 'previous' });
    expect(swipeCommand(30, 0)).toBeNull();
    expect(swipeCommand(80, 90)).toBeNull();
  });

  it('keeps a pausable timer', () => {
    let timer: PlaybackTimer = { elapsed: 0, runningSince: 1_000 };
    expect(timerElapsed(timer, 4_000)).toBe(3_000);
    timer = toggleTimer(timer, 4_000);
    expect(timer).toEqual({ elapsed: 3_000, runningSince: null });
    expect(timerElapsed(timer, 9_000)).toBe(3_000);
    expect(formatElapsed(65_400)).toBe('1:05');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
  });
});

describe('temporary ink', () => {
  const stroke: PlaybackStroke = { tool: 'pen', color: '#ef4444', width: 300, points: [[0, 0]] };

  it('thins points and erases whole strokes near a point', () => {
    let next = extendStroke(stroke, [10, 0], 50);
    expect(next.points).toHaveLength(1);
    next = extendStroke(next, [1_000, 0], 50);
    expect(next.points).toHaveLength(2);
    const other: PlaybackStroke = {
      ...stroke,
      points: [
        [0, 5_000],
        [1_000, 5_000],
      ],
    };
    expect(eraseStrokes([next, other], [500, 100], 50)).toEqual([other]);
  });

  it('draws ink as a transparent slide-sized SVG with safe colours', () => {
    const svg = inkAnnotationSvg(
      [
        {
          ...stroke,
          color: 'url(javascript:x)',
          points: [
            [0, 0],
            [100, 100],
          ],
        },
      ],
      96_000,
      54_000,
      1_280,
      720,
    );
    expect(svg).toContain('viewBox="0 0 96000 54000"');
    expect(svg).toContain('stroke="#ef4444"');
    expect(svg).not.toContain('javascript');
  });
});

describe('output layout', () => {
  it('parses slide ranges', () => {
    expect(parseSlideRange('1-3, 5, 3', 8)).toEqual([1, 2, 3, 5]);
    expect(parseSlideRange('7-', 8)).toEqual([7, 8]);
    expect(() => parseSlideRange('0', 8)).toThrow(/outside/);
    expect(() => parseSlideRange('abc', 8)).toThrow(/not a slide/);
    expect(() => parseSlideRange('  ', 8)).toThrow();
  });

  it('lays handout pages out inside the margins, slides at their aspect ratio', () => {
    for (const slidesPerPage of [1, 2, 3, 4, 6, 9] as const) {
      for (const notes of [false, true]) {
        for (const orientation of ['portrait', 'landscape'] as const) {
          const grid = handoutGrid({ paper: 'letter', orientation, slidesPerPage, notes }, 16 / 9);
          expect(grid.cells).toHaveLength(slidesPerPage);
          for (const cell of grid.cells) {
            expect(cell.slide.width / cell.slide.height).toBeCloseTo(16 / 9, 5);
            expect(cell.slide.x).toBeGreaterThanOrEqual(35.9);
            expect(cell.slide.x + cell.slide.width).toBeLessThanOrEqual(grid.width - 35.9);
            expect(cell.slide.y + cell.slide.height).toBeLessThanOrEqual(grid.height - 35.9);
            expect(Boolean(cell.notes)).toBe(notes);
          }
        }
      }
    }
    expect(
      handoutGrid({ paper: 'a4', orientation: 'landscape', slidesPerPage: 2, notes: false }, 1.5)
        .width,
    ).toBeCloseTo(841.89);
  });
});

describe('text layer', () => {
  it('places runs where the slide draws them and finds links under a point', () => {
    const deck = buildFixtureDeck();
    const measurer = createApproximateMeasurer();
    const slide = resolveSlide(deck, deck.slideOrder[0]);
    const runs = slideTextRuns(slide, measurer);
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      const x = run.matrix[4] + run.x;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(slide.width);
    }
    const linked = { ...runs[0], link: { kind: 'url' as const, href: 'https://example.com' } };
    const cx = linked.matrix[4] + linked.x + linked.width / 2;
    const cy = linked.matrix[5] + linked.top + linked.height / 2;
    expect(linkAt([linked], cx, cy)).toEqual(linked.link);
    expect(linkAt([linked], cx, cy + linked.height * 4)).toBeNull();
  });
});
