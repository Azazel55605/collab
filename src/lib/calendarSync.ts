import { tauriCommands } from './tauri';
import { isLikelyConnectivityError } from './vaultReplica';
import {
  normalizeCalendarDefinition,
  normalizeCalendarItem,
  type CalendarChangesPage,
  type CalendarDefinition,
  type CalendarLocation,
  type CalendarOperation,
  type CalendarRemoteChange,
  type CalendarSyncState,
} from '../types/calendar';

const CHANGE_PAGE_SIZE = 500;
const OPERATION_BATCH_SIZE = 500;
const MAX_CHANGE_PAGES_PER_PASS = 100;

export interface HostedCalendarOrigin {
  serverUrl: string;
  userId: string;
}

export type CalendarSyncPhase = 'discovering' | 'uploading' | 'downloading' | 'complete' | 'error';

export interface CalendarSyncProgress {
  originKey: string;
  serverUrl: string;
  phase: CalendarSyncPhase;
  processedItems: number;
  totalItems?: number;
}

export type CalendarSyncProgressListener = (progress: CalendarSyncProgress) => void;

export interface CalendarSyncAdapter {
  hostedCalendarRequest<T>(serverUrl: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T>;
  calendarSave(profileId: string, calendar: CalendarDefinition): Promise<void>;
  calendarReadSyncState(profileId: string, originKey: string): Promise<CalendarSyncState | null>;
  calendarWriteSyncState(profileId: string, state: CalendarSyncState): Promise<void>;
  calendarListPendingOperations(profileId: string): Promise<CalendarOperation[]>;
  calendarAcknowledgeOperations(profileId: string, clientOperationIds: string[]): Promise<void>;
  calendarMarkOperationFailed(profileId: string, clientOperationId: string, error: string, attemptedAt: string): Promise<void>;
  calendarApplyRemoteChanges(profileId: string, changes: CalendarRemoteChange[], state: CalendarSyncState): Promise<void>;
}

export interface CalendarOriginSyncResult {
  originKey: string;
  serverUrl: string;
  appliedChanges: number;
  replayedOperations: number;
  failedOperations: number;
  completedAt: string;
  error?: string;
}

export function hostedCalendarOriginKey(origin: HostedCalendarOrigin): string {
  return `${origin.serverUrl.replace(/\/$/, '')}::${origin.userId}`;
}

export function normalizeHostedCalendarOrigins(
  origins: HostedCalendarOrigin[],
): HostedCalendarOrigin[] {
  return Array.from(new Map(origins.map((origin) => {
    const normalized = { ...origin, serverUrl: origin.serverUrl.replace(/\/$/, '') };
    return [hostedCalendarOriginKey(normalized), normalized];
  })).values()).sort((left, right) => (
    hostedCalendarOriginKey(left).localeCompare(hostedCalendarOriginKey(right))
  ));
}

function operationCalendarId(operation: CalendarOperation): string | undefined {
  switch (operation.mutation.type) {
    case 'createCalendar':
    case 'updateCalendar':
      return operation.mutation.calendar.id;
    case 'deleteCalendar':
    case 'deleteItem':
      return operation.mutation.calendarId;
    case 'upsertItem':
      return operation.mutation.item.calendarId;
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

async function replayOperationBatch(
  profileId: string,
  serverUrl: string,
  operations: CalendarOperation[],
  adapter: CalendarSyncAdapter,
  onSettled: (count: number) => void,
): Promise<{ replayedOperations: number; failedOperations: number }> {
  if (operations.length === 0) return { replayedOperations: 0, failedOperations: 0 };
  try {
    await adapter.hostedCalendarRequest(
      serverUrl,
      'POST',
      '/api/v1/calendars/operations',
      { operations },
    );
    await adapter.calendarAcknowledgeOperations(
      profileId,
      operations.map((operation) => operation.clientOperationId),
    );
    onSettled(operations.length);
    return { replayedOperations: operations.length, failedOperations: 0 };
  } catch (error) {
    if (isLikelyConnectivityError(error)) throw error;
    if (operations.length > 1) {
      const middle = Math.ceil(operations.length / 2);
      const first = await replayOperationBatch(profileId, serverUrl, operations.slice(0, middle), adapter, onSettled);
      const second = await replayOperationBatch(profileId, serverUrl, operations.slice(middle), adapter, onSettled);
      return {
        replayedOperations: first.replayedOperations + second.replayedOperations,
        failedOperations: first.failedOperations + second.failedOperations,
      };
    }
    await adapter.calendarMarkOperationFailed(
      profileId,
      operations[0].clientOperationId,
      errorMessage(error),
      new Date().toISOString(),
    );
    onSettled(1);
    return { replayedOperations: 0, failedOperations: 1 };
  }
}

function hostedLocation(origin: HostedCalendarOrigin): CalendarLocation {
  return { kind: 'hosted', serverUrl: origin.serverUrl, userId: origin.userId };
}

function normalizeRemoteCalendar(value: unknown, origin: HostedCalendarOrigin): CalendarDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The server returned an invalid calendar definition.');
  }
  const location = (value as { location?: unknown }).location;
  if (location && typeof location === 'object' && !Array.isArray(location)
    && (location as { kind?: unknown }).kind === 'kanban') {
    const originKey = (location as { originKey?: unknown }).originKey;
    if (typeof originKey !== 'string' || !originKey.trim()) {
      throw new Error('The server returned an invalid Kanban calendar origin.');
    }
    return normalizeCalendarDefinition({
      ...value,
      location: {
        kind: 'kanban',
        originKey: `${origin.serverUrl.replace(/\/$/, '')}::${originKey}`,
      },
      readOnly: true,
    });
  }
  return normalizeCalendarDefinition({ ...value, location: hostedLocation(origin) });
}

function normalizeRemoteChange(
  change: CalendarRemoteChange,
  origin: HostedCalendarOrigin,
): CalendarRemoteChange {
  if (change.operation !== 'upsert') return change;
  if (change.entityType === 'calendar') {
    return { ...change, payload: normalizeRemoteCalendar(change.payload, origin) };
  }
  const item = normalizeCalendarItem(change.payload);
  if (item.sourceBinding?.kind !== 'kanban') return { ...change, payload: item };
  return {
    ...change,
    payload: {
      ...item,
      sourceBinding: {
        ...item.sourceBinding,
        serverUrl: origin.serverUrl.replace(/\/$/, ''),
      },
    },
  };
}

async function discoverCalendars(
  profileId: string,
  origin: HostedCalendarOrigin,
  adapter: CalendarSyncAdapter,
): Promise<CalendarDefinition[]> {
  const values = await adapter.hostedCalendarRequest<unknown[]>(
    origin.serverUrl,
    'GET',
    '/api/v1/calendars',
  );
  const calendars = values.map((value) => normalizeRemoteCalendar(value, origin));
  for (const calendar of calendars) {
    await adapter.calendarSave(profileId, calendar);
  }
  return calendars;
}

export async function syncHostedCalendarOrigin(
  profileId: string,
  origin: HostedCalendarOrigin,
  cachedCalendars: CalendarDefinition[],
  onProgress?: CalendarSyncProgressListener,
  adapter: CalendarSyncAdapter = tauriCommands,
): Promise<CalendarOriginSyncResult> {
  const originKey = hostedCalendarOriginKey(origin);
  const report = (phase: CalendarSyncPhase, processedItems: number, totalItems?: number) => {
    onProgress?.({ originKey, serverUrl: origin.serverUrl, phase, processedItems, totalItems });
  };
  report('discovering', 0);
  let cursor = 0;
  let appliedChanges = 0;
  let replayedOperations = 0;
  let failedOperations = 0;
  try {
    cursor = Number.parseInt(
      (await adapter.calendarReadSyncState(profileId, originKey))?.cursor ?? '0',
      10,
    );
    if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
    const discovered = await discoverCalendars(profileId, origin, adapter);
    const calendarIds = new Set([
      ...discovered.map((calendar) => calendar.id),
      ...cachedCalendars
        .filter((calendar) => calendar.location.kind === 'hosted'
          && hostedCalendarOriginKey(calendar.location) === originKey)
        .map((calendar) => calendar.id),
    ]);
    const pending = (await adapter.calendarListPendingOperations(profileId))
      .filter((operation) => {
        const calendarId = operationCalendarId(operation);
        return calendarId != null && calendarIds.has(calendarId);
      });
    let settledOperations = 0;
    report('uploading', 0, pending.length);
    for (const batch of chunks(pending, OPERATION_BATCH_SIZE)) {
      const replay = await replayOperationBatch(profileId, origin.serverUrl, batch, adapter, (count) => {
        settledOperations += count;
        report('uploading', settledOperations, pending.length);
      });
      replayedOperations += replay.replayedOperations;
      failedOperations += replay.failedOperations;
    }

    if (failedOperations > 0) {
      const message = `${failedOperations} calendar change${failedOperations === 1 ? '' : 's'} need attention.`;
      report('error', settledOperations, pending.length);
      await adapter.calendarWriteSyncState(profileId, {
        originKey,
        cursor: String(cursor),
        lastError: message,
      });
      return {
        originKey,
        serverUrl: origin.serverUrl,
        appliedChanges,
        replayedOperations,
        failedOperations,
        completedAt: new Date().toISOString(),
        error: message,
      };
    }

    report('downloading', 0);
    for (let pageIndex = 0; pageIndex < MAX_CHANGE_PAGES_PER_PASS; pageIndex += 1) {
      const page = await adapter.hostedCalendarRequest<CalendarChangesPage>(
        origin.serverUrl,
        'GET',
        `/api/v1/calendars/changes?cursor=${cursor}&limit=${CHANGE_PAGE_SIZE}`,
      );
      if (!Number.isSafeInteger(page.cursor) || page.cursor < cursor) {
        throw new Error('The server returned an invalid calendar change cursor.');
      }
      if (page.hasMore && (page.changes.length === 0 || page.cursor === cursor)) {
        throw new Error('The server returned a non-advancing calendar change page.');
      }
      const changes = page.changes.map((change) => normalizeRemoteChange(change, origin));
      cursor = page.cursor;
      const state: CalendarSyncState = {
        originKey,
        cursor: String(cursor),
        lastSyncedAt: new Date().toISOString(),
      };
      await adapter.calendarApplyRemoteChanges(profileId, changes, state);
      appliedChanges += changes.length;
      report('downloading', appliedChanges);
      if (!page.hasMore) break;
      if (pageIndex === MAX_CHANGE_PAGES_PER_PASS - 1) {
        throw new Error('Calendar sync reached its bounded page limit.');
      }
    }
    report('complete', replayedOperations + appliedChanges, replayedOperations + appliedChanges);
    return {
      originKey,
      serverUrl: origin.serverUrl,
      appliedChanges,
      replayedOperations,
      failedOperations,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report('error', replayedOperations + appliedChanges);
    await adapter.calendarWriteSyncState(profileId, {
      originKey,
      cursor: String(cursor),
      lastError: message,
    }).catch(() => {});
    return {
      originKey,
      serverUrl: origin.serverUrl,
      appliedChanges,
      replayedOperations,
      failedOperations,
      completedAt: new Date().toISOString(),
      error: message,
    };
  }
}

export async function syncHostedCalendars(
  profileId: string,
  origins: HostedCalendarOrigin[],
  cachedCalendars: CalendarDefinition[],
  onProgress?: CalendarSyncProgressListener,
  adapter: CalendarSyncAdapter = tauriCommands,
): Promise<CalendarOriginSyncResult[]> {
  const uniqueOrigins = normalizeHostedCalendarOrigins(origins);
  return Promise.all(uniqueOrigins.map((origin) => (
    syncHostedCalendarOrigin(profileId, origin, cachedCalendars, onProgress, adapter)
  )));
}
