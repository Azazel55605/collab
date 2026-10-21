type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const projections = new WeakMap<object, Json>();
/** JSON-compatible live snapshots reuse immutable subtrees without a stringify/parse round trip. */
export function immutableJson(value: unknown, ancestors = new Set<object>()): Json | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
    return undefined;
  if (typeof value === 'bigint') throw new TypeError('BigInt is not JSON document content');
  if (typeof value !== 'object') return undefined;
  const cached = projections.get(value);
  if (cached !== undefined) return cached;
  if (ancestors.has(value)) throw new TypeError('Cyclic document content');
  ancestors.add(value);
  try {
    const result: Json =
      value instanceof Date
        ? value.toJSON()
        : Array.isArray(value)
          ? value.map((item) => immutableJson(item, ancestors) ?? null)
          : Object.fromEntries(
              Object.entries(value).flatMap(([key, child]) => {
                const projected = immutableJson(child, ancestors);
                return projected === undefined ? [] : [[key, projected]];
              }),
            );
    projections.set(value, result);
    return result;
  } finally {
    ancestors.delete(value);
  }
}
