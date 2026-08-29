import { describe, expect, it } from 'vitest';

import { canvasInsertItems } from './canvasInsertItems';

describe('canvasInsertItems', () => {
  it('includes core content and planning insert options', () => {
    expect(canvasInsertItems.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        'note',
        'file',
        'text',
        'web',
        'symbol',
        'process',
        'decision',
        'terminator',
        'junction',
        'milestone',
        'actor',
        'document',
        'swimlane',
        'group',
      ]),
    );
  });
});
