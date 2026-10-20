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
const clearers = new Set<() => void>();
export function registerDocumentResourceCleanup(clear: () => void) {
  clearers.add(clear);
}
export function clearDocumentReads() {
  reads.clear();
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
