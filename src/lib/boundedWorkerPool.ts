/** Synchronous worker jobs are cancelled by termination, including stuck parsers. */
export class BoundedWorkerPool {
  private active = new Set<() => void>();
  private idle: Array<{ worker: Worker; timer: ReturnType<typeof setTimeout> }> = [];
  private queue: Array<() => void> = [];
  constructor(
    private createWorker: () => Worker,
    private concurrency = 2,
    private capacity = 24,
    private label = 'Math',
  ) {}
  run<T>(
    payload: unknown,
    signal?: AbortSignal,
    timeoutMs = 8000,
    transfer: Transferable[] = [],
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Cancelled', 'AbortError'));
        return;
      }
      if (this.queue.length + this.active.size >= this.capacity) {
        reject(new Error(`${this.label} queue is full. Try again shortly.`));
        return;
      }
      let worker: Worker | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const finish = (error?: unknown, value?: T) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (worker) {
          worker.onmessage = worker.onerror = worker.onmessageerror = null;
          if (error) worker.terminate();
          else {
            const reusable = worker;
            const timer = setTimeout(() => {
              this.idle = this.idle.filter((slot) => slot.worker !== reusable);
              reusable.terminate();
            }, 15000);
            this.idle.push({ worker: reusable, timer });
          }
        }
        this.active.delete(start);
        this.queue = this.queue.filter((job) => job !== start);
        if (error) reject(error);
        else resolve(value as T);
        this.drain();
      };
      const cancel = () => finish(new DOMException('Cancelled', 'AbortError'));
      const start = () => {
        this.active.add(start);
        try {
          const idle = this.idle.pop();
          if (idle) clearTimeout(idle.timer);
          worker = idle?.worker ?? this.createWorker();
          worker.onmessage = (event) =>
            Object.prototype.hasOwnProperty.call(event.data, 'error')
              ? finish(new Error(event.data.error))
              : finish(undefined, event.data.result);
          worker.onerror = () => finish(new Error(`${this.label} worker failed. Try again.`));
          worker.onmessageerror = () =>
            finish(new Error(`${this.label} worker returned an unreadable result.`));
          timer = setTimeout(
            () => finish(new Error(`${this.label} calculation timed out. Try a smaller input.`)),
            timeoutMs,
          );
          worker.postMessage(payload, transfer);
        } catch (error) {
          finish(error);
        }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.queue.push(start);
      this.drain();
    });
  }
  private drain() {
    while (this.active.size < this.concurrency && this.queue.length) this.queue.shift()!();
  }
}
