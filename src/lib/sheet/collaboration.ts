import type { SheetDocument } from '../../types/sheet';

export type SheetCollaborationConflictKind =
  | 'overlapping-edit'
  | 'deleted-target'
  | 'unsupported-schema';

export interface SheetCollaborationConflict {
  kind: SheetCollaborationConflictKind;
  path: string;
}

export interface SheetMergeResult {
  document: SheetDocument;
  conflicts: SheetCollaborationConflict[];
}

export interface SheetOperationIdentity {
  actorId: string;
  clientOperationId: string;
  index: number;
}

/**
 * Stable idempotency key for a semantic workbook operation.
 *
 * The outer client operation identifies one user action (paste, fill, insert,
 * etc.); the index identifies each atomic cell/structure mutation within it.
 * Yjs supplies transport-level idempotency, while this identity is used by
 * recovery logs and deterministic operation ordering.
 */
export function sheetOperationId(identity: SheetOperationIdentity): string {
  const actor = encodeURIComponent(identity.actorId);
  const operation = encodeURIComponent(identity.clientOperationId);
  return `sheet:${actor}:${operation}:${identity.index}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => equal(value, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key]),
      );
  }
  return false;
}

function stableEntityId(value: unknown): string | null {
  return isObject(value) && typeof value.id === 'string' ? value.id : null;
}

function uniqueStringArray(value: unknown[]): value is string[] {
  return value.every((entry) => typeof entry === 'string')
    && new Set(value as string[]).size === value.length;
}

function deterministicRank(id: string, order: string[]): number | null {
  const index = order.indexOf(id);
  return index < 0 ? null : index / Math.max(1, order.length);
}

function combinedRank(id: string, local: string[], remote: string[]): number {
  const localRank = deterministicRank(id, local);
  const remoteRank = deterministicRank(id, remote);
  if (localRank === null) return remoteRank ?? Number.POSITIVE_INFINITY;
  if (remoteRank === null) return localRank;
  return (localRank + remoteRank) / 2;
}

/**
 * Merge stable row/column/worksheet identity order.
 *
 * A base identity deleted by either side stays deleted. Concurrent inserts are
 * ordered by the average of both clients' positions and then by stable ID, so
 * replay order cannot change the result.
 */
export function mergeStableIdentityOrder(
  base: string[],
  local: string[],
  remote: string[],
): string[] {
  if (equal(local, remote)) return [...local];
  if (equal(local, base)) return [...remote];
  if (equal(remote, base)) return [...local];

  const baseIds = new Set(base);
  const ids = new Set<string>();
  for (const id of [...local, ...remote]) {
    if (!baseIds.has(id) || (local.includes(id) && remote.includes(id))) ids.add(id);
  }

  return [...ids].sort((left, right) => {
    const leftRank = combinedRank(left, local, remote);
    const rightRank = combinedRank(right, local, remote);
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.localeCompare(right);
  });
}

interface MergeContext {
  conflicts: SheetCollaborationConflict[];
}

const ABSENT = Symbol('sheet-merge-absent');
type MergeValue = unknown | typeof ABSENT;

function mergeArray(
  base: unknown[],
  local: unknown[],
  remote: unknown[],
  path: string,
  context: MergeContext,
): unknown[] {
  if (uniqueStringArray(base) && uniqueStringArray(local) && uniqueStringArray(remote)) {
    return mergeStableIdentityOrder(base, local, remote);
  }

  const allEntityArrays = [base, local, remote].every(
    (array) => array.every((entry) => stableEntityId(entry) !== null),
  );
  if (!allEntityArrays) {
    context.conflicts.push({ kind: 'overlapping-edit', path });
    return local;
  }

  const baseMap = new Map(base.map((entry) => [stableEntityId(entry)!, entry]));
  const localMap = new Map(local.map((entry) => [stableEntityId(entry)!, entry]));
  const remoteMap = new Map(remote.map((entry) => [stableEntityId(entry)!, entry]));
  const mergedOrder = mergeStableIdentityOrder(
    [...baseMap.keys()],
    [...localMap.keys()],
    [...remoteMap.keys()],
  );
  // Deleted base entities are absent from the merged order, but still need to
  // pass through mergePresence so delete-versus-edit is reported explicitly.
  const order = [
    ...mergedOrder,
    ...new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]),
  ].filter((id, index, values) => values.indexOf(id) === index);

  return order.flatMap((id) => {
    const merged = mergePresence(
      baseMap.has(id), baseMap.get(id),
      localMap.has(id), localMap.get(id),
      remoteMap.has(id), remoteMap.get(id),
      `${path}/${id}`,
      context,
    );
    return merged === ABSENT ? [] : [merged];
  });
}

function mergePresence(
  hasBase: boolean,
  base: unknown,
  hasLocal: boolean,
  local: unknown,
  hasRemote: boolean,
  remote: unknown,
  path: string,
  context: MergeContext,
): MergeValue {
  if (!hasLocal && !hasRemote) return ABSENT;

  if (hasBase && !hasLocal) {
    if (!hasRemote || equal(remote, base)) return ABSENT;
    context.conflicts.push({ kind: 'deleted-target', path });
    return local ?? ABSENT;
  }
  if (hasBase && !hasRemote) {
    if (!hasLocal || equal(local, base)) return ABSENT;
    context.conflicts.push({ kind: 'deleted-target', path });
    return local;
  }

  if (!hasBase && !hasLocal) return remote;
  if (!hasBase && !hasRemote) return local;
  return mergeValue(base, local, remote, path, context);
}

function mergeValue(
  base: unknown,
  local: unknown,
  remote: unknown,
  path: string,
  context: MergeContext,
): unknown {
  if (equal(local, remote)) return local;
  if (equal(local, base)) return remote;
  if (equal(remote, base)) return local;

  if (path === '/updatedAt' && typeof local === 'string' && typeof remote === 'string') {
    return local > remote ? local : remote;
  }

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    return mergeArray(base, local, remote, path, context);
  }

  if (isObject(base) && isObject(local) && isObject(remote)) {
    const merged: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    for (const key of keys) {
      const value = mergePresence(
        Object.prototype.hasOwnProperty.call(base, key), base[key],
        Object.prototype.hasOwnProperty.call(local, key), local[key],
        Object.prototype.hasOwnProperty.call(remote, key), remote[key],
        `${path}/${key}`,
        context,
      );
      if (value !== ABSENT) merged[key] = value;
    }
    return merged;
  }

  context.conflicts.push({ kind: 'overlapping-edit', path });
  return local;
}

/**
 * Three-way merge for REST/revision recovery.
 *
 * Live sessions normally converge through Yjs. This path handles optimistic
 * REST saves, offline replay against a newer revision, and revision recovery.
 * Callers persist the result only when `conflicts` is empty.
 */
export function mergeSheetDocuments(
  base: SheetDocument,
  local: SheetDocument,
  remote: SheetDocument,
): SheetMergeResult {
  if (
    base.schemaVersion !== local.schemaVersion
    || base.schemaVersion !== remote.schemaVersion
    || base.id !== local.id
    || base.id !== remote.id
  ) {
    return {
      document: local,
      conflicts: [{ kind: 'unsupported-schema', path: '/' }],
    };
  }

  const context: MergeContext = { conflicts: [] };
  return {
    document: mergeValue(base, local, remote, '', context) as SheetDocument,
    conflicts: context.conflicts,
  };
}
