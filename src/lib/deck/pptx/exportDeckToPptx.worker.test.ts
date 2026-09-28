// @vitest-environment node
/**
 * Worker feasibility: export must not need a DOM. This runs in plain Node,
 * where `document` and `window` do not exist, as in a Web Worker.
 */
import { describe, expect, it } from 'vitest';

import { buildFixtureDeck } from '../fixture';

import { exportDeckToPptx } from './exportDeckToPptx';

describe('exportDeckToPptx without a DOM', () => {
  it('exports the fixture with no document or window', async () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
    const result = await exportDeckToPptx(buildFixtureDeck());
    expect(result.bytes.byteLength).toBeGreaterThan(10_000);
    expect(result.report.slides).toBe(5);
  }, 30_000);
});
