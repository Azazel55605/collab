/** Recompute only entries whose dependency identities changed; explicitly retire removed IDs. */
export class IncrementalMap<T> {
  private entries = new Map<string, { dependencies: readonly unknown[]; value: T }>();
  get(id: string, dependencies: readonly unknown[], compute: () => T): T {
    const hit = this.entries.get(id);
    if (
      hit &&
      hit.dependencies.length === dependencies.length &&
      dependencies.every((value, index) => Object.is(value, hit.dependencies[index]))
    )
      return hit.value;
    const value = compute();
    this.entries.set(id, { dependencies, value });
    return value;
  }
  retain(ids: ReadonlySet<string>) {
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
  }
  get size() {
    return this.entries.size;
  }
}
