import {
  calendarTimeValueKey,
  type CalendarAttachment,
  type CalendarDefinition,
  type CalendarItem,
  type CalendarMirrorAnchor,
  type CalendarMirrorConflict,
  type CalendarMirrorGroup,
  type CalendarMirrorProgress,
  type CalendarMirrorGroupStatus,
  type CalendarMirrorMember,
  type CalendarOperation,
} from '../types/calendar';
import { hostedCalendarOriginKey } from './calendarSync';

const ABSENT_FINGERPRINT = 'absent';
const MAX_MIRROR_ITEMS_PER_PASS = 5_000;

export interface CalendarMirrorPlannedOperation {
  groupId: string;
  logicalItemKey: string;
  sourceMemberId: string;
  destinationMemberId: string;
  operation: CalendarOperation;
  item?: CalendarItem;
}

export interface CalendarMirrorPlan {
  status: CalendarMirrorGroupStatus;
  operations: CalendarMirrorPlannedOperation[];
  anchors: CalendarMirrorAnchor[];
  conflicts: CalendarMirrorConflict[];
}

export interface CalendarMirrorAdapter {
  calendarListMirrorGroups(profileId: string): Promise<CalendarMirrorGroup[]>;
  calendarListMirrorAnchors(profileId: string, groupId: string): Promise<CalendarMirrorAnchor[]>;
  calendarListMirrorConflicts(profileId: string, groupId?: string, includeResolved?: boolean): Promise<CalendarMirrorConflict[]>;
  calendarListMirrorItems(profileId: string, calendarIds: string[], limit?: number): Promise<CalendarItem[]>;
  calendarUpsertItem(profileId: string, item: CalendarItem, operation: CalendarOperation): Promise<void>;
  calendarDeleteItem(profileId: string, calendarId: string, itemId: string, deletedAt: string, operation: CalendarOperation): Promise<void>;
  calendarAcknowledgeOperations(profileId: string, clientOperationIds: string[]): Promise<void>;
  calendarSaveMirrorAnchors(profileId: string, anchors: CalendarMirrorAnchor[]): Promise<void>;
  calendarSaveMirrorConflict(profileId: string, conflict: CalendarMirrorConflict): Promise<void>;
}

export interface CalendarMirrorBridgeResult {
  statuses: CalendarMirrorGroupStatus[];
  appliedOperations: number;
  conflicts: CalendarMirrorConflict[];
}

export interface CalendarMirrorResolutionResult {
  appliedOperations: number;
  conflict: CalendarMirrorConflict;
}

export function calendarMirrorLocationKey(member: Pick<CalendarMirrorMember, 'location'>): string {
  const location = member.location;
  return location.kind === 'local'
    ? `local:${location.profileId}`
    : hostedCalendarOriginKey(location);
}

export function calendarMirrorLogicalItemKey(item: CalendarItem): string {
  return `${item.uid}\u0000${item.recurrenceId ? calendarTimeValueKey(item.recurrenceId) : 'master'}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stableHash(value: string): string {
  return [
    hash32(value, 2_166_136_261),
    hash32(value, 2_166_136_261 ^ 0x9e3779b9),
    hash32(value, 2_166_136_261 ^ 0x85ebca6b),
    hash32(value, 2_166_136_261 ^ 0xc2b2ae35),
  ].join('');
}

function stableUuid(value: string): string {
  const hash = stableHash(value).split('');
  hash[12] = '4';
  hash[16] = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  const joined = hash.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function portableAttachments(attachments: CalendarAttachment[]): CalendarAttachment[] {
  return attachments.filter((attachment) => attachment.kind !== 'uploaded');
}

function portableItem(item: CalendarItem): Record<string, unknown> {
  if (item.deletedAt) {
    return {
      uid: item.uid,
      recurrenceId: item.recurrenceId,
      deleted: true,
    };
  }
  const {
    id: _id,
    calendarId: _calendarId,
    revision: _revision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    recurrenceSeriesId: _recurrenceSeriesId,
    attendees: _attendees,
    attachments,
    deletedAt: _deletedAt,
    ...portable
  } = item;
  return {
    ...portable,
    attachments: portableAttachments(attachments),
    deleted: false,
  };
}

export function calendarMirrorItemFingerprint(item: CalendarItem | undefined): string {
  if (!item) return ABSENT_FINGERPRINT;
  return `v1:${stableHash(stableJson(portableItem(item)))}`;
}

export function validateCalendarMirrorGroup(
  group: CalendarMirrorGroup,
  calendars: CalendarDefinition[],
): void {
  if (group.schemaVersion !== 1) throw new Error('Unsupported mirror group schema version.');
  if (!group.id.trim() || !group.name.trim()) throw new Error('Mirror groups require an ID and name.');
  if (group.members.length < 2 || group.members.length > 8) {
    throw new Error('Mirror groups require between two and eight calendars.');
  }
  const calendarById = new Map(calendars.map((calendar) => [calendar.id, calendar]));
  const memberIds = new Set<string>();
  const calendarIds = new Set<string>();
  const locations = new Set<string>();
  for (const member of group.members) {
    const calendar = calendarById.get(member.calendarId);
    if (!calendar) throw new Error(`Mirror calendar ${member.calendarId} is unavailable.`);
    if (calendar.readOnly || calendar.deletedAt || calendar.location.kind === 'subscription' || calendar.location.kind === 'kanban') {
      throw new Error(`${calendar.name} cannot be mirrored because it is read-only.`);
    }
    if (stableJson(calendar.location) !== stableJson(member.location)) {
      throw new Error(`${calendar.name} no longer matches its mirror location.`);
    }
    const locationKey = calendarMirrorLocationKey(member);
    if (memberIds.has(member.id) || calendarIds.has(member.calendarId) || locations.has(locationKey)) {
      throw new Error('Each mirror member must use a unique ID, calendar, and location.');
    }
    memberIds.add(member.id);
    calendarIds.add(member.calendarId);
    locations.add(locationKey);
  }
}

function destinationAttendees(item: CalendarItem, member: CalendarMirrorMember) {
  if (member.location.kind === 'local') {
    return item.attendees.filter((attendee) => attendee.kind === 'email');
  }
  const destinationServerUrl = member.location.serverUrl.replace(/\/$/, '');
  return item.attendees.filter((attendee) => (
    attendee.kind === 'collabUser'
    && attendee.serverUrl.replace(/\/$/, '') === destinationServerUrl
  ));
}

function destinationItem(input: {
  source: CalendarItem;
  destination?: CalendarItem;
  destinationMember: CalendarMirrorMember;
  destinationItems: Map<string, CalendarItem>;
  groupId: string;
  logicalItemKey: string;
  now: string;
}): CalendarItem {
  const { source, destination, destinationMember, destinationItems, groupId, logicalItemKey, now } = input;
  const recurrenceSeriesId = source.recurrenceId
    ? destinationItems.get(`${source.uid}\u0000master`)?.id
      ?? stableUuid(`${groupId}:${source.uid}\u0000master:${destinationMember.id}`)
    : undefined;
  return {
    ...source,
    id: destination?.id ?? stableUuid(`${groupId}:${logicalItemKey}:${destinationMember.id}`),
    calendarId: destinationMember.calendarId,
    attendees: destinationAttendees(source, destinationMember),
    attachments: portableAttachments(source.attachments),
    recurrenceSeriesId,
    revision: destination ? destination.revision + 1 : 0,
    createdAt: destination?.createdAt ?? now,
    updatedAt: now,
    deletedAt: undefined,
  };
}

function anchorFor(
  groupId: string,
  logicalItemKey: string,
  member: CalendarMirrorMember,
  item: CalendarItem | undefined,
  fingerprint: string,
  now: string,
): CalendarMirrorAnchor {
  return {
    groupId,
    logicalItemKey,
    memberId: member.id,
    itemId: item?.id,
    revision: item?.revision,
    fingerprint,
    deletedAt: item?.deletedAt,
    updatedAt: now,
  };
}

function conflictFor(input: {
  group: CalendarMirrorGroup;
  logicalItemKey: string;
  members: CalendarMirrorMember[];
  items: Map<string, CalendarItem | undefined>;
  fingerprints: Map<string, string>;
  existing?: CalendarMirrorConflict;
  now: string;
}): CalendarMirrorConflict {
  return {
    id: input.existing?.id ?? stableUuid(`${input.group.id}:${input.logicalItemKey}:conflict`),
    groupId: input.group.id,
    logicalItemKey: input.logicalItemKey,
    status: 'unresolved',
    versions: input.members.map((member) => ({
      memberId: member.id,
      fingerprint: input.fingerprints.get(member.id) ?? ABSENT_FINGERPRINT,
      item: input.items.get(member.id),
    })),
    detectedAt: input.existing?.detectedAt ?? input.now,
  };
}

export function planCalendarMirrorGroup(input: {
  group: CalendarMirrorGroup;
  calendars: CalendarDefinition[];
  items: CalendarItem[];
  anchors: CalendarMirrorAnchor[];
  conflicts: CalendarMirrorConflict[];
  connectedOriginKeys: Set<string>;
  deviceId: string;
  now: string;
}): CalendarMirrorPlan {
  const { group, calendars, anchors, deviceId, now } = input;
  validateCalendarMirrorGroup(group, calendars);
  if (!group.enabled) {
    return {
      status: { groupId: group.id, state: 'disabled', missingMemberIds: [], conflictCount: 0 },
      operations: [],
      anchors: [],
      conflicts: [],
    };
  }
  const missingMemberIds = group.members
    .filter((member) => member.location.kind === 'hosted' && !input.connectedOriginKeys.has(calendarMirrorLocationKey(member)))
    .map((member) => member.id);
  const unresolved = input.conflicts.filter((conflict) => conflict.status === 'unresolved');
  if (missingMemberIds.length > 0) {
    return {
      status: { groupId: group.id, state: 'waiting', missingMemberIds, conflictCount: unresolved.length },
      operations: [],
      anchors: [],
      conflicts: [],
    };
  }

  const memberByCalendar = new Map(group.members.map((member) => [member.calendarId, member]));
  const itemsByMember = new Map<string, Map<string, CalendarItem>>();
  const logicalKeys = new Set<string>(anchors.map((anchor) => anchor.logicalItemKey));
  for (const member of group.members) itemsByMember.set(member.id, new Map());
  for (const item of input.items) {
    const member = memberByCalendar.get(item.calendarId);
    if (!member) continue;
    const key = calendarMirrorLogicalItemKey(item);
    logicalKeys.add(key);
    itemsByMember.get(member.id)?.set(key, item);
  }
  const anchorByKey = new Map(anchors.map((anchor) => [`${anchor.logicalItemKey}\u0000${anchor.memberId}`, anchor]));
  const existingConflictByKey = new Map(unresolved.map((conflict) => [conflict.logicalItemKey, conflict]));
  const operations: CalendarMirrorPlannedOperation[] = [];
  const nextAnchors: CalendarMirrorAnchor[] = [];
  const nextConflicts: CalendarMirrorConflict[] = [];

  for (const logicalItemKey of [...logicalKeys].sort()) {
    if (existingConflictByKey.has(logicalItemKey)) continue;
    const currentItems = new Map(group.members.map((member) => [member.id, itemsByMember.get(member.id)?.get(logicalItemKey)]));
    const fingerprints = new Map(group.members.map((member) => [member.id, calendarMirrorItemFingerprint(currentItems.get(member.id))]));
    const hasAnyAnchor = group.members.some((member) => anchorByKey.has(`${logicalItemKey}\u0000${member.id}`));
    const changed = group.members.filter((member) => {
      const anchor = anchorByKey.get(`${logicalItemKey}\u0000${member.id}`);
      return hasAnyAnchor
        ? fingerprints.get(member.id) !== (anchor?.fingerprint ?? ABSENT_FINGERPRINT)
        : fingerprints.get(member.id) !== ABSENT_FINGERPRINT;
    });
    if (changed.length === 0) continue;
    const changedFingerprints = new Set(changed.map((member) => fingerprints.get(member.id)));
    if (changedFingerprints.size > 1) {
      nextConflicts.push(conflictFor({
        group,
        logicalItemKey,
        members: group.members,
        items: currentItems,
        fingerprints,
        existing: existingConflictByKey.get(logicalItemKey),
        now,
      }));
      continue;
    }
    const sourceMember = changed[0];
    const source = currentItems.get(sourceMember.id);
    const sourceFingerprint = fingerprints.get(sourceMember.id) ?? ABSENT_FINGERPRINT;
    for (const destinationMember of group.members) {
      const destination = currentItems.get(destinationMember.id);
      if (destinationMember.id === sourceMember.id || fingerprints.get(destinationMember.id) === sourceFingerprint) continue;
      const sourceChangeId = `mirror:${group.id}:${stableHash(`${logicalItemKey}:${sourceFingerprint}`)}`;
      const clientOperationId = `mirror:${stableHash(`${sourceChangeId}:${destinationMember.id}`)}`;
      if (!source || source.deletedAt) {
        if (!destination || destination.deletedAt) continue;
        operations.push({
          groupId: group.id,
          logicalItemKey,
          sourceMemberId: sourceMember.id,
          destinationMemberId: destinationMember.id,
          operation: {
            clientOperationId,
            deviceId,
            expectedRevision: destination.revision,
            sourceChangeId,
            propagationLineage: [`mirror:${group.id}`, `member:${sourceMember.id}`, `member:${destinationMember.id}`],
            mutation: {
              type: 'deleteItem',
              calendarId: destinationMember.calendarId,
              itemId: destination.id,
              deletedAt: source?.deletedAt ?? now,
            },
          },
        });
        continue;
      }
      const mirrored = destinationItem({
        source,
        destination,
        destinationMember,
        destinationItems: itemsByMember.get(destinationMember.id) ?? new Map(),
        groupId: group.id,
        logicalItemKey,
        now,
      });
      operations.push({
        groupId: group.id,
        logicalItemKey,
        sourceMemberId: sourceMember.id,
        destinationMemberId: destinationMember.id,
        item: mirrored,
        operation: {
          clientOperationId,
          deviceId,
          expectedRevision: destination?.revision ?? 0,
          sourceChangeId,
          propagationLineage: [`mirror:${group.id}`, `member:${sourceMember.id}`, `member:${destinationMember.id}`],
          mutation: { type: 'upsertItem', item: mirrored },
        },
      });
      currentItems.set(destinationMember.id, mirrored);
    }
    for (const member of group.members) {
      const item = currentItems.get(member.id);
      nextAnchors.push(anchorFor(group.id, logicalItemKey, member, item, sourceFingerprint, now));
    }
  }
  const conflictCount = unresolved.length + nextConflicts.length;
  return {
    status: {
      groupId: group.id,
      state: conflictCount > 0 ? 'conflict' : 'ready',
      missingMemberIds: [],
      conflictCount,
      lastBridgedAt: now,
    },
    operations,
    anchors: nextAnchors,
    conflicts: nextConflicts,
  };
}

export async function bridgeCalendarMirrors(input: {
  profileId: string;
  calendars: CalendarDefinition[];
  connectedOriginKeys: Set<string>;
  deviceId: string;
  adapter: CalendarMirrorAdapter;
  now?: string;
  onProgress?: (progress: CalendarMirrorProgress) => void;
}): Promise<CalendarMirrorBridgeResult> {
  const now = input.now ?? new Date().toISOString();
  const groups = await input.adapter.calendarListMirrorGroups(input.profileId);
  const statuses: CalendarMirrorGroupStatus[] = [];
  const conflicts: CalendarMirrorConflict[] = [];
  let appliedOperations = 0;
  for (const group of groups) {
    let groupAppliedOperations = 0;
    let groupTotalOperations: number | null = null;
    input.onProgress?.({
      groupId: group.id,
      groupName: group.name,
      phase: 'checking',
      processedOperations: 0,
      totalOperations: null,
      detail: 'Checking calendars',
    });
    try {
      const [anchors, existingConflicts, items] = await Promise.all([
        input.adapter.calendarListMirrorAnchors(input.profileId, group.id),
        input.adapter.calendarListMirrorConflicts(input.profileId, group.id, false),
        input.adapter.calendarListMirrorItems(
          input.profileId,
          group.members.map((member) => member.calendarId),
          MAX_MIRROR_ITEMS_PER_PASS,
        ),
      ]);
      const plan = planCalendarMirrorGroup({
        group,
        calendars: input.calendars,
        items,
        anchors,
        conflicts: existingConflicts,
        connectedOriginKeys: input.connectedOriginKeys,
        deviceId: input.deviceId,
        now,
      });
      for (const conflict of plan.conflicts) {
        await input.adapter.calendarSaveMirrorConflict(input.profileId, conflict);
        conflicts.push(conflict);
      }
      groupTotalOperations = plan.operations.length;
      for (const planned of plan.operations) {
        input.onProgress?.({
          groupId: group.id,
          groupName: group.name,
          phase: 'applying',
          processedOperations: groupAppliedOperations,
          totalOperations: plan.operations.length,
          detail: planned.operation.mutation.type === 'upsertItem'
            ? planned.operation.mutation.item.title
            : 'Propagating deletion',
        });
        if (planned.operation.mutation.type === 'deleteItem') {
          const mutation = planned.operation.mutation;
          await input.adapter.calendarDeleteItem(
            input.profileId,
            mutation.calendarId,
            mutation.itemId,
            mutation.deletedAt,
            planned.operation,
          );
        } else if (planned.item) {
          await input.adapter.calendarUpsertItem(input.profileId, planned.item, planned.operation);
        }
        const destination = group.members.find((member) => member.id === planned.destinationMemberId);
        if (destination?.location.kind === 'local') {
          await input.adapter.calendarAcknowledgeOperations(input.profileId, [planned.operation.clientOperationId]);
        }
        groupAppliedOperations += 1;
        appliedOperations += 1;
      }
      if (plan.anchors.length > 0) {
        await input.adapter.calendarSaveMirrorAnchors(input.profileId, plan.anchors);
      }
      statuses.push(plan.status);
      const phase = plan.status.state === 'waiting'
        ? 'waiting'
        : plan.status.state === 'conflict'
          ? 'conflict'
          : plan.status.state === 'disabled'
            ? 'disabled'
            : 'complete';
      input.onProgress?.({
        groupId: group.id,
        groupName: group.name,
        phase,
        processedOperations: groupAppliedOperations,
        totalOperations: plan.operations.length,
        detail: phase === 'waiting'
          ? 'Waiting for every server'
          : phase === 'conflict'
            ? `${plan.status.conflictCount} conflict${plan.status.conflictCount === 1 ? '' : 's'} need attention`
            : phase === 'disabled'
              ? 'Mirror paused'
              : groupAppliedOperations > 0
                ? `Applied ${groupAppliedOperations} change${groupAppliedOperations === 1 ? '' : 's'}`
                : 'Up to date',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statuses.push({
        groupId: group.id,
        state: 'error',
        missingMemberIds: [],
        conflictCount: 0,
        error: message,
      });
      input.onProgress?.({
        groupId: group.id,
        groupName: group.name,
        phase: 'error',
        processedOperations: groupAppliedOperations,
        totalOperations: groupTotalOperations,
        detail: 'Mirror sync failed',
        error: message,
      });
    }
  }
  return { statuses, appliedOperations, conflicts };
}

export async function resolveCalendarMirrorConflict(input: {
  profileId: string;
  group: CalendarMirrorGroup;
  conflict: CalendarMirrorConflict;
  chosenMemberId: string;
  calendars: CalendarDefinition[];
  connectedOriginKeys: Set<string>;
  deviceId: string;
  adapter: CalendarMirrorAdapter;
  now?: string;
}): Promise<CalendarMirrorResolutionResult> {
  validateCalendarMirrorGroup(input.group, input.calendars);
  if (input.conflict.groupId !== input.group.id || input.conflict.status !== 'unresolved') {
    throw new Error('Calendar mirror conflict is no longer unresolved.');
  }
  const missing = input.group.members.filter((member) => (
    member.location.kind === 'hosted'
    && !input.connectedOriginKeys.has(calendarMirrorLocationKey(member))
  ));
  if (missing.length > 0) {
    throw new Error('Connect every server in this mirror group before resolving the conflict.');
  }
  const chosenMember = input.group.members.find((member) => member.id === input.chosenMemberId);
  const chosenVersion = input.conflict.versions.find((version) => version.memberId === input.chosenMemberId);
  if (!chosenMember || !chosenVersion) throw new Error('The selected conflict version is unavailable.');
  const now = input.now ?? new Date().toISOString();
  const items = await input.adapter.calendarListMirrorItems(
    input.profileId,
    input.group.members.map((member) => member.calendarId),
    MAX_MIRROR_ITEMS_PER_PASS,
  );
  const memberByCalendar = new Map(input.group.members.map((member) => [member.calendarId, member]));
  const itemsByMember = new Map(input.group.members.map((member) => [member.id, new Map<string, CalendarItem>()]));
  for (const item of items) {
    const member = memberByCalendar.get(item.calendarId);
    if (member) itemsByMember.get(member.id)?.set(calendarMirrorLogicalItemKey(item), item);
  }
  const selectedCurrent = itemsByMember.get(chosenMember.id)?.get(input.conflict.logicalItemKey);
  if (calendarMirrorItemFingerprint(selectedCurrent) !== chosenVersion.fingerprint) {
    throw new Error('The selected calendar changed after this conflict was detected. Sync again before resolving it.');
  }
  const source = chosenVersion.item;
  const sourceFingerprint = chosenVersion.fingerprint;
  let appliedOperations = 0;
  const nextItems = new Map<string, CalendarItem | undefined>();
  for (const member of input.group.members) {
    const destination = itemsByMember.get(member.id)?.get(input.conflict.logicalItemKey);
    nextItems.set(member.id, destination);
    if (calendarMirrorItemFingerprint(destination) === sourceFingerprint) continue;
    const sourceChangeId = `mirror-resolution:${input.conflict.id}:${sourceFingerprint}`;
    const clientOperationId = `mirror:${stableHash(`${sourceChangeId}:${member.id}`)}`;
    let operation: CalendarOperation;
    let mirrored: CalendarItem | undefined;
    if (!source || source.deletedAt) {
      if (!destination || destination.deletedAt) continue;
      const deletedAt = source?.deletedAt ?? now;
      operation = {
        clientOperationId,
        deviceId: input.deviceId,
        expectedRevision: destination.revision,
        sourceChangeId,
        propagationLineage: [`mirror:${input.group.id}`, `resolution:${input.conflict.id}`, `member:${member.id}`],
        mutation: {
          type: 'deleteItem',
          calendarId: member.calendarId,
          itemId: destination.id,
          deletedAt,
        },
      };
      await input.adapter.calendarDeleteItem(
        input.profileId,
        member.calendarId,
        destination.id,
        deletedAt,
        operation,
      );
      nextItems.set(member.id, { ...destination, deletedAt });
    } else {
      mirrored = destinationItem({
        source,
        destination,
        destinationMember: member,
        destinationItems: itemsByMember.get(member.id) ?? new Map(),
        groupId: input.group.id,
        logicalItemKey: input.conflict.logicalItemKey,
        now,
      });
      operation = {
        clientOperationId,
        deviceId: input.deviceId,
        expectedRevision: destination?.revision ?? 0,
        sourceChangeId,
        propagationLineage: [`mirror:${input.group.id}`, `resolution:${input.conflict.id}`, `member:${member.id}`],
        mutation: { type: 'upsertItem', item: mirrored },
      };
      await input.adapter.calendarUpsertItem(input.profileId, mirrored, operation);
      nextItems.set(member.id, mirrored);
    }
    if (member.location.kind === 'local') {
      await input.adapter.calendarAcknowledgeOperations(input.profileId, [operation.clientOperationId]);
    }
    appliedOperations += 1;
  }
  await input.adapter.calendarSaveMirrorAnchors(
    input.profileId,
    input.group.members.map((member) => anchorFor(
      input.group.id,
      input.conflict.logicalItemKey,
      member,
      nextItems.get(member.id),
      sourceFingerprint,
      now,
    )),
  );
  const resolved: CalendarMirrorConflict = {
    ...input.conflict,
    status: 'resolved',
    resolvedAt: now,
  };
  await input.adapter.calendarSaveMirrorConflict(input.profileId, resolved);
  return { appliedOperations, conflict: resolved };
}
