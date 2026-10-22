/** Single-flight, with one trailing reconciliation when events arrive in flight. */
export class CoalescedTask {
  private pending: (() => Promise<void>) | null = null;
  private active: Promise<void> | null = null;
  run(task: () => Promise<void>): Promise<void> {
    this.pending = task;
    if (this.active) return this.active;
    this.active = (async () => {
      let error: unknown;
      while (this.pending) {
        const next = this.pending;
        this.pending = null;
        try {
          await next();
          error = undefined;
        } catch (reason) {
          error = reason;
        }
      }
      if (error) throw error;
    })().finally(() => {
      this.active = null;
    });
    return this.active;
  }
}
