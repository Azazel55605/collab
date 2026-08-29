import { beforeEach, describe, expect, it } from 'vitest';

import {
  knownServerFor,
  listKnownServers,
  normalizeHostedServerUrl,
  removeKnownServer,
  upsertKnownServer,
} from './hostedServers';

describe('hosted server registry', () => {
  beforeEach(() => localStorage.clear());

  it('normalizes server URLs to their origin', () => {
    expect(normalizeHostedServerUrl(' https://collab.example.test/admin/ ')).toBe(
      'https://collab.example.test',
    );
    expect(normalizeHostedServerUrl('http://localhost:8788/')).toBe('http://localhost:8788');
  });

  it('migrates and deduplicates equivalent saved server URLs', () => {
    localStorage.setItem(
      'collab-hosted-servers',
      JSON.stringify([
        {
          serverUrl: 'https://collab.example.test/',
          username: 'old',
          allowInvalidCertificates: false,
          persistAcrossReboots: false,
        },
        {
          serverUrl: 'https://collab.example.test/admin',
          username: 'alice',
          allowInvalidCertificates: true,
          persistAcrossReboots: true,
        },
      ]),
    );

    expect(listKnownServers()).toEqual([
      {
        serverUrl: 'https://collab.example.test',
        username: 'alice',
        allowInvalidCertificates: true,
        persistAcrossReboots: true,
      },
    ]);
    expect(knownServerFor('https://collab.example.test/settings/')).toMatchObject({
      username: 'alice',
    });
  });

  it('updates and removes entries using canonical URLs', () => {
    upsertKnownServer({
      serverUrl: 'https://collab.example.test/path',
      username: 'alice',
      allowInvalidCertificates: false,
      persistAcrossReboots: false,
    });

    expect(listKnownServers()[0]?.serverUrl).toBe('https://collab.example.test');
    removeKnownServer('https://collab.example.test/');
    expect(listKnownServers()).toEqual([]);
  });
});
