import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { clearMediaResources } from '../mediaLifecycle';
import type { VaultClient } from '../vaultClient';

import { deckMediaStats, useDeckMedia } from './mediaCache';

const asset: import('../../types/deck').DeckAssetRef = {
  path: 'first.png',
  mediaType: 'image/png',
  pixelWidth: 640,
  pixelHeight: 480,
};
beforeEach(() => clearMediaResources());
it('loads only demanded media, shares ownership across panes and retires removed/versioned entries', async () => {
  let resolve!: (data: string) => void;
  const read = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const client = { id: 'vault', readAssetDataUrl: read } as unknown as VaultClient;
  const one = renderHook(() => useDeckMedia(client)(asset));
  const two = renderHook(() => useDeckMedia(client)(asset));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  one.unmount();
  resolve('data:image/png;base64,AA==');
  await waitFor(() => expect(two.result.current).toContain('data:image/png'));
  expect(deckMediaStats().entries).toBe(1);
  two.unmount();
  expect(deckMediaStats().entries).toBe(0);
});
it('asks native for bounded presentation thumbnails and never warms unrelated slides', async () => {
  const png = new Uint8Array(24);
  const data = new DataView(png.buffer);
  data.setUint32(16, 640);
  data.setUint32(20, 480);
  const read = vi.fn(async () => png);
  const client = { id: 'native', readAssetBytes: read } as unknown as VaultClient;
  const hook = renderHook(({ file }) => useDeckMedia(client)(file), {
    initialProps: { file: asset },
  });
  await waitFor(() => expect(hook.result.current).toContain('data:image/png'));
  expect(read).toHaveBeenCalledExactlyOnceWith('first.png', expect.any(AbortSignal), true, 1920);
  hook.rerender({ file: { ...asset, path: 'replacement.png', sha256: 'new' } });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(deckMediaStats().entries).toBe(1);
  hook.unmount();
  expect(deckMediaStats().bytes).toBe(0);
});
