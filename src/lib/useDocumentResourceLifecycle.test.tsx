import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { useDocumentResourceLifecycle } from './useDocumentResourceLifecycle';

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
vi.mock('./documentSessionRetention', () => ({
  documentSessionRetention: { clear: mocks.context },
}));
vi.mock('./sharedDocumentResources', () => ({ clearDocumentReads: () => {} }));
afterEach(() => {
  cleanup();
  mocks.vault = { vault: null, isVaultLocked: false };
  mocks.server = undefined;
});

it('purges retained resources on lock, logout, account and membership changes but not unrelated notifications', () => {
  renderHook(useDocumentResourceLifecycle);
  const initial = mocks.context.mock.calls.length;
  act(() => {
    mocks.onVault!();
    mocks.onServer!();
  });
  expect(mocks.context).toHaveBeenCalledTimes(initial);
  act(() => {
    mocks.vault.vault = { path: '/private', isEncrypted: true };
    mocks.onVault!();
  });
  expect(mocks.context).toHaveBeenCalledTimes(initial + 1);
  act(() => {
    mocks.vault.isVaultLocked = true;
    mocks.onVault!();
  });
  expect(mocks.context).toHaveBeenCalledTimes(initial + 2);
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
  expect(mocks.context).toHaveBeenCalledTimes(initial + 3);
  act(() => {
    mocks.server!.status.user.id = 'b';
    mocks.onServer!();
  });
  expect(mocks.context).toHaveBeenCalledTimes(initial + 4);
  act(() => {
    mocks.server!.hostedVaults = [];
    mocks.onServer!();
  });
  expect(mocks.context).toHaveBeenCalledTimes(initial + 5);
  act(() => {
    mocks.server = undefined;
    mocks.onServer!();
  });
  expect(mocks.context).toHaveBeenCalledTimes(initial + 5);
});
