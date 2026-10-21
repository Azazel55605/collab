/** Preserve a derived array identity across changes to fields its consumer ignores. */
export function retainProjection<T>(
  previous: readonly T[],
  next: readonly T[],
  equal: (a: T, b: T) => boolean,
): readonly T[] {
  return previous.length === next.length &&
    next.every((value, index) => equal(previous[index], value))
    ? previous
    : next;
}
