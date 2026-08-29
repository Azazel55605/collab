import { describe, expect, it } from 'vitest';

import { type HostedVaultMeta, isVaultReadOnly, type LocalVaultMeta, vaultCan } from './vault';

const localVault: LocalVaultMeta = {
  kind: 'local',
  id: 'local-1',
  name: 'Local',
  path: '/vault',
  lastOpened: 0,
  isEncrypted: false,
};

const hostedVault = (role: HostedVaultMeta['role']): HostedVaultMeta => ({
  kind: 'hosted',
  id: 'hosted-1',
  hostedVaultId: 'hosted-1',
  serverUrl: 'https://collab.example.test',
  role,
  name: 'Hosted',
  path: 'hosted://hosted-1',
  lastOpened: 0,
  isEncrypted: false,
});

describe('isVaultReadOnly', () => {
  it('is false for null and local vaults', () => {
    expect(isVaultReadOnly(null)).toBe(false);
    expect(isVaultReadOnly(undefined)).toBe(false);
    expect(isVaultReadOnly(localVault)).toBe(false);
    // Legacy local metadata without an explicit kind is treated as local/writable.
    expect(isVaultReadOnly({ ...localVault, kind: undefined })).toBe(false);
  });

  it('is true only for a hosted viewer', () => {
    expect(isVaultReadOnly(hostedVault('viewer'))).toBe(true);
    expect(isVaultReadOnly(hostedVault('editor'))).toBe(false);
    expect(isVaultReadOnly(hostedVault('admin'))).toBe(false);
  });
});

describe('vaultCan', () => {
  it('treats local vaults as fully capable', () => {
    expect(vaultCan(localVault, 'pdf.comment')).toBe(true);
    expect(vaultCan(localVault, 'pdf.annotate')).toBe(true);
    expect(vaultCan({ ...localVault, kind: undefined }, 'pdf.annotate')).toBe(true);
  });

  it('consults the hosted capability tokens', () => {
    const commenter = { ...hostedVault('viewer'), capabilities: ['vault.read', 'pdf.comment'] };
    expect(vaultCan(commenter, 'pdf.comment')).toBe(true);
    expect(vaultCan(commenter, 'pdf.annotate')).toBe(false);
    expect(vaultCan(commenter, 'vault.offlineCopy')).toBe(false);

    const annotator = {
      ...hostedVault('editor'),
      capabilities: ['pdf.comment', 'pdf.annotate', 'vault.offlineCopy'],
    };
    expect(vaultCan(annotator, 'pdf.annotate')).toBe(true);
    expect(vaultCan(annotator, 'vault.offlineCopy')).toBe(true);
  });

  it('fails closed when capabilities are absent or for null vaults', () => {
    expect(vaultCan(hostedVault('editor'), 'pdf.annotate')).toBe(false);
    expect(vaultCan(null, 'pdf.comment')).toBe(false);
    expect(vaultCan(undefined, 'pdf.comment')).toBe(false);
  });
});
