import { describe, expect, it } from 'vitest';

import type { NotificationEnvelope } from '../types/notification';

import {
  createNotificationId,
  decideForegroundNotificationDelivery,
  defaultPrivacyForNotification,
  notificationDestinationKey,
  presentNotification,
  validateNotificationEnvelope,
  validatePushInvalidation,
} from './notificationContract';

function reminder(): NotificationEnvelope {
  const identity = {
    category: 'calendar.reminder' as const,
    accountKey: 'profile-local-1',
    sourceId: 'item-1',
    occurrenceKey: '2026-08-01T10:00:00Z',
    deliveryKey: 'item-1:0:2026-08-01T09:45:00Z',
  };
  return {
    schemaVersion: 1,
    id: createNotificationId(identity),
    ...identity,
    kind: 'calendar.event-reminder',
    channel: 'calendar',
    createdAt: '2026-07-28T10:00:00Z',
    scheduledAt: '2026-08-01T09:45:00Z',
    title: 'Project review',
    body: 'Bring the current release notes.',
    privacy: 'title-only',
    priority: 'time-sensitive',
    destination: {
      kind: 'calendar-item',
      profileId: 'profile-local-1',
      calendarId: 'calendar-1',
      itemId: 'item-1',
      occurrenceKey: '2026-08-01T10:00:00Z',
    },
    actions: [{ kind: 'open' }, { kind: 'snooze', minutes: 10 }, { kind: 'dismiss' }],
    requiresInbox: true,
  };
}

describe('notification contract', () => {
  it('builds stable IDs from account, source, occurrence, and delivery identity', () => {
    const notification = reminder();
    expect(createNotificationId(notification)).toBe(notification.id);
    expect(createNotificationId({ ...notification, deliveryKey: 'second-reminder' })).not.toBe(
      notification.id,
    );
  });

  it('validates a bounded typed notification envelope', () => {
    expect(validateNotificationEnvelope(reminder())).toEqual(reminder());
    expect(
      validateNotificationEnvelope({
        ...reminder(),
        serverUrl: 'https://collab.example.test',
      }).serverUrl,
    ).toBe('https://collab.example.test');
    expect(() =>
      validateNotificationEnvelope({
        ...reminder(),
        serverUrl: 'https://collab.example.test/private',
      }),
    ).toThrow(/HTTP origin/);
  });

  it('rejects category mismatches and actions not allowed for the kind', () => {
    expect(() =>
      validateNotificationEnvelope({
        ...reminder(),
        channel: 'sync',
      }),
    ).toThrow(/category\/channel/);
    expect(() =>
      validateNotificationEnvelope({
        ...reminder(),
        actions: [{ kind: 'sync.retry' }],
      }),
    ).toThrow(/not allowed/);
  });

  it('enforces title-only and hidden lock-screen presentation', () => {
    const notification = reminder();
    expect(defaultPrivacyForNotification(notification.kind)).toBe('title-only');
    expect(presentNotification({ ...notification, privacy: 'full' }, 'full')).toMatchObject({
      title: 'Project review',
      body: 'Bring the current release notes.',
    });
    expect(presentNotification(notification, 'title-only')).toEqual({
      title: 'Project review',
      channel: 'calendar',
      priority: 'time-sensitive',
    });
    expect(presentNotification(notification, 'hidden')).toEqual({
      title: 'Calendar reminder',
      channel: 'calendar',
      priority: 'time-sensitive',
    });
    expect(presentNotification({ ...notification, privacy: 'hidden' }, 'full')).toEqual({
      title: 'Calendar reminder',
      channel: 'calendar',
      priority: 'time-sensitive',
    });
  });

  it('suppresses only the exact visible destination', () => {
    const notification = reminder();
    expect(decideForegroundNotificationDelivery(notification, { appVisible: false })).toBe(
      'native',
    );
    expect(
      decideForegroundNotificationDelivery(notification, {
        appVisible: true,
        activeDestination: { kind: 'calendar-invitations' },
      }),
    ).toBe('in-app');
    expect(
      decideForegroundNotificationDelivery(notification, {
        appVisible: true,
        activeDestination: notification.destination,
      }),
    ).toBe('suppress');
    expect(notificationDestinationKey(notification.destination)).toContain(
      'calendar-item:profile-local-1',
    );
  });

  it('accepts only opaque, content-free third-party invalidations', () => {
    const invalidation = {
      schemaVersion: 1,
      invalidationId: 'invalidation_01JABCDEF',
      accountKey: 'acct_01JABCDEFGHIJK',
      category: 'calendar.invitation',
      cursor: 'cursor_42',
      createdAt: '2026-07-28T10:00:00Z',
    };
    expect(validatePushInvalidation(invalidation)).toEqual(invalidation);
    expect(() =>
      validatePushInvalidation({
        ...invalidation,
        title: 'Private meeting',
      }),
    ).toThrow(/private or unsupported fields/);
    expect(() =>
      validatePushInvalidation({
        ...invalidation,
        accountKey: 'https://collab.example.test/users/alice',
      }),
    ).toThrow(/opaque/);
  });
});
