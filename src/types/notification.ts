export const NOTIFICATION_CONTRACT_VERSION = 1 as const;

export type NotificationCategory =
  | 'calendar.reminder'
  | 'calendar.invitation'
  | 'collaboration.message'
  | 'collaboration.mention'
  | 'sync.action-required'
  | 'transfer.complete';

export type NotificationKind =
  | 'calendar.event-reminder'
  | 'calendar.task-reminder'
  | 'calendar.birthday-reminder'
  | 'calendar.invitation'
  | 'calendar.invitation-update'
  | 'collaboration.message'
  | 'collaboration.mention'
  | 'sync.conflict'
  | 'sync.authentication-required'
  | 'sync.permission-denied'
  | 'transfer.complete';

export type NotificationChannel =
  | 'calendar'
  | 'collaboration'
  | 'sync'
  | 'transfers';

export type NotificationPrivacyLevel = 'full' | 'title-only' | 'hidden';
export type NotificationPriority = 'normal' | 'time-sensitive';

export type NotificationDestination =
  | {
      kind: 'calendar-item';
      profileId: string;
      calendarId: string;
      itemId: string;
      occurrenceKey?: string;
    }
  | { kind: 'calendar-invitations' }
  | { kind: 'vault-chat'; vaultId: string }
  | { kind: 'vault-file'; vaultId: string; fileId: string }
  | { kind: 'sync-recovery'; vaultId?: string; operationId?: string }
  | {
      kind: 'settings';
      section: 'notifications' | 'servers' | 'background';
    }
  | { kind: 'notification-center' };

export type NotificationAction =
  | { kind: 'open' }
  | { kind: 'dismiss' }
  | { kind: 'snooze'; minutes: number }
  | { kind: 'calendar.task.complete' }
  | {
      kind: 'calendar.invitation.respond';
      response: 'accepted' | 'tentative' | 'declined';
    }
  | { kind: 'sync.retry' }
  | { kind: 'server.reauthenticate' };

export interface NotificationEnvelope {
  schemaVersion: typeof NOTIFICATION_CONTRACT_VERSION;
  id: string;
  category: NotificationCategory;
  kind: NotificationKind;
  channel: NotificationChannel;
  /** Stable opaque account/profile identifier. Never an access credential. */
  accountKey: string;
  sourceId: string;
  occurrenceKey?: string;
  /** Distinguishes multiple notices for one source/occurrence, such as reminders. */
  deliveryKey: string;
  createdAt: string;
  scheduledAt?: string;
  expiresAt?: string;
  title: string;
  body?: string;
  privacy: NotificationPrivacyLevel;
  priority: NotificationPriority;
  destination: NotificationDestination;
  actions: NotificationAction[];
  requiresInbox: boolean;
}

export type NotificationState =
  | 'scheduled'
  | 'ready'
  | 'delivered'
  | 'read'
  | 'dismissed'
  | 'cancelled'
  | 'failed';

export interface NotificationRecord {
  envelope: NotificationEnvelope;
  state: NotificationState;
  updatedAt: string;
  deliveredAt?: string;
  deliverySurface?: 'native' | 'in-app';
  readAt?: string;
  dismissedAt?: string;
  snoozedFromId?: string;
  failureMessage?: string;
  attemptCount: number;
  nextRetryAt?: string;
}

export interface NotificationReconcileResult {
  inserted: number;
  updated: number;
  cancelled: number;
}

export interface NotificationReconciliationRequest {
  profileId: string;
  category: NotificationCategory;
  requestedAt: string;
}

export interface NotificationActionToken {
  token: string;
  expiresAt: string;
}

export interface ConsumedNotificationAction {
  notificationId: string;
  action: NotificationAction;
}

export interface NotificationPermissionStatus {
  status: 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale' | 'unsupported';
  supported: boolean;
}

export interface NotificationPresentation {
  title: string;
  body?: string;
  channel: NotificationChannel;
  priority: NotificationPriority;
}

export type ForegroundNotificationDecision = 'native' | 'in-app' | 'suppress';

export interface NotificationForegroundContext {
  appVisible: boolean;
  activeDestination?: NotificationDestination;
}

export type PushInvalidationCategory =
  | 'calendar.invitation'
  | 'collaboration.message'
  | 'collaboration.mention'
  | 'sync.action-required';

/**
 * Privacy-minimal third-party push payload. Item IDs, titles, message content,
 * vault IDs, server URLs, destinations, and actions are fetched after auth.
 */
export interface NotificationPushInvalidation {
  schemaVersion: typeof NOTIFICATION_CONTRACT_VERSION;
  invalidationId: string;
  accountKey: string;
  category: PushInvalidationCategory;
  cursor?: string;
  createdAt: string;
}

export interface NotificationQuietHours {
  startMinute: number;
  endMinute: number;
  timeZone: string;
}

export interface NotificationPreferences {
  enabled: boolean;
  lockScreenPrivacy: NotificationPrivacyLevel;
  categoryEnabled: Record<NotificationCategory, boolean>;
  quietHours: NotificationQuietHours | null;
  allowTimeSensitiveDuringQuietHours: boolean;
}
