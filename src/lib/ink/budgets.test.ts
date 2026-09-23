import { describe, expect, it } from 'vitest';

import { inkBudgetMessage, inkBudgetScale } from './budgets';

describe('ink budget scale', () => {
  it('ignores an absent, malformed or shrinking scale', () => {
    expect(inkBudgetScale({})).toBe(1);
    expect(inkBudgetScale({ COLLAB_INK_BUDGET_SCALE: 'fast' })).toBe(1);
    expect(inkBudgetScale({ COLLAB_INK_BUDGET_SCALE: '0.5' })).toBe(1);
  });

  it('applies a scale and caps it', () => {
    expect(inkBudgetScale({ COLLAB_INK_BUDGET_SCALE: '4' })).toBe(4);
    expect(inkBudgetScale({ COLLAB_INK_BUDGET_SCALE: '500' })).toBe(20);
  });
});

describe('ink budget failure message', () => {
  it('names the budget, the measurement and the way out', () => {
    const message = inkBudgetMessage('tileRepaintMs', 12.7, {});

    // A bare "expected 12.7 to be less than 8" sends the reader looking for a
    // performance regression that may just be a busy machine.
    expect(message).toContain('tileRepaintMs');
    expect(message).toContain('12.7');
    expect(message).toContain('COLLAB_INK_BUDGET_SCALE');
  });

  it('reports the scale in effect so a scaled ceiling is not mistaken for the published one', () => {
    const message = inkBudgetMessage('tileRepaintMs', 40, { COLLAB_INK_BUDGET_SCALE: '4' });

    expect(message).toContain('32');
    expect(message).toContain('4');
  });
});
