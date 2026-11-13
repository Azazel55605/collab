/** Share in-flight reads only; authoritative edits never get a stale settled read. */
const reads = new Map<string, Promise<unknown>>();
export function shareDocumentRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const existing = reads.get(key);
  if (existing) return existing as Promise<T>;
  const promise = Promise.resolve().then(read);
  reads.set(key, promise);
  const remove = () => {
    if (reads.get(key) === promise) reads.delete(key);
  };
  void promise.then(remove, remove);
  return promise;
}
interface AbortableRead {
  promise: Promise<unknown>;
  controller: AbortController;
  waiting: number;
}
const abortableReads = new Map<string, AbortableRead>();

function abortError() {
  return new DOMException('Cancelled', 'AbortError');
}

/**
 * Like {@link shareDocumentRead}, for reads that can be cancelled. Callers of the
 * same key share one request, but each keeps its own signal: a caller that aborts
 * stops waiting without failing the others, and the shared request is cancelled
 * only once nobody is waiting any more. An abandoned request is never handed to a
 * later caller.
 */
export function shareAbortableDocumentRead<T>(
  key: string,
  signal: AbortSignal | undefined,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError());
  let entry = abortableReads.get(key);
  if (!entry) {
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => read(controller.signal));
    const created: AbortableRead = { promise, controller, waiting: 0 };
    const remove = () => {
      if (abortableReads.get(key) === created) abortableReads.delete(key);
    };
    void promise.then(remove, remove);
    abortableReads.set(key, created);
    entry = created;
  }
  const shared = entry;
  shared.waiting += 1;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const leave = () => {
      if (done) return false;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      shared.waiting -= 1;
      return true;
    };
    const onAbort = () => {
      if (!leave()) return;
      reject(abortError());
      if (shared.waiting === 0) {
        if (abortableReads.get(key) === shared) abortableReads.delete(key);
        shared.controller.abort();
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    (shared.promise as Promise<T>).then(
      (value) => leave() && resolve(value),
      (error) => leave() && reject(error),
    );
  });
}
const clearers = new Set<() => void>();
export function registerDocumentResourceCleanup(clear: () => void) {
  clearers.add(clear);
}
export function clearDocumentReads() {
  reads.clear();
  abortableReads.clear();
  for (const clear of clearers) clear();
}

export class DocumentResourcePool<T extends { destroy(): void }> {
  private entries = new Map<
    string,
    { promise: Promise<T | null>; refs: number; retired: boolean }
  >();
  async acquire(key: string, create: () => Promise<T | null>) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { promise: Promise.resolve().then(create), refs: 0, retired: false };
      this.entries.set(key, entry);
    }
    const acquired = entry;
    acquired.refs++;
    let resource: T | null;
    try {
      resource = await acquired.promise;
    } catch (error) {
      acquired.refs--;
      if (this.entries.get(key) === acquired) this.entries.delete(key);
      throw error;
    }
    if (!resource || acquired.retired) {
      acquired.refs--;
      if (this.entries.get(key) === acquired) this.entries.delete(key);
      if (resource && acquired.refs === 0) resource.destroy();
      return null;
    }
    let released = false;
    return {
      resource,
      release: () => {
        if (released) return;
        released = true;
        acquired.refs--;
        if (acquired.refs === 0) {
          acquired.retired = true;
          if (this.entries.get(key) === acquired) this.entries.delete(key);
          resource.destroy();
        }
      },
    };
  }
  /** Retire lookup identities; mounted views retain their save/leave ownership. */
  clear() {
    for (const entry of this.entries.values()) entry.retired = true;
    // Pending acquisitions return null and destroy on their final completion.
    // Existing leases destroy only on final release, never under an active pane.
    this.entries.clear();
  }
}
