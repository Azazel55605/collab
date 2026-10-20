/** A revision-keyed cache with a shared reader budget, including obsolete passes.
 * Rejected reads are not cached, so a later revision/pass can recover. */
export class RevisionReader<T> {
  private values = new Map<string, { revision: string; promise: Promise<T> }>();
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly limit = 3) {}
  prune(paths: Set<string>) {
    for (const path of this.values.keys()) if (!paths.has(path)) this.values.delete(path);
  }
  read(path: string, revision: string, load: () => Promise<T>): Promise<T> {
    const cached = this.values.get(path);
    if (cached?.revision === revision) return cached.promise;
    const entry: { revision: string; promise: Promise<T> } = {
      revision,
      promise: Promise.resolve(null as T),
    };
    entry.promise = (async () => {
      // Let this entry publish before checking cancellation. A newer revision
      // waits for the preceding read of this path, so IPC in-flight sharing
      // cannot label an older response as the new revision.
      await cached?.promise.catch(() => {});
      const queued = this.active >= this.limit;
      if (queued) await new Promise<void>((resolve) => this.waiting.push(resolve));
      else this.active++;
      try {
        if (this.values.get(path) !== entry) throw new Error('Read superseded');
        return await load();
      } finally {
        const next = this.waiting.shift();
        if (next) next();
        else this.active--;
      }
    })().catch((error) => {
      if (this.values.get(path) === entry) this.values.delete(path);
      throw error;
    });
    this.values.set(path, entry);
    return entry.promise;
  }
}
