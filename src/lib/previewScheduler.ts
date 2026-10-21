import { registerMediaCleanup } from './mediaLifecycle';

export type PreviewPriority = 'visible' | 'background';
interface Job<T> {
  key: string;
  work(signal: AbortSignal): Promise<T>;
  controller: AbortController;
  consumers: Set<{ resolve(value: T): void; reject(error: unknown): void; detach(): void }>;
  priority: PreviewPriority;
  order: number;
  running: boolean;
}
export const previewCancelled = () => new DOMException('Preview cancelled', 'AbortError');
/** One admission owner; consumer cancellation never cancels another pane's lease. */
export class PreviewScheduler {
  private jobs = new Map<string, Job<unknown>>();
  private active = 0;
  private order = 0;
  private visibleStreak = 0;
  constructor(
    private limit = 4,
    private capacity = 256,
  ) {}
  run<T>(
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal; priority?: PreviewPriority } = {},
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(previewCancelled());
    let job = this.jobs.get(key) as Job<T> | undefined;
    if (!job) {
      if (this.jobs.size >= this.capacity)
        return Promise.reject(new Error('Preview queue is full. Try again shortly.'));
      job = {
        key,
        work,
        controller: new AbortController(),
        consumers: new Set(),
        priority: options.priority ?? 'visible',
        order: this.order++,
        running: false,
      };
      this.jobs.set(key, job as Job<unknown>);
    } else if (options.priority !== 'background') job.priority = 'visible';
    const owner = job;
    const promise = new Promise<T>((resolve, reject) => {
      const cancel = () => {
        owner.consumers.delete(consumer);
        consumer.detach();
        reject(previewCancelled());
        if (!owner.consumers.size) {
          owner.controller.abort();
          if (this.jobs.get(key) === (owner as Job<unknown>)) this.jobs.delete(key);
        }
        this.drain();
      };
      const consumer = {
        resolve,
        reject,
        detach: () => options.signal?.removeEventListener('abort', cancel),
      };
      owner.consumers.add(consumer);
      options.signal?.addEventListener('abort', cancel, { once: true });
    });
    this.drain();
    return promise;
  }
  clear() {
    for (const job of this.jobs.values()) {
      job.controller.abort();
      for (const consumer of job.consumers) {
        consumer.detach();
        consumer.reject(previewCancelled());
      }
      job.consumers.clear();
    }
    this.jobs.clear();
  }
  has(key: string) {
    return this.jobs.has(key);
  }
  isCurrent(key: string, signal: AbortSignal) {
    return this.jobs.get(key)?.controller.signal === signal;
  }
  stats() {
    return { active: this.active, jobs: this.jobs.size };
  }
  private drain() {
    while (this.active < this.limit) {
      const pending = [...this.jobs.values()].filter((job) => !job.running && job.consumers.size);
      if (!pending.length) return;
      const backgroundTurn =
        this.visibleStreak >= 4 && pending.some((job) => job.priority === 'background');
      pending.sort(
        (a, b) =>
          Number(backgroundTurn ? a.priority !== 'background' : a.priority !== 'visible') -
            Number(backgroundTurn ? b.priority !== 'background' : b.priority !== 'visible') ||
          a.order - b.order,
      );
      const job = pending[0];
      this.visibleStreak = job.priority === 'background' ? 0 : this.visibleStreak + 1;
      job.running = true;
      this.active++;
      const finish = (error: unknown, result?: unknown) => {
        // Delete/settle before notifying: a consumer can immediately request the
        // same key again from its promise continuation.
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        this.active--;
        const consumers = [...job.consumers];
        job.consumers.clear();
        for (const consumer of consumers) {
          consumer.detach();
          if (error) consumer.reject(error);
          else consumer.resolve(result);
        }
        this.drain();
      };
      void Promise.resolve()
        .then(() => {
          if (job.controller.signal.aborted) throw previewCancelled();
          return job.work(job.controller.signal);
        })
        .then(
          (result) => finish(null, result),
          (error) => finish(error),
        );
    }
  }
}
export const previewScheduler = new PreviewScheduler();

registerMediaCleanup(() => previewScheduler.clear());
