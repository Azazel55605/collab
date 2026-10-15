/** Shared back-pressure for expensive preview work; cancelled consumers skip queued IO. */
export class PreviewQueue {
  private active = 0;
  private pending: Array<() => void> = [];
  constructor(private readonly limit = 2) {}
  run<T>(work: () => Promise<T>, current: () => boolean = () => true): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        void Promise.resolve()
          .then(() => {
            if (!current()) throw new DOMException('Preview cancelled', 'AbortError');
            return work();
          })
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.drain();
          });
      };
      this.pending.push(start);
      this.drain();
    });
  }
  private drain() {
    while (this.active < this.limit && this.pending.length) this.pending.shift()!();
  }
}
export const canvasPreviewQueue = new PreviewQueue(2);
export const documentPreviewQueue = new PreviewQueue(4);
export const webPreviewQueue = new PreviewQueue(4);

export const pdfPreviewQueue = new PreviewQueue(2);
