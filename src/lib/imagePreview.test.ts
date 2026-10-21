import { expect, it, vi } from 'vitest';

import { getImagePreviewDataUrl } from './imagePreview';
import { clearMediaResources } from './mediaLifecycle';
import type { VaultClient } from './vaultClient';

it('requests a bounded native thumbnail and shares the completed revision until its lifecycle ends', async () => {
  clearMediaResources();
  const readAssetBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
  const client = { id: 'thumbnail-test', readAssetBytes } as unknown as VaultClient;
  const first = await getImagePreviewDataUrl(client, 'photo.jpg');
  expect(first).toMatch(/^data:image\/png;base64,/);
  expect(readAssetBytes.mock.calls[0]).toEqual(['photo.jpg', expect.any(AbortSignal), true]);
  await getImagePreviewDataUrl(client, 'photo.jpg');
  expect(readAssetBytes).toHaveBeenCalledOnce();
  clearMediaResources();
  await getImagePreviewDataUrl(client, 'photo.jpg');
  expect(readAssetBytes).toHaveBeenCalledTimes(2);
});
