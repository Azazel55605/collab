import { describe, expect, it } from 'vitest';

import { isCommandBarToggleShortcut } from './useCommandBarShell';

describe('isCommandBarToggleShortcut', () => {
  it('accepts Ctrl+K and Ctrl+P without Alt', () => {
    expect(
      isCommandBarToggleShortcut({ ctrlKey: true, metaKey: false, altKey: false, key: 'k' }),
    ).toBe(true);
    expect(
      isCommandBarToggleShortcut({ ctrlKey: true, metaKey: false, altKey: false, key: 'p' }),
    ).toBe(true);
  });

  it('ignores Alt-modified editor shortcuts', () => {
    expect(
      isCommandBarToggleShortcut({ ctrlKey: true, metaKey: false, altKey: true, key: 'p' }),
    ).toBe(false);
  });
});
