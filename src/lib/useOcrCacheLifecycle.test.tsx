import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { useOcrCacheLifecycle } from './useOcrCacheLifecycle';

const mocks = vi.hoisted(() => ({
  vault: { vault: null, isVaultLocked: false } as {
    vault: null | Record<string, unknown>;
    isVaultLocked: boolean;
  },
  server: undefined as
    | undefined
    | {
        status: { connected: boolean; user: { id: string; status: string } };
        hostedVaults: { id: string; status: string }[];
      },
  onVault: undefined as undefined | (() => void),
  onServer: undefined as undefined | (() => void),
  context: vi.fn(),
}));
vi.mock('../store/vaultStore', () => ({
  useVaultStore: {
    getState: () => mocks.vault,
    subscribe: (cb: () => void) => {
      mocks.onVault = cb;
      return () => {
        mocks.onVault = undefined;
      };
    },
  },
}));
vi.mock('../store/serverStore', () => ({
  useServerStore: {
    getState: () => ({ connectionFor: () => mocks.server }),
    subscribe: (cb: () => void) => {
      mocks.onServer = cb;
      return () => {
        mocks.onServer = undefined;
      };
    },
  },
}));
vi.mock('./ocrCache', () => ({ setOcrCacheContext: mocks.context }));
afterEach(() => {
  cleanup();
  mocks.vault = { vault: null, isVaultLocked: false };
  mocks.server = undefined;
});

it('clears on vault close, encrypted lock, account logout and membership revocation', () => {
  renderHook(useOcrCacheLifecycle);
  expect(mocks.context).toHaveBeenLastCalledWith(null);
  act(() => {
    mocks.vault.vault = { path: '/private', isEncrypted: true };
    mocks.onVault!();
  });
  expect(mocks.context).toHaveBeenLastCalledWith(JSON.stringify(['local', '/private']));
  act(() => {
    mocks.vault.isVaultLocked = true;
    mocks.onVault!();
  });
  expect(mocks.context).toHaveBeenLastCalledWith(null);
  act(() => {
    mocks.vault = {
      vault: { kind: 'hosted', serverUrl: 'https://server', hostedVaultId: 'v', role: 'editor' },
      isVaultLocked: false,
    };
    mocks.server = {
      status: { connected: true, user: { id: 'a', status: 'active' } },
      hostedVaults: [{ id: 'v', status: 'active' }],
    };
    mocks.onServer!();
  });
  expect(mocks.context.mock.lastCall![0]).toContain('"a"');
  act(() => {
    mocks.server!.hostedVaults = [];
    mocks.onServer!();
  });
  expect(mocks.context).toHaveBeenLastCalledWith(null);
  act(() => {
    mocks.server = undefined;
    mocks.onServer!();
  });
  expect(mocks.context).toHaveBeenLastCalledWith(null);
  act(() => {
    mocks.vault.vault = null;
    mocks.onVault!();
  });
  expect(mocks.context).toHaveBeenLastCalledWith(null);
});
