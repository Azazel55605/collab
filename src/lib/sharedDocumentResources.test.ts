import { expect, it, vi } from 'vitest';

import { DocumentSessionController } from './documentSessionController';
import {
  clearDocumentReads,
  DocumentResourcePool,
  shareAbortableDocumentRead,
  shareDocumentRead,
} from './sharedDocumentResources';

it('deduplicates pending reads, scopes identities and drops failures and settled results', async () => {
  clearDocumentReads();
  let resolve!: (value: string) => void;
  const read = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const first = shareDocumentRead('vault/a', read);
  const second = shareDocumentRead('vault/a', read);
  expect(second).toBe(first);
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(1);
  resolve('value');
  await first;
  expect(await shareDocumentRead('vault/a', async () => 'new')).toBe('new');
  await expect(
    shareDocumentRead('vault/a', async () => {
      throw new Error('denied');
    }),
  ).rejects.toThrow('denied');
  expect(await shareDocumentRead('other-vault/a', async () => 'other')).toBe('other');
  expect(await shareDocumentRead('vault/a', async () => 'recovered')).toBe('recovered');
});
it('releases a shared resource only after its final pane and retires late opens on logout', async () => {
  const pool = new DocumentResourcePool<{ destroy(): void }>();
  const resource = { destroy: vi.fn() };
  const create = vi.fn(async () => resource);
  const [a, b] = await Promise.all([pool.acquire('same', create), pool.acquire('same', create)]);
  expect(create).toHaveBeenCalledTimes(1);
  a!.release();
  a!.release();
  expect(resource.destroy).not.toHaveBeenCalled();
  b!.release();
  expect(resource.destroy).toHaveBeenCalledTimes(1);
  let finish!: (value: typeof resource) => void;
  const late = pool.acquire(
    'late',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  pool.clear();
  finish(resource);
  expect(await late).toBeNull();
  expect(resource.destroy).toHaveBeenCalledTimes(2);
});

it('keeps independent REST pane drafts and rejects a stale optimistic writer after shared loading', async () => {
  let body = 'base',
    version = '1';
  const read = vi.fn(async () => ({ body, version }));
  const write = vi.fn(
    async ({ content, expectedVersion }: { content: string; expectedVersion: string | null }) => {
      if (expectedVersion !== version)
        return {
          version: expectedVersion ?? '',
          conflict: { theirContent: body, theirVersion: version },
        };
      body = content;
      version = '2';
      return { version };
    },
  );
  const make = () =>
    new DocumentSessionController<string>({
      serialize: (s) => s,
      deserialize: (s) => s,
      applyDocument: () => {},
      write,
      schedule: () => () => {},
    });
  const left = make(),
    right = make();
  const [a, b] = await Promise.all([
    shareDocumentRead('same-rest-file', read),
    shareDocumentRead('same-rest-file', read),
  ]);
  expect(read).toHaveBeenCalledTimes(1);
  left.load(a.body, a.version);
  right.load(b.body, b.version);
  left.markLocalChange('left draft');
  right.markLocalChange('right draft');
  await left.requestSave();
  await right.requestSave();
  expect(body).toBe('left draft');
  expect(right.getSnapshot()).toMatchObject({ currentContent: 'right draft', conflicted: true });
  expect(right.getSnapshot().conflict).toMatchObject({
    ourContent: 'right draft',
    theirContent: 'left draft',
    theirVersion: '2',
  });
  left.dispose();
  right.dispose();
});

it('retires lookup identity without destroying a mounted sibling and never reuses it for a new session', async () => {
  const pool = new DocumentResourcePool<{ destroy(): void }>();
  const old = { destroy: vi.fn() },
    next = { destroy: vi.fn() };
  const a = await pool.acquire('file', async () => old);
  const b = await pool.acquire('file', async () => old);
  pool.clear();
  expect(old.destroy).not.toHaveBeenCalled();
  const fresh = await pool.acquire('file', async () => next);
  expect(fresh!.resource).toBe(next);
  a!.release();
  expect(old.destroy).not.toHaveBeenCalled();
  b!.release();
  expect(old.destroy).toHaveBeenCalledTimes(1);
  expect(next.destroy).not.toHaveBeenCalled();
  fresh!.release();
});

it('keeps a shared abortable read alive while another caller still wants it', async () => {
  let release!: (value: string) => void;
  const read = vi.fn(
    (signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
      }),
  );
  const first = new AbortController();
  const second = new AbortController();
  const firstRead = shareAbortableDocumentRead('asset', first.signal, read);
  const secondRead = shareAbortableDocumentRead('asset', second.signal, read);
  // A remount aborts the first load; the second one must not inherit that.
  first.abort();
  await expect(firstRead).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  release('bytes');
  await expect(secondRead).resolves.toBe('bytes');
  expect(read).toHaveBeenCalledTimes(1);
});

it('cancels the shared read once every caller aborted, and starts fresh afterwards', async () => {
  const signals: AbortSignal[] = [];
  const read = vi.fn(
    (signal: AbortSignal) =>
      new Promise<string>((resolve) => {
        signals.push(signal);
        setTimeout(() => resolve('late'), 0);
      }),
  );
  const first = new AbortController();
  const second = new AbortController();
  const a = shareAbortableDocumentRead('asset-2', first.signal, read);
  const b = shareAbortableDocumentRead('asset-2', second.signal, read);
  first.abort();
  second.abort();
  await expect(a).rejects.toMatchObject({ name: 'AbortError' });
  await expect(b).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  expect(signals[0]?.aborted).toBe(true);
  await expect(shareAbortableDocumentRead('asset-2', undefined, read)).resolves.toBe('late');
  expect(read).toHaveBeenCalledTimes(2);
});
