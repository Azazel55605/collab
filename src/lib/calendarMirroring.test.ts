import { describe, expect, it, vi } from 'vitest';

import {
  bridgeCalendarMirrors,
  calendarMirrorItemFingerprint,
  calendarMirrorLogicalItemKey,
  planCalendarMirrorGroup,
  resolveCalendarMirrorConflict,
  validateCalendarMirrorGroup,
} from './calendarMirroring';
import type {
  CalendarDefinition,
  CalendarItem,
  CalendarMirrorAnchor,
  CalendarMirrorGroup,
} from '../types/calendar';

const now = '2026-07-24T08:00:00.000Z';
const localLocation = { kind: 'local' as const, profileId: 'profile-1' };
const hostedLocation = { kind: 'hosted' as const, serverUrl: 'https://one.example', userId: 'user-1' };

function calendar(id: string, location: CalendarDefinition['location'], readOnly = false): CalendarDefinition {
  return {
    schemaVersion: 1,
    id,
    globalId: `global-${id}`,
    location,
    name: id,
    color: '#a78bfa',
    defaultTimeZone: 'UTC',
    archived: false,
    readOnly,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

const calendars = [
  calendar('local-calendar', localLocation),
  calendar('hosted-calendar', hostedLocation),
];

const group: CalendarMirrorGroup = {
  schemaVersion: 1,
  id: 'group-1',
  name: 'Personal mirror',
  enabled: true,
  members: [
    { id: 'local-member', calendarId: 'local-calendar', location: localLocation, addedAt: now },
    { id: 'hosted-member', calendarId: 'hosted-calendar', location: hostedLocation, addedAt: now },
  ],
  createdAt: now,
  updatedAt: now,
};

function event(calendarId: string, id: string, title = 'Planning'): CalendarItem {
  return {
    id,
    uid: 'planning@example',
    calendarId,
    kind: 'event',
    title,
    start: { kind: 'dateTime', dateTime: '2026-07-24T09:00:00.000Z', timeZone: 'UTC' },
    end: { kind: 'dateTime', dateTime: '2026-07-24T10:00:00.000Z', timeZone: 'UTC' },
    availability: 'busy',
    reminders: [],
    attendees: [],
    attachments: [],
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function anchorsFor(items: CalendarItem[]): CalendarMirrorAnchor[] {
  const key = calendarMirrorLogicalItemKey(items[0]);
  return group.members.map((member) => {
    const item = items.find((entry) => entry.calendarId === member.calendarId);
    return {
      groupId: group.id,
      logicalItemKey: key,
      memberId: member.id,
      itemId: item?.id,
      revision: item?.revision,
      fingerprint: calendarMirrorItemFingerprint(item),
      updatedAt: now,
    };
  });
}

const connected = new Set(['https://one.example::user-1']);

describe('calendar mirroring', () => {
  it('requires writable calendars in distinct locations', () => {
    expect(() => validateCalendarMirrorGroup(group, calendars)).not.toThrow();
    expect(() => validateCalendarMirrorGroup(
      { ...group, members: [...group.members, { ...group.members[1], id: 'duplicate', calendarId: 'other' }] },
      [...calendars, calendar('other', hostedLocation)],
    )).toThrow(/unique/);
    expect(() => validateCalendarMirrorGroup(group, [
      calendars[0],
      { ...calendars[1], readOnly: true },
    ])).toThrow(/read-only/);
  });

  it('copies a new local item to a hosted member with deterministic lineage', () => {
    const source = event('local-calendar', 'local-item');
    const plan = planCalendarMirrorGroup({
      group,
      calendars,
      items: [source],
      anchors: [],
      conflicts: [],
      connectedOriginKeys: connected,
      deviceId: 'device-1',
      now,
    });
    expect(plan.status.state).toBe('ready');
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toEqual(expect.objectContaining({
      sourceMemberId: 'local-member',
      destinationMemberId: 'hosted-member',
      operation: expect.objectContaining({
        sourceChangeId: expect.stringContaining('mirror:group-1:'),
        propagationLineage: ['mirror:group-1', 'member:local-member', 'member:hosted-member'],
        mutation: expect.objectContaining({ type: 'upsertItem' }),
      }),
    }));
    expect(plan.operations[0].item).toEqual(expect.objectContaining({
      calendarId: 'hosted-calendar',
      uid: source.uid,
      title: source.title,
    }));
    expect(plan.anchors).toHaveLength(2);
  });

  it('bridges directly between two authenticated server locations without server credentials crossing', () => {
    const secondLocation = { kind: 'hosted' as const, serverUrl: 'https://two.example', userId: 'user-2' };
    const serverCalendars = [
      calendars[1],
      calendar('second-hosted-calendar', secondLocation),
    ];
    const serverGroup: CalendarMirrorGroup = {
      ...group,
      id: 'server-group',
      members: [
        group.members[1],
        { id: 'second-hosted-member', calendarId: 'second-hosted-calendar', location: secondLocation, addedAt: now },
      ],
    };
    const plan = planCalendarMirrorGroup({
      group: serverGroup,
      calendars: serverCalendars,
      items: [event('hosted-calendar', 'hosted-item')],
      anchors: [],
      conflicts: [],
      connectedOriginKeys: new Set([
        'https://one.example::user-1',
        'https://two.example::user-2',
      ]),
      deviceId: 'device-1',
      now,
    });
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]).toEqual(expect.objectContaining({
      sourceMemberId: 'hosted-member',
      destinationMemberId: 'second-hosted-member',
      item: expect.objectContaining({ calendarId: 'second-hosted-calendar' }),
    }));
  });

  it('does not echo a mirrored operation after its anchors are stored', () => {
    const source = event('local-calendar', 'local-item');
    const first = planCalendarMirrorGroup({
      group,
      calendars,
      items: [source],
      anchors: [],
      conflicts: [],
      connectedOriginKeys: connected,
      deviceId: 'device-1',
      now,
    });
    const destination = first.operations[0].item!;
    const second = planCalendarMirrorGroup({
      group,
      calendars,
      items: [source, destination],
      anchors: first.anchors,
      conflicts: [],
      connectedOriginKeys: connected,
      deviceId: 'device-2',
      now: '2026-07-24T08:01:00.000Z',
    });
    expect(second.operations).toEqual([]);
    expect(second.conflicts).toEqual([]);
  });

  it('waits without applying partial changes when a hosted location is disconnected', () => {
    const plan = planCalendarMirrorGroup({
      group,
      calendars,
      items: [event('local-calendar', 'local-item')],
      anchors: [],
      conflicts: [],
      connectedOriginKeys: new Set(),
      deviceId: 'device-1',
      now,
    });
    expect(plan.status).toEqual(expect.objectContaining({
      state: 'waiting',
      missingMemberIds: ['hosted-member'],
    }));
    expect(plan.operations).toEqual([]);
    expect(plan.anchors).toEqual([]);
  });

  it('preserves both versions when members changed after their common anchor', () => {
    const baseline = [
      event('local-calendar', 'local-item'),
      event('hosted-calendar', 'hosted-item'),
    ];
    const changed = [
      { ...baseline[0], title: 'Local title', revision: 1 },
      { ...baseline[1], title: 'Hosted title', revision: 1 },
    ];
    const plan = planCalendarMirrorGroup({
      group,
      calendars,
      items: changed,
      anchors: anchorsFor(baseline),
      conflicts: [],
      connectedOriginKeys: connected,
      deviceId: 'device-1',
      now,
    });
    expect(plan.status.state).toBe('conflict');
    expect(plan.operations).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].versions.map((version) => version.item?.title)).toEqual([
      'Local title',
      'Hosted title',
    ]);
  });

  it('propagates tombstones after a previously anchored item is deleted', () => {
    const baseline = [
      event('local-calendar', 'local-item'),
      event('hosted-calendar', 'hosted-item'),
    ];
    const deleted = {
      ...baseline[0],
      deletedAt: '2026-07-24T09:00:00.000Z',
      updatedAt: '2026-07-24T09:00:00.000Z',
      revision: 1,
    };
    const plan = planCalendarMirrorGroup({
      group,
      calendars,
      items: [deleted, baseline[1]],
      anchors: anchorsFor(baseline),
      conflicts: [],
      connectedOriginKeys: connected,
      deviceId: 'device-1',
      now: deleted.deletedAt,
    });
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].operation.mutation).toEqual({
      type: 'deleteItem',
      calendarId: 'hosted-calendar',
      itemId: 'hosted-item',
      deletedAt: deleted.deletedAt,
    });
  });

  it('resolves a concurrent conflict by propagating the chosen preserved version', async () => {
    const baseline = [
      event('local-calendar', 'local-item'),
      event('hosted-calendar', 'hosted-item'),
    ];
    const changed = [
      { ...baseline[0], title: 'Keep local', revision: 1 },
      { ...baseline[1], title: 'Hosted edit', revision: 1 },
    ];
    const plan = planCalendarMirrorGroup({
      group,
      calendars,
      items: changed,
      anchors: anchorsFor(baseline),
      conflicts: [],
      connectedOriginKeys: connected,
      deviceId: 'device-1',
      now,
    });
    const conflict = plan.conflicts[0];
    const adapter = {
      calendarListMirrorGroups: vi.fn(),
      calendarListMirrorAnchors: vi.fn(),
      calendarListMirrorConflicts: vi.fn(),
      calendarListMirrorItems: vi.fn().mockResolvedValue(changed),
      calendarUpsertItem: vi.fn().mockResolvedValue(undefined),
      calendarDeleteItem: vi.fn().mockResolvedValue(undefined),
      calendarAcknowledgeOperations: vi.fn().mockResolvedValue(undefined),
      calendarSaveMirrorAnchors: vi.fn().mockResolvedValue(undefined),
      calendarSaveMirrorConflict: vi.fn().mockResolvedValue(undefined),
    };
    const result = await resolveCalendarMirrorConflict({
      profileId: 'profile-1',
      group,
      conflict,
      chosenMemberId: 'local-member',
      calendars,
      connectedOriginKeys: connected,
      deviceId: 'device-2',
      adapter,
      now: '2026-07-24T08:05:00.000Z',
    });
    expect(result.appliedOperations).toBe(1);
    expect(adapter.calendarUpsertItem).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ calendarId: 'hosted-calendar', title: 'Keep local' }),
      expect.objectContaining({
        sourceChangeId: expect.stringContaining(`mirror-resolution:${conflict.id}`),
      }),
    );
    expect(adapter.calendarSaveMirrorAnchors).toHaveBeenCalledOnce();
    expect(adapter.calendarSaveMirrorConflict).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ id: conflict.id, status: 'resolved' }),
    );
  });

  it('isolates a failed mirror group and continues unrelated groups with visible progress', async () => {
    const badGroup = { ...group, id: 'bad-group', name: 'Broken mirror' };
    const goodGroup = { ...group, id: 'good-group', name: 'Working mirror' };
    const progress = vi.fn();
    const adapter = {
      calendarListMirrorGroups: vi.fn().mockResolvedValue([badGroup, goodGroup]),
      calendarListMirrorAnchors: vi.fn().mockImplementation(async (_profileId: string, groupId: string) => {
        if (groupId === badGroup.id) throw new Error('temporary anchor read failure');
        return [];
      }),
      calendarListMirrorConflicts: vi.fn().mockResolvedValue([]),
      calendarListMirrorItems: vi.fn().mockResolvedValue([event('local-calendar', 'local-item')]),
      calendarUpsertItem: vi.fn().mockResolvedValue(undefined),
      calendarDeleteItem: vi.fn().mockResolvedValue(undefined),
      calendarAcknowledgeOperations: vi.fn().mockResolvedValue(undefined),
      calendarSaveMirrorAnchors: vi.fn().mockResolvedValue(undefined),
      calendarSaveMirrorConflict: vi.fn().mockResolvedValue(undefined),
    };

    const result = await bridgeCalendarMirrors({
      profileId: 'profile-1',
      calendars,
      connectedOriginKeys: connected,
      deviceId: 'device-1',
      adapter,
      now,
      onProgress: progress,
    });

    expect(result.statuses).toEqual([
      expect.objectContaining({ groupId: badGroup.id, state: 'error', error: 'temporary anchor read failure' }),
      expect.objectContaining({ groupId: goodGroup.id, state: 'ready' }),
    ]);
    expect(result.appliedOperations).toBe(1);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      groupId: badGroup.id,
      phase: 'error',
      error: 'temporary anchor read failure',
    }));
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      groupId: goodGroup.id,
      phase: 'complete',
      processedOperations: 1,
    }));
  });

  it('retries deterministically after a partial group write and converges without echoing', async () => {
    const secondLocation = { kind: 'hosted' as const, serverUrl: 'https://two.example', userId: 'user-2' };
    const secondCalendar = calendar('second-hosted-calendar', secondLocation);
    const threeMemberGroup: CalendarMirrorGroup = {
      ...group,
      id: 'three-member-group',
      members: [
        ...group.members,
        { id: 'second-hosted-member', calendarId: secondCalendar.id, location: secondLocation, addedAt: now },
      ],
    };
    const storedItems: CalendarItem[] = [event('local-calendar', 'local-item')];
    const attemptedOperationIds: string[] = [];
    let failSecondDestination = true;
    const adapter = {
      calendarListMirrorGroups: vi.fn().mockResolvedValue([threeMemberGroup]),
      calendarListMirrorAnchors: vi.fn().mockResolvedValue([]),
      calendarListMirrorConflicts: vi.fn().mockResolvedValue([]),
      calendarListMirrorItems: vi.fn().mockImplementation(async () => [...storedItems]),
      calendarUpsertItem: vi.fn().mockImplementation(async (
        _profileId: string,
        item: CalendarItem,
        operation: { clientOperationId: string },
      ) => {
        attemptedOperationIds.push(operation.clientOperationId);
        if (failSecondDestination && item.calendarId === secondCalendar.id) {
          throw new Error('second destination unavailable');
        }
        storedItems.push(item);
      }),
      calendarDeleteItem: vi.fn().mockResolvedValue(undefined),
      calendarAcknowledgeOperations: vi.fn().mockResolvedValue(undefined),
      calendarSaveMirrorAnchors: vi.fn().mockResolvedValue(undefined),
      calendarSaveMirrorConflict: vi.fn().mockResolvedValue(undefined),
    };
    const connectedToBoth = new Set([...connected, 'https://two.example::user-2']);

    const first = await bridgeCalendarMirrors({
      profileId: 'profile-1',
      calendars: [...calendars, secondCalendar],
      connectedOriginKeys: connectedToBoth,
      deviceId: 'device-1',
      adapter,
      now,
    });
    expect(first.appliedOperations).toBe(1);
    expect(first.statuses[0]).toEqual(expect.objectContaining({ state: 'error' }));
    expect(adapter.calendarSaveMirrorAnchors).not.toHaveBeenCalled();
    const failedOperationId = attemptedOperationIds[1];

    failSecondDestination = false;
    const second = await bridgeCalendarMirrors({
      profileId: 'profile-1',
      calendars: [...calendars, secondCalendar],
      connectedOriginKeys: connectedToBoth,
      deviceId: 'device-2',
      adapter,
      now: '2026-07-24T08:01:00.000Z',
    });
    expect(second.appliedOperations).toBe(1);
    expect(second.statuses[0]).toEqual(expect.objectContaining({ state: 'ready' }));
    expect(attemptedOperationIds[attemptedOperationIds.length - 1]).toBe(failedOperationId);
    expect(adapter.calendarSaveMirrorAnchors).toHaveBeenCalledOnce();
    expect(storedItems.filter((item) => item.calendarId === secondCalendar.id)).toHaveLength(1);
  });
});
