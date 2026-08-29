import { describe, expect, it } from 'vitest';

import { INK_UNITS_PER_PX } from '../../types/ink';

import {
  INK_DEFAULT_INPUT_SETTINGS,
  INK_PALM_CONTACT_PX,
  INK_PALM_WINDOW_MS,
  InkContactArbiter,
  isBarrelButton,
  isEraserEnd,
  pointerKind,
  readingFromEvent,
  readingsFromEvent,
  toInkUnits,
} from './pointer';
import type { InkPointerEventLike } from './pointer';

function event(overrides: Partial<InkPointerEventLike> = {}): InkPointerEventLike {
  return {
    pointerId: 1,
    pointerType: 'pen',
    isPrimary: true,
    buttons: 1,
    pressure: 0.5,
    offsetX: 0,
    offsetY: 0,
    timeStamp: 0,
    ...overrides,
  };
}

describe('toInkUnits', () => {
  it('maps surface pixels to document units at 100% zoom', () => {
    expect(toInkUnits({ offsetX: 10, offsetY: 20 }, { originX: 0, originY: 0, zoom: 1 })).toEqual({
      x: 10 * INK_UNITS_PER_PX,
      y: 20 * INK_UNITS_PER_PX,
    });
  });

  it('accounts for zoom and pan', () => {
    const point = toInkUnits(
      { offsetX: 100, offsetY: 0 },
      { originX: 5_000, originY: 1_000, zoom: 2 },
    );
    expect(point.x).toBe(5_000 + (100 * INK_UNITS_PER_PX) / 2);
    expect(point.y).toBe(1_000);
  });

  it('does not divide by zero at a degenerate zoom', () => {
    expect(
      Number.isFinite(
        toInkUnits({ offsetX: 1, offsetY: 1 }, { originX: 0, originY: 0, zoom: 0 }).x,
      ),
    ).toBe(true);
  });
});

describe('device flags', () => {
  it('recognizes the eraser end from either report', () => {
    // Platforms disagree on whether `buttons` or `button` is populated on the
    // initial pointerdown, so both are checked.
    expect(isEraserEnd(event({ buttons: 32 }))).toBe(true);
    expect(isEraserEnd(event({ buttons: 0, button: 5 }))).toBe(true);
    expect(isEraserEnd(event({ buttons: 1, button: 0 }))).toBe(false);
  });

  it('recognizes the barrel button', () => {
    expect(isBarrelButton(event({ buttons: 3 }))).toBe(true);
    expect(isBarrelButton(event({ buttons: 1 }))).toBe(false);
  });

  it('classifies pointer types, defaulting unknown ones to mouse', () => {
    expect(pointerKind(event({ pointerType: 'pen' }))).toBe('pen');
    expect(pointerKind(event({ pointerType: 'touch' }))).toBe('touch');
    expect(pointerKind(event({ pointerType: '' }))).toBe('mouse');
  });
});

describe('readingFromEvent', () => {
  const transform = { originX: 0, originY: 0, zoom: 1 };

  it('records pen pressure', () => {
    expect(readingFromEvent(event({ pressure: 0.75 }), transform, 0).pressure).toBe(0.75);
  });

  it('does not record mouse pressure as pressure', () => {
    // A mouse reports 0.5 while a button is down. That is a constant, not a
    // measurement, and storing it would make every mouse stroke look pressured.
    const reading = readingFromEvent(event({ pointerType: 'mouse', pressure: 0.5 }), transform, 0);
    expect(reading.pressure).toBeUndefined();
  });

  it('makes elapsed relative to the stroke, not the page', () => {
    // The time channel is delta-encoded; page-relative timestamps would make
    // the first value enormous for a stroke drawn late in a session.
    expect(readingFromEvent(event({ timeStamp: 60_000 }), transform, 59_000).elapsed).toBe(1_000);
  });

  it('omits tilt and twist a device does not report', () => {
    const reading = readingFromEvent(event(), transform, 0);
    expect(reading.tiltX).toBeUndefined();
    expect(reading.twist).toBeUndefined();
  });
});

describe('readingsFromEvent', () => {
  const transform = { originX: 0, originY: 0, zoom: 1 };

  it('expands coalesced events into one reading each', () => {
    // Without this the captured line is visibly polygonal at speed on exactly
    // the high-rate digitizers people buy for drawing.
    const readings = readingsFromEvent(event({ offsetX: 30 }), transform, 0, [
      event({ offsetX: 10 }),
      event({ offsetX: 20 }),
      event({ offsetX: 30 }),
    ]);
    expect(readings).toHaveLength(3);
    expect(readings.map((reading) => reading.x / INK_UNITS_PER_PX)).toEqual([10, 20, 30]);
  });

  it('falls back to the event itself when nothing was coalesced', () => {
    expect(readingsFromEvent(event({ offsetX: 7 }), transform, 0, [])).toHaveLength(1);
    expect(readingsFromEvent(event({ offsetX: 7 }), transform, 0)).toHaveLength(1);
  });
});

describe('InkContactArbiter', () => {
  it('draws with a pen and pans with a finger by default', () => {
    const arbiter = new InkContactArbiter();
    expect(arbiter.down(event({ pointerId: 1, pointerType: 'pen' }))).toBe('draw');
    expect(arbiter.down(event({ pointerId: 2, pointerType: 'touch', timeStamp: 60_000 }))).toBe(
      'reject',
    );

    const fresh = new InkContactArbiter();
    expect(fresh.down(event({ pointerId: 2, pointerType: 'touch' }))).toBe('navigate');
  });

  it('draws with a finger when finger drawing is on', () => {
    const arbiter = new InkContactArbiter({
      ...INK_DEFAULT_INPUT_SETTINGS,
      fingerDrawing: true,
    });
    expect(arbiter.down(event({ pointerId: 2, pointerType: 'touch' }))).toBe('draw');
  });

  it('erases with the inverted end of the pen', () => {
    const arbiter = new InkContactArbiter();
    expect(arbiter.down(event({ pointerType: 'pen', buttons: 32 }))).toBe('erase');
  });

  it('erases while the barrel button is held, when mapped to erase', () => {
    const arbiter = new InkContactArbiter();
    expect(arbiter.down(event({ pointerType: 'pen', buttons: 3 }))).toBe('erase');

    const lasso = new InkContactArbiter({
      ...INK_DEFAULT_INPUT_SETTINGS,
      barrelButton: 'lasso',
    });
    expect(lasso.down(event({ pointerType: 'pen', buttons: 3 }))).toBe('draw');
  });

  it('rejects touches while the pen is down', () => {
    const arbiter = new InkContactArbiter();
    arbiter.down(event({ pointerId: 1, pointerType: 'pen', timeStamp: 0 }));
    expect(arbiter.down(event({ pointerId: 2, pointerType: 'touch', timeStamp: 5 }))).toBe(
      'reject',
    );
  });

  it('retires a palm that landed before the pen did', () => {
    // The common case: the hand rests on the screen first and the nib arrives a
    // moment later. Rejecting only new touches would leave that contact panning
    // the canvas out from under the stroke.
    const arbiter = new InkContactArbiter();
    arbiter.down(event({ pointerId: 2, pointerType: 'touch', timeStamp: 0 }));
    expect(arbiter.roleOf(2)).toBe('navigate');

    arbiter.down(event({ pointerId: 1, pointerType: 'pen', timeStamp: 30 }));
    expect(arbiter.roleOf(2)).toBe('reject');
  });

  it('rejects a large contact area regardless of timing', () => {
    const arbiter = new InkContactArbiter();
    expect(
      arbiter.down(
        event({
          pointerId: 2,
          pointerType: 'touch',
          width: INK_PALM_CONTACT_PX + 1,
          timeStamp: 500_000,
        }),
      ),
    ).toBe('reject');
  });

  it('lets touch work again once the pen has been away long enough', () => {
    const arbiter = new InkContactArbiter();
    arbiter.down(event({ pointerId: 1, pointerType: 'pen', timeStamp: 0 }));
    arbiter.up(event({ pointerId: 1, pointerType: 'pen', timeStamp: 10 }));

    expect(arbiter.down(event({ pointerId: 2, pointerType: 'touch', timeStamp: 100 }))).toBe(
      'reject',
    );
    expect(
      arbiter.down(
        event({ pointerId: 3, pointerType: 'touch', timeStamp: 10 + INK_PALM_WINDOW_MS + 1 }),
      ),
    ).toBe('navigate');
  });

  it('honours palm rejection being switched off', () => {
    const arbiter = new InkContactArbiter({
      ...INK_DEFAULT_INPUT_SETTINGS,
      palmRejection: false,
    });
    arbiter.down(event({ pointerId: 1, pointerType: 'pen', timeStamp: 0 }));
    expect(arbiter.down(event({ pointerId: 2, pointerType: 'touch', timeStamp: 5 }))).toBe(
      'navigate',
    );
  });

  it('forgets a contact once it ends, however it ended', () => {
    // pointercancel and lost capture route here too. A contact left in the map
    // is a stuck stroke that never terminates.
    const arbiter = new InkContactArbiter();
    arbiter.down(event({ pointerId: 1 }));
    expect(arbiter.activeContacts).toBe(1);
    arbiter.up(event({ pointerId: 1 }));
    expect(arbiter.activeContacts).toBe(0);
  });

  it('drops everything on reset, for rotation and focus loss', () => {
    const arbiter = new InkContactArbiter();
    arbiter.down(event({ pointerId: 1, pointerType: 'pen' }));
    arbiter.down(event({ pointerId: 2, pointerType: 'touch' }));
    arbiter.reset();
    expect(arbiter.activeContacts).toBe(0);
    // And the pen is no longer considered down, so touch is usable immediately.
    expect(arbiter.down(event({ pointerId: 3, pointerType: 'touch', timeStamp: 10_000 }))).toBe(
      'navigate',
    );
  });

  it('reports a role of reject for a contact it never saw go down', () => {
    const arbiter = new InkContactArbiter();
    expect(arbiter.move(event({ pointerId: 99 }))).toBe('reject');
  });
});
