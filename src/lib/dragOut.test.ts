import { describe, expect, it } from 'vitest';

import { nativeVaultPath } from './dragOut';

describe('nativeVaultPath', () => {
  it('joins with a forward slash for POSIX vault roots', () => {
    expect(nativeVaultPath('/home/u/vault', 'Notes/a.md')).toBe('/home/u/vault/Notes/a.md');
  });

  it('trims trailing separators on the root', () => {
    expect(nativeVaultPath('/home/u/vault/', 'a.md')).toBe('/home/u/vault/a.md');
  });

  it('uses backslashes and converts the relative path for Windows roots', () => {
    expect(nativeVaultPath('C:\\Users\\u\\vault', 'Notes/a.md')).toBe(
      'C:\\Users\\u\\vault\\Notes\\a.md',
    );
  });
});
