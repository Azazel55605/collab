import { beforeEach, describe, expect, it } from 'vitest';

import {
  alwaysCreateOfflineCopy,
  setAlwaysCreateOfflineCopy,
  shouldAlwaysCreateOfflineCopy,
} from './preferences';
import { upsertKnownServer } from './servers';

describe('mobile hosted-vault preferences', () => {
  beforeEach(() => localStorage.clear());

  it('persists the always-offline preference locally', () => {
    expect(alwaysCreateOfflineCopy()).toBe(false);
    setAlwaysCreateOfflineCopy(true);
    expect(alwaysCreateOfflineCopy()).toBe(true);
    setAlwaysCreateOfflineCopy(false);
    expect(alwaysCreateOfflineCopy()).toBe(false);
  });

  it('allows a server to inherit, enable, or disable the global preference', () => {
    setAlwaysCreateOfflineCopy(true);
    upsertKnownServer({
      serverUrl: 'https://inherit.test',
      username: 'user',
      allowInvalidCertificates: false,
      persistAcrossReboots: true,
      offlineCopyMode: 'inherit',
    });
    upsertKnownServer({
      serverUrl: 'https://never.test',
      username: 'user',
      allowInvalidCertificates: false,
      persistAcrossReboots: true,
      offlineCopyMode: 'never',
    });
    upsertKnownServer({
      serverUrl: 'https://always.test',
      username: 'user',
      allowInvalidCertificates: false,
      persistAcrossReboots: true,
      offlineCopyMode: 'always',
    });

    expect(shouldAlwaysCreateOfflineCopy('https://inherit.test')).toBe(true);
    expect(shouldAlwaysCreateOfflineCopy('https://never.test')).toBe(false);
    setAlwaysCreateOfflineCopy(false);
    expect(shouldAlwaysCreateOfflineCopy('https://always.test')).toBe(true);
  });
});
