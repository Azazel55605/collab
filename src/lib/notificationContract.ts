import {
  NOTIFICATION_CONTRACT_VERSION,
  type ForegroundNotificationDecision,
  type NotificationAction,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationDestination,
  type NotificationEnvelope,
  type NotificationForegroundContext,
  type NotificationKind,
  type NotificationPreferences,
  type NotificationPresentation,
  type NotificationPrivacyLevel,
  type NotificationPushInvalidation,
  type PushInvalidationCategory,
} from '../types/notification';

const MAX_ACCOUNT_KEY_LENGTH = 160;
const MAX_SOURCE_ID_LENGTH = 512;
const MAX_DELIVERY_KEY_LENGTH = 512;
const MAX_OCCURRENCE_KEY_LENGTH = 512;
const MAX_TITLE_LENGTH = 500;
const MAX_BODY_LENGTH = 4_096;
const MAX_ACTIONS = 4;
const MAX_SNOOZE_MINUTES = 10_080;
const PUSH_ACCOUNT_KEY = /^[A-Za-z0-9_-]{16,160}$/;
const PUSH_OPAQUE_VALUE = /^[A-Za-z0-9._~-]{1,256}$/;

interface NotificationKindPolicy {
  category: NotificationCategory;
  channel: NotificationChannel;
  defaultPrivacy: NotificationPrivacyLevel;
  hiddenTitle: string;
  allowedActions: ReadonlySet<NotificationAction['kind']>;
}

const OPEN_DISMISS = new Set<NotificationAction['kind']>(['open', 'dismiss']);
const REMINDER_ACTIONS = new Set<NotificationAction['kind']>([
  'open',
  'dismiss',
  'snooze',
]);

export const NOTIFICATION_KIND_POLICIES: Record<NotificationKind, NotificationKindPolicy> = {
  'calendar.event-reminder': {
    category: 'calendar.reminder',
    channel: 'calendar',
    defaultPrivacy: 'title-only',
    hiddenTitle: 'Calendar reminder',
    allowedActions: REMINDER_ACTIONS,
  },
  'calendar.task-reminder': {
    category: 'calendar.reminder',
    channel: 'calendar',
    defaultPrivacy: 'title-only',
    hiddenTitle: 'Task reminder',
    allowedActions: new Set([...REMINDER_ACTIONS, 'calendar.task.complete']),
  },
  'calendar.birthday-reminder': {
    category: 'calendar.reminder',
    channel: 'calendar',
    defaultPrivacy: 'title-only',
    hiddenTitle: 'Birthday reminder',
    allowedActions: REMINDER_ACTIONS,
  },
  'calendar.invitation': {
    category: 'calendar.invitation',
    channel: 'calendar',
    defaultPrivacy: 'title-only',
    hiddenTitle: 'Calendar invitation',
    allowedActions: new Set([
      ...OPEN_DISMISS,
      'calendar.invitation.respond',
    ]),
  },
  'calendar.invitation-update': {
    category: 'calendar.invitation',
    channel: 'calendar',
    defaultPrivacy: 'title-only',
    hiddenTitle: 'Calendar invitation updated',
    allowedActions: OPEN_DISMISS,
  },
  'collaboration.message': {
    category: 'collaboration.message',
    channel: 'collaboration',
    defaultPrivacy: 'title-only',
    hiddenTitle: 'New collaboration message',
    allowedActions: OPEN_DISMISS,
  },
  'collaboration.mention': {
    category: 'collaboration.mention',
    channel: 'collaboration',
    defaultPrivacy: 'title-only',
    hiddenTitle: 'New mention',
    allowedActions: OPEN_DISMISS,
  },
  'sync.conflict': {
    category: 'sync.action-required',
    channel: 'sync',
    defaultPrivacy: 'full',
    hiddenTitle: 'Sync needs attention',
    allowedActions: new Set([...OPEN_DISMISS, 'sync.retry']),
  },
  'sync.authentication-required': {
    category: 'sync.action-required',
    channel: 'sync',
    defaultPrivacy: 'full',
    hiddenTitle: 'Sign in required',
    allowedActions: new Set([...OPEN_DISMISS, 'server.reauthenticate']),
  },
  'sync.permission-denied': {
    category: 'sync.action-required',
    channel: 'sync',
    defaultPrivacy: 'full',
    hiddenTitle: 'Sync permission changed',
    allowedActions: OPEN_DISMISS,
  },
  'transfer.complete': {
    category: 'transfer.complete',
    channel: 'transfers',
    defaultPrivacy: 'full',
    hiddenTitle: 'Transfer complete',
    allowedActions: OPEN_DISMISS,
  },
};

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: true,
  lockScreenPrivacy: 'title-only',
  categoryEnabled: {
    'calendar.reminder': true,
    'calendar.invitation': true,
    'collaboration.message': true,
    'collaboration.mention': true,
    'sync.action-required': true,
    'transfer.complete': true,
  },
  scopeEnabled: {},
  quietHours: null,
  allowTimeSensitiveDuringQuietHours: true,
  batchNotifications: true,
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, label, maxLength);
}

function requireIsoInstant(value: unknown, label: string): string {
  const result = requireString(value, label, 64);
  if (!Number.isFinite(Date.parse(result))) {
    throw new Error(`${label} must be an ISO date-time.`);
  }
  return result;
}

function optionalIsoInstant(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireIsoInstant(value, label);
}

function optionalServerUrl(value: unknown): string | undefined {
  const serverUrl = optionalString(value, 'Notification server URL', 2_048);
  if (!serverUrl) return undefined;
  try {
    const parsed = new URL(serverUrl);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      throw new Error();
    }
    return parsed.origin;
  } catch {
    throw new Error('Notification server URL must be an HTTP origin.');
  }
}

function kindPolicy(kind: unknown): [NotificationKind, NotificationKindPolicy] {
  if (typeof kind !== 'string' || !(kind in NOTIFICATION_KIND_POLICIES)) {
    throw new Error('Notification kind is not supported.');
  }
  const normalized = kind as NotificationKind;
  return [normalized, NOTIFICATION_KIND_POLICIES[normalized]];
}

function validateDestination(value: unknown): NotificationDestination {
  const destination = requireRecord(value, 'Notification destination');
  switch (destination.kind) {
    case 'calendar-item':
      return {
        kind: 'calendar-item',
        profileId: requireString(destination.profileId, 'Calendar profile ID', 160),
        calendarId: requireString(destination.calendarId, 'Calendar ID', 160),
        itemId: requireString(destination.itemId, 'Calendar item ID', 160),
        ...(optionalString(destination.occurrenceKey, 'Occurrence key', MAX_OCCURRENCE_KEY_LENGTH)
          ? { occurrenceKey: destination.occurrenceKey as string }
          : {}),
      };
    case 'calendar-invitations':
    case 'notification-center':
      return { kind: destination.kind };
    case 'vault-chat':
      return {
        kind: 'vault-chat',
        vaultId: requireString(destination.vaultId, 'Vault ID', 160),
      };
    case 'vault-file':
      return {
        kind: 'vault-file',
        vaultId: requireString(destination.vaultId, 'Vault ID', 160),
        fileId: requireString(destination.fileId, 'File ID', 160),
      };
    case 'sync-recovery':
      return {
        kind: 'sync-recovery',
        ...(optionalString(destination.vaultId, 'Vault ID', 160)
          ? { vaultId: destination.vaultId as string }
          : {}),
        ...(optionalString(destination.operationId, 'Operation ID', 160)
          ? { operationId: destination.operationId as string }
          : {}),
      };
    case 'settings':
      if (!['notifications', 'servers', 'background'].includes(String(destination.section))) {
        throw new Error('Notification settings destination is not supported.');
      }
      return {
        kind: 'settings',
        section: destination.section as 'notifications' | 'servers' | 'background',
      };
    default:
      throw new Error('Notification destination is not supported.');
  }
}

function validateAction(
  value: unknown,
  policy: NotificationKindPolicy,
): NotificationAction {
  const action = requireRecord(value, 'Notification action');
  if (typeof action.kind !== 'string' || !policy.allowedActions.has(action.kind as NotificationAction['kind'])) {
    throw new Error('Notification action is not allowed for this notification kind.');
  }
  switch (action.kind) {
    case 'snooze': {
      const minutes = Number(action.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SNOOZE_MINUTES) {
        throw new Error(`Notification snooze must be between 1 and ${MAX_SNOOZE_MINUTES} minutes.`);
      }
      return { kind: 'snooze', minutes };
    }
    case 'calendar.invitation.respond':
      if (!['accepted', 'tentative', 'declined'].includes(String(action.response))) {
        throw new Error('Calendar invitation response is not supported.');
      }
      return {
        kind: 'calendar.invitation.respond',
        response: action.response as 'accepted' | 'tentative' | 'declined',
      };
    default:
      return { kind: action.kind } as NotificationAction;
  }
}

export function createNotificationId(input: {
  category: NotificationCategory;
  accountKey: string;
  sourceId: string;
  occurrenceKey?: string;
  deliveryKey: string;
}): string {
  const parts = [
    input.category,
    input.accountKey,
    input.sourceId,
    input.occurrenceKey ?? '-',
    input.deliveryKey,
  ];
  return `notification:v${NOTIFICATION_CONTRACT_VERSION}:${parts.map(encodeURIComponent).join(':')}`;
}

export function validateNotificationEnvelope(value: unknown): NotificationEnvelope {
  const input = requireRecord(value, 'Notification envelope');
  if (input.schemaVersion !== NOTIFICATION_CONTRACT_VERSION) {
    throw new Error('Notification contract version is not supported.');
  }
  const [kind, policy] = kindPolicy(input.kind);
  if (input.category !== policy.category || input.channel !== policy.channel) {
    throw new Error('Notification category/channel does not match its kind.');
  }
  const accountKey = requireString(input.accountKey, 'Notification account key', MAX_ACCOUNT_KEY_LENGTH);
  const serverUrl = optionalServerUrl(input.serverUrl);
  const sourceId = requireString(input.sourceId, 'Notification source ID', MAX_SOURCE_ID_LENGTH);
  const occurrenceKey = optionalString(
    input.occurrenceKey,
    'Notification occurrence key',
    MAX_OCCURRENCE_KEY_LENGTH,
  );
  const deliveryKey = requireString(
    input.deliveryKey,
    'Notification delivery key',
    MAX_DELIVERY_KEY_LENGTH,
  );
  const id = requireString(input.id, 'Notification ID', 2_048);
  const expectedId = createNotificationId({
    category: policy.category,
    accountKey,
    sourceId,
    occurrenceKey,
    deliveryKey,
  });
  if (id !== expectedId) {
    throw new Error('Notification ID does not match its stable identity fields.');
  }
  if (!['full', 'title-only', 'hidden'].includes(String(input.privacy))) {
    throw new Error('Notification privacy level is not supported.');
  }
  if (!['normal', 'time-sensitive'].includes(String(input.priority))) {
    throw new Error('Notification priority is not supported.');
  }
  if (!Array.isArray(input.actions) || input.actions.length > MAX_ACTIONS) {
    throw new Error(`Notification actions must contain at most ${MAX_ACTIONS} entries.`);
  }
  const actions = input.actions.map((action) => validateAction(action, policy));
  if (new Set(actions.map((action) => action.kind)).size !== actions.length) {
    throw new Error('Notification actions must be unique.');
  }
  if (typeof input.requiresInbox !== 'boolean') {
    throw new Error('Notification inbox policy must be a boolean.');
  }

  return {
    schemaVersion: NOTIFICATION_CONTRACT_VERSION,
    id,
    category: policy.category,
    kind,
    channel: policy.channel,
    accountKey,
    ...(serverUrl ? { serverUrl } : {}),
    sourceId,
    ...(occurrenceKey ? { occurrenceKey } : {}),
    deliveryKey,
    createdAt: requireIsoInstant(input.createdAt, 'Notification creation time'),
    ...(optionalIsoInstant(input.scheduledAt, 'Notification schedule time')
      ? { scheduledAt: input.scheduledAt as string }
      : {}),
    ...(optionalIsoInstant(input.expiresAt, 'Notification expiry time')
      ? { expiresAt: input.expiresAt as string }
      : {}),
    title: requireString(input.title, 'Notification title', MAX_TITLE_LENGTH),
    ...(optionalString(input.body, 'Notification body', MAX_BODY_LENGTH)
      ? { body: input.body as string }
      : {}),
    privacy: input.privacy as NotificationPrivacyLevel,
    priority: input.priority as 'normal' | 'time-sensitive',
    destination: validateDestination(input.destination),
    actions,
    requiresInbox: input.requiresInbox,
  };
}

export function defaultPrivacyForNotification(
  kind: NotificationKind,
): NotificationPrivacyLevel {
  return NOTIFICATION_KIND_POLICIES[kind].defaultPrivacy;
}

export function presentNotification(
  notification: NotificationEnvelope,
  requestedPrivacy: NotificationPrivacyLevel = notification.privacy,
): NotificationPresentation {
  const policy = NOTIFICATION_KIND_POLICIES[notification.kind];
  const privacyRank: Record<NotificationPrivacyLevel, number> = {
    hidden: 0,
    'title-only': 1,
    full: 2,
  };
  const privacy = privacyRank[requestedPrivacy] < privacyRank[notification.privacy]
    ? requestedPrivacy
    : notification.privacy;
  if (privacy === 'hidden') {
    return {
      title: policy.hiddenTitle,
      channel: notification.channel,
      priority: notification.priority,
    };
  }
  return {
    title: notification.title,
    ...(privacy === 'full' && notification.body ? { body: notification.body } : {}),
    channel: notification.channel,
    priority: notification.priority,
  };
}

export function notificationDestinationKey(destination: NotificationDestination): string {
  switch (destination.kind) {
    case 'calendar-item':
      return [
        destination.kind,
        destination.profileId,
        destination.calendarId,
        destination.itemId,
        destination.occurrenceKey ?? '-',
      ].join(':');
    case 'vault-chat':
      return `${destination.kind}:${destination.vaultId}`;
    case 'vault-file':
      return `${destination.kind}:${destination.vaultId}:${destination.fileId}`;
    case 'sync-recovery':
      return `${destination.kind}:${destination.vaultId ?? '-'}:${destination.operationId ?? '-'}`;
    case 'settings':
      return `${destination.kind}:${destination.section}`;
    default:
      return destination.kind;
  }
}

export function decideForegroundNotificationDelivery(
  notification: NotificationEnvelope,
  context: NotificationForegroundContext,
): ForegroundNotificationDecision {
  if (!context.appVisible) return 'native';
  if (
    context.activeDestination
    && notificationDestinationKey(context.activeDestination)
      === notificationDestinationKey(notification.destination)
  ) {
    return 'suppress';
  }
  return 'in-app';
}

export function validatePushInvalidation(value: unknown): NotificationPushInvalidation {
  const input = requireRecord(value, 'Push invalidation');
  const allowedKeys = new Set([
    'schemaVersion',
    'invalidationId',
    'accountKey',
    'category',
    'cursor',
    'createdAt',
  ]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error('Push invalidation contains private or unsupported fields.');
  }
  if (input.schemaVersion !== NOTIFICATION_CONTRACT_VERSION) {
    throw new Error('Push invalidation version is not supported.');
  }
  const categories: PushInvalidationCategory[] = [
    'calendar.invitation',
    'collaboration.message',
    'collaboration.mention',
    'sync.action-required',
  ];
  if (!categories.includes(input.category as PushInvalidationCategory)) {
    throw new Error('Push invalidation category is not supported.');
  }
  const accountKey = requireString(input.accountKey, 'Push account key', MAX_ACCOUNT_KEY_LENGTH);
  const invalidationId = requireString(input.invalidationId, 'Push invalidation ID', 256);
  const cursor = optionalString(input.cursor, 'Push cursor', 256);
  if (
    !PUSH_ACCOUNT_KEY.test(accountKey)
    || !PUSH_OPAQUE_VALUE.test(invalidationId)
    || (cursor && !PUSH_OPAQUE_VALUE.test(cursor))
  ) {
    throw new Error('Push invalidation identifiers must be opaque.');
  }
  return {
    schemaVersion: NOTIFICATION_CONTRACT_VERSION,
    invalidationId,
    accountKey,
    category: input.category as PushInvalidationCategory,
    ...(cursor ? { cursor } : {}),
    createdAt: requireIsoInstant(input.createdAt, 'Push invalidation creation time'),
  };
}
