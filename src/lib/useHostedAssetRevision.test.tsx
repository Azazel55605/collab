import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import type { HostedVaultMeta } from '../types/vault';

import { useHostedAssetRevision } from './useHostedAssetRevision';
import { emitReplicaMutated } from './vaultReplica';

const api = vi.hoisted(() => ({ manifest: vi.fn() }));
vi.mock('./tauri', () => ({ tauriCommands: { replicaReadManifest: api.manifest } }));
it('ignores unchanged/other-file notifications and defers new bytes while annotations are dirty', async () => {
  const vault = {
    kind: 'hosted',
    serverUrl: 'https://server.test',
    hostedVaultId: 'v',
    path: 'hosted://v',
  } as HostedVaultMeta;
  const manifest = (hash: string) => ({
    files: [{ id: 'a', relativePath: 'a.pdf', currentRevision: { contentHash: hash } }],
  });
  api.manifest.mockResolvedValue(manifest('old'));
  const hook = renderHook(({ safe }) => useHostedAssetRevision(vault, 'a.pdf', safe), {
    initialProps: { safe: true },
  });
  await act(async () => {});
  expect(hook.result.current).toBe(0);
  await act(async () => emitReplicaMutated({ kind: 'manifest', relativePaths: ['a.pdf'] }));
  expect(hook.result.current).toBe(0);
  hook.rerender({ safe: false });
  api.manifest.mockResolvedValue(manifest('new'));
  await act(async () => emitReplicaMutated({ kind: 'manifest', relativePaths: ['other.pdf'] }));
  expect(hook.result.current).toBe(0);
  await act(async () => emitReplicaMutated({ kind: 'manifest', relativePaths: ['a.pdf'] }));
  expect(hook.result.current).toBe(0);
  hook.rerender({ safe: true });
  await waitFor(() => expect(hook.result.current).toBe(1));
  hook.unmount();
});
