import { expect, it, vi } from 'vitest';

import { tauriCommands } from './tauri';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class {} }));
it('passes binary IPC buffers without base64 JSON and forwards cancellation to native work', async () => {
  invoke.mockImplementation(async (command: string) =>
    command === 'read_vault_asset_bytes' ? new Uint8Array([0, 255, 17]).buffer : undefined,
  );
  const bytes = await tauriCommands.readVaultAssetBytes({
    kind: 'local',
    vaultPath: '/vault',
    relativePath: 'large.pdf',
  });
  expect([...bytes]).toEqual([0, 255, 17]);
  expect(invoke.mock.calls[0][1]).toMatchObject({
    thumbnailOnly: false,
    requestId: expect.any(String),
    source: { relativePath: 'large.pdf' },
  });
  let release!: (value: ArrayBuffer) => void;
  invoke.mockImplementation((command: string) =>
    command === 'read_vault_asset_bytes'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve(),
  );
  const abort = new AbortController();
  const pending = tauriCommands.readVaultAssetBytes(
    { kind: 'local', vaultPath: '/vault', relativePath: 'large.pdf' },
    false,
    abort.signal,
  );
  const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  abort.abort();
  release(new ArrayBuffer(0));
  await cancelled;
  expect(invoke.mock.calls.some((call) => call[0] === 'cancel_media_job')).toBe(true);
});
