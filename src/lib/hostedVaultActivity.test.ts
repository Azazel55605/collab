import { beforeEach, describe, expect, it } from 'vitest';

import {
  hostedVaultActivityKey,
  readHostedVaultLastOpened,
  recordHostedVaultOpened,
} from './hostedVaultActivity';

describe('hostedVaultActivity', () => {
  beforeEach(() => localStorage.clear());

  it('records and reads hosted vault open times', () => {
    recordHostedVaultOpened('https://a.test', 'v1', 100);
    recordHostedVaultOpened('https://a.test', 'v2', 200);
    recordHostedVaultOpened('https://a.test', 'v1', 300);

    expect(readHostedVaultLastOpened()).toEqual({
      [hostedVaultActivityKey('https://a.test', 'v1')]: 300,
      [hostedVaultActivityKey('https://a.test', 'v2')]: 200,
    });
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem('collab-hosted-vault-last-opened', '{not json');
    expect(readHostedVaultLastOpened()).toEqual({});
    localStorage.setItem('collab-hosted-vault-last-opened', JSON.stringify({ a: 'x', b: 5 }));
    expect(readHostedVaultLastOpened()).toEqual({ b: 5 });
  });

  it('keeps only the most recent entries', () => {
    for (let index = 0; index < 205; index += 1)
      recordHostedVaultOpened('https://a.test', `v${index}`, index);
    const entries = readHostedVaultLastOpened();
    expect(Object.keys(entries)).toHaveLength(200);
    expect(entries[hostedVaultActivityKey('https://a.test', 'v0')]).toBeUndefined();
    expect(entries[hostedVaultActivityKey('https://a.test', 'v204')]).toBe(204);
  });
});
