import {
  syncHostedCalendars,
  type CalendarOriginSyncResult,
  type CalendarSyncAdapter,
  type CalendarSyncProgress,
  type HostedCalendarOrigin,
} from '../../../../src/lib/calendarSync';
import type { CalendarOperationFailure } from '../../../../src/types/calendar';
import {
  acknowledgeProfileCalendarOperations,
  applyProfileCalendarRemoteChanges,
  hostedCalendarRequest,
  listProfileCalendarFailedOperations,
  listProfileCalendarPendingOperations,
  listProfileCalendars,
  markProfileCalendarOperationFailed,
  readProfileCalendarSyncState,
  removeHostedCalendarCache,
  saveProfileCalendar,
  writeProfileCalendarSyncState,
} from '../mobileTauri';

const MOBILE_CALENDAR_PROFILE_KEY = 'collab-mobile-calendar-profile-id';

export interface MobileCalendarSyncResult {
  results: CalendarOriginSyncResult[];
  conflicts: CalendarOperationFailure[];
  cacheOrigins: HostedCalendarOrigin[];
}

const adapter: CalendarSyncAdapter = {
  hostedCalendarRequest,
  calendarSave: saveProfileCalendar,
  calendarReadSyncState: readProfileCalendarSyncState,
  calendarWriteSyncState: writeProfileCalendarSyncState,
  calendarListPendingOperations: listProfileCalendarPendingOperations,
  calendarAcknowledgeOperations: acknowledgeProfileCalendarOperations,
  calendarMarkOperationFailed: markProfileCalendarOperationFailed,
  calendarApplyRemoteChanges: applyProfileCalendarRemoteChanges,
};

export function mobileCalendarProfileId(): string {
  const existing = localStorage.getItem(MOBILE_CALENDAR_PROFILE_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(MOBILE_CALENDAR_PROFILE_KEY, created);
  return created;
}

export async function syncMobileCalendars(
  origins: HostedCalendarOrigin[],
  onProgress?: (progress: CalendarSyncProgress) => void,
): Promise<MobileCalendarSyncResult> {
  const profileId = mobileCalendarProfileId();
  const calendars = await listProfileCalendars(profileId);
  const results = await syncHostedCalendars(profileId, origins, calendars, onProgress, adapter);
  const conflicts = await listProfileCalendarFailedOperations(profileId);
  const cacheOrigins = await listMobileCalendarCacheOrigins();
  return { results, conflicts, cacheOrigins };
}

export async function listMobileCalendarCacheOrigins(): Promise<HostedCalendarOrigin[]> {
  const calendars = await listProfileCalendars(mobileCalendarProfileId());
  return Array.from(new Map(calendars.flatMap((calendar) => (
    calendar.location.kind === 'hosted'
      ? [[`${calendar.location.serverUrl}::${calendar.location.userId}`, {
          serverUrl: calendar.location.serverUrl,
          userId: calendar.location.userId,
        }] as const]
      : []
  ))).values());
}

export async function removeMobileCalendarCache(origin: HostedCalendarOrigin): Promise<void> {
  await removeHostedCalendarCache(
    mobileCalendarProfileId(),
    origin.serverUrl,
    origin.userId,
  );
}
