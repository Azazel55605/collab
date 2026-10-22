import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { WebSocketYProvider } from './liveDocumentSession';

const mocks = vi.hoisted(() => ({
  read: vi.fn().mockResolvedValue([]),
  write: vi.fn().mockResolvedValue(undefined),
  append: vi.fn().mockResolvedValue(undefined),
  clear: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./tauri', () => ({
  tauriCommands: {
    replicaReadCrdtUpdates: mocks.read,
    replicaCacheCrdtState: mocks.write,
    replicaAppendCrdtUpdate: mocks.append,
    replicaClearCrdtState: mocks.clear,
  },
}));
const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.read.mockResolvedValue([]);
});
it('persists tiny deltas between durable leave checkpoints and restores their coherent bundle', async () => {
  vi.useFakeTimers();
  const provider = new WebSocketYProvider(
    { serverUrl: 'https://srv', vaultId: 'v', fileId: '00000000-0000-0000-0000-000000000001' },
    true,
  );
  await provider.hydrateFromReplica();
  provider.doc.getText('content').insert(0, 'x'.repeat(100000));
  await vi.advanceTimersByTimeAsync(800);
  expect(mocks.write).toHaveBeenCalledTimes(1);
  provider.doc.getText('content').insert(100000, 'y');
  await vi.advanceTimersByTimeAsync(800);
  expect(mocks.append).toHaveBeenCalledTimes(1);
  const delta = mocks.append.mock.calls[0][3] as string;
  expect(delta.length).toBeLessThan(200);
  const checkpoint = mocks.write.mock.calls[0][3] as string;
  mocks.read.mockResolvedValue([checkpoint, delta]);
  const restored = new WebSocketYProvider(
    { serverUrl: 'https://srv', vaultId: 'v', fileId: '00000000-0000-0000-0000-000000000002' },
    true,
  );
  await restored.hydrateFromReplica();
  expect(restored.doc.getText('content').toString()).toBe('x'.repeat(100000) + 'y');
  await provider.handle().flushOfflineState!();
  expect(mocks.write).toHaveBeenCalledTimes(2);
  const full = new Y.Doc();
  Y.applyUpdate(full, bytes(mocks.write.mock.calls[1][3]));
  expect(full.getText('content').toString()).toBe(restored.doc.getText('content').toString());
  provider.destroy();
  restored.destroy();
  full.destroy();
});
it('failed append recovers through a full checkpoint without acknowledging a failed write', async () => {
  vi.useFakeTimers();
  const provider = new WebSocketYProvider(
    { serverUrl: 'https://srv', vaultId: 'v', fileId: '00000000-0000-0000-0000-000000000003' },
    true,
  );
  provider.doc.getText('content').insert(0, 'first');
  await vi.advanceTimersByTimeAsync(800);
  mocks.append.mockRejectedValueOnce(new Error('journal full'));
  provider.doc.getText('content').insert(5, ' next');
  await vi.advanceTimersByTimeAsync(800);
  const restored = new Y.Doc();
  Y.applyUpdate(restored, bytes(mocks.write.mock.calls[mocks.write.mock.calls.length - 1][3]));
  expect(restored.getText('content').toString()).toBe('first next');
  provider.destroy();
  restored.destroy();
});

it('a single leave barrier also persists edits made while its checkpoint is pending', async () => {
  vi.useFakeTimers();
  const provider = new WebSocketYProvider(
    { serverUrl: 'https://srv', vaultId: 'v', fileId: '00000000-0000-0000-0000-000000000004' },
    true,
  );
  let release!: () => void;
  mocks.write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  provider.doc.getText('content').insert(0, 'first');
  let finished = false;
  const flush = provider.handle().flushOfflineState!().then(() => {
    finished = true;
  });
  await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1));
  provider.doc.getText('content').insert(5, ' latest');
  expect(finished).toBe(false);
  release();
  await flush;
  expect(mocks.write).toHaveBeenCalledTimes(2);
  const restored = new Y.Doc();
  Y.applyUpdate(restored, bytes(mocks.write.mock.calls[1][3]));
  expect(restored.getText('content').toString()).toBe('first latest');
  provider.destroy();
  restored.destroy();
});
