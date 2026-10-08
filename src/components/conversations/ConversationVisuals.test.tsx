import { expect, it } from 'vitest';

import { listTime, nameHue } from './ConversationVisuals';

it('formats list times like Teams: clock today, then yesterday, weekday and date', () => {
  const now = new Date(2026, 9, 8, 12, 0).getTime();
  expect(listTime(new Date(2026, 9, 8, 9, 5).getTime(), now)).toMatch(/9.*05/);
  expect(listTime(new Date(2026, 9, 7, 23, 0).getTime(), now)).toBe('Yesterday');
  expect(listTime(new Date(2026, 9, 5, 10, 0).getTime(), now)).toBe(
    new Date(2026, 9, 5).toLocaleDateString([], { weekday: 'short' }),
  );
  expect(listTime(new Date(2026, 8, 1).getTime(), now)).toBe(
    new Date(2026, 8, 1).toLocaleDateString([], { day: 'numeric', month: 'short' }),
  );
});
it('keeps one avatar hue per name', () => {
  expect(nameHue('Manuel')).toBe(nameHue('Manuel'));
  expect(nameHue('Manuel')).toBeGreaterThanOrEqual(0);
  expect(nameHue('Manuel')).toBeLessThan(360);
});
