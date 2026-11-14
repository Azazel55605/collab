import { describe, expect, it } from 'vitest';

import { vaultManagerTabIds } from './VaultManagerModal';

describe('vaultManagerTabIds', () => {
  it('hides permission management for local vaults', () => {
    expect(vaultManagerTabIds('local')).toEqual(['overview', 'encryption']);
  });

  it('reserves permission management for hosted vaults', () => {
    expect(vaultManagerTabIds('hosted')).toEqual(['overview', 'permissions', 'offline']);
  });
});
