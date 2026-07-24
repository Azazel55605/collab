import {
  bridgeCalendarMirrors,
  resolveCalendarMirrorConflict,
  type CalendarMirrorAdapter,
} from '../../../../src/lib/calendarMirroring';
import {
  hostedCalendarOriginKey,
  syncHostedCalendars,
  type CalendarOriginSyncResult,
  type CalendarSyncAdapter,
  type CalendarSyncProgress,
  type HostedCalendarOrigin,
} from '../../../../src/lib/calendarSync';
import type {
  CalendarMirrorGroup,
  CalendarMirrorConflict,
  CalendarMirrorGroupStatus,
  CalendarMirrorProgress,
  CalendarOperationFailure,
} from '../../../../src/types/calendar';
import {
  acknowledgeProfileCalendarOperations,
  applyProfileCalendarRemoteChanges,
  hostedCalendarRequest,
  listProfileCalendarFailedOperations,
  listProfileCalendarMirrorAnchors,
  listProfileCalendarMirrorConflicts,
  listProfileCalendarMirrorGroups,
  listProfileCalendarMirrorItems,
  listProfileCalendarPendingOperations,
  listProfileCalendars,
  markProfileCalendarOperationFailed,
  readProfileCalendarSyncState,
  removeHostedCalendarCache,
  saveProfileCalendar,
  saveProfileCalendarMirrorAnchors,
  saveProfileCalendarMirrorConflict,
  deleteProfileCalendarItem,
  upsertProfileCalendarItem,
  writeProfileCalendarSyncState,
} from '../mobileTauri';

const MOBILE_CALENDAR_PROFILE_KEY = 'collab-mobile-calendar-profile-id';

export interface MobileCalendarSyncResult {
  results: CalendarOriginSyncResult[];
  conflicts: CalendarOperationFailure[];
  mirrorConflicts: CalendarMirrorConflict[];
  mirrorStatuses: CalendarMirrorGroupStatus[];
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

const mirrorAdapter: CalendarMirrorAdapter = {
  calendarListMirrorGroups: listProfileCalendarMirrorGroups,
  calendarListMirrorAnchors: listProfileCalendarMirrorAnchors,
  calendarListMirrorConflicts: listProfileCalendarMirrorConflicts,
  calendarListMirrorItems: listProfileCalendarMirrorItems,
  calendarUpsertItem: upsertProfileCalendarItem,
  calendarDeleteItem: deleteProfileCalendarItem,
  calendarAcknowledgeOperations: acknowledgeProfileCalendarOperations,
  calendarSaveMirrorAnchors: saveProfileCalendarMirrorAnchors,
  calendarSaveMirrorConflict: saveProfileCalendarMirrorConflict,
};

function mobileMirrorDeviceId(): string {
  const key = 'collab-mobile-calendar-device-id';
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

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
  onMirrorProgress?: (progress: CalendarMirrorProgress) => void,
): Promise<MobileCalendarSyncResult> {
  const profileId = mobileCalendarProfileId();
  let calendars = await listProfileCalendars(profileId);
  let results = await syncHostedCalendars(profileId, origins, calendars, onProgress, adapter);
  calendars = await listProfileCalendars(profileId);
  const mirror = await bridgeCalendarMirrors({
    profileId,
    calendars,
    connectedOriginKeys: new Set(origins.map(hostedCalendarOriginKey)),
    deviceId: mobileMirrorDeviceId(),
    adapter: mirrorAdapter,
    onProgress: onMirrorProgress,
  });
  if (mirror.appliedOperations > 0) {
    results = await syncHostedCalendars(profileId, origins, calendars, onProgress, adapter);
  }
  const conflicts = await listProfileCalendarFailedOperations(profileId);
  const mirrorConflicts = await listProfileCalendarMirrorConflicts(profileId);
  const cacheOrigins = await listMobileCalendarCacheOrigins();
  return {
    results,
    conflicts,
    mirrorConflicts,
    mirrorStatuses: mirror.statuses,
    cacheOrigins,
  };
}

export async function resolveMobileCalendarMirrorConflict(
  group: CalendarMirrorGroup,
  conflict: CalendarMirrorConflict,
  chosenMemberId: string,
  origins: HostedCalendarOrigin[],
): Promise<void> {
  const profileId = mobileCalendarProfileId();
  await resolveCalendarMirrorConflict({
    profileId,
    group,
    conflict,
    chosenMemberId,
    calendars: await listProfileCalendars(profileId),
    connectedOriginKeys: new Set(origins.map(hostedCalendarOriginKey)),
    deviceId: mobileMirrorDeviceId(),
    adapter: mirrorAdapter,
  });
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
