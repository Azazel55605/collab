/** Byte-estimated immutable DAG retention. Shared children are charged once. */
export class ImmutableHistory<T extends object> {
  readonly past: T[] = [];
  readonly future: T[] = [];
  private retained = new Map<object, { refs: number; bytes: number; children: object[] }>();
  private bytes = 0;
  constructor(
    readonly maxBytes = 24 * 1024 * 1024,
    readonly maxSteps = 100,
  ) {}
  get retainedBytes() {
    return this.bytes;
  }
  record(current: T) {
    for (const root of this.future.splice(0)) this.release(root);
    this.past.push(current);
    this.retain(current);
    this.trim();
  }
  undo(current: T): T | null {
    return this.move(this.past, this.future, current);
  }
  redo(current: T): T | null {
    return this.move(this.future, this.past, current);
  }
  clear() {
    this.past.length = this.future.length = 0;
    this.retained.clear();
    this.bytes = 0;
  }
  private move(from: T[], to: T[], current: T) {
    const next = from.pop();
    if (!next) return null;
    this.release(next);
    to.push(current);
    this.retain(current);
    this.trim();
    return next;
  }
  private retain(value: object) {
    const hit = this.retained.get(value);
    if (hit) {
      hit.refs++;
      return;
    }
    let bytes = Array.isArray(value) ? 32 + value.length * 8 : 48;
    const children: object[] = [];
    for (const [key, child] of Object.entries(value)) {
      bytes += key.length * 2 + 16;
      if (typeof child === 'string') bytes += child.length * 2;
      else if (child && typeof child === 'object') children.push(child);
      else bytes += 8;
    }
    this.retained.set(value, { refs: 1, bytes, children });
    this.bytes += bytes;
    for (const child of children) this.retain(child);
  }
  private release(value: object) {
    const entry = this.retained.get(value);
    if (!entry || --entry.refs > 0) return;
    this.retained.delete(value);
    this.bytes -= entry.bytes;
    for (const child of entry.children) this.release(child);
  }
  private trim() {
    while (this.past.length + this.future.length > this.maxSteps || this.bytes > this.maxBytes) {
      const oldest = this.past.shift() ?? this.future.shift();
      if (!oldest) break;
      this.release(oldest);
    }
  }
}
