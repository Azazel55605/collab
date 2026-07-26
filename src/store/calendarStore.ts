import { create } from 'zustand';
import { tauriCommands } from '../lib/tauri';
import {
  syncHostedCalendars,
  hostedCalendarOriginKey,
  normalizeRemoteCalendar,
  type CalendarOriginSyncResult,
  type CalendarSyncProgress,
  type HostedCalendarOrigin,
} from '../lib/calendarSync';
import {
  bridgeCalendarMirrors,
  resolveCalendarMirrorConflict,
  validateCalendarMirrorGroup,
} from '../lib/calendarMirroring';
import { expandRecurringItem } from '../lib/calendarRecurrence';
import { previewCalendarIcsImport } from '../lib/calendarIcs';
import {
  planRecurringEdit,
  splitRecurrence,
  type CalendarRecurrenceEditScope,
} from '../lib/calendarRecurringEdit';
import {
  calendarItemRange,
  calendarTimeValueKey,
  createCalendarDefinition,
  normalizeCalendarDefinition,
  normalizeCalendarItem,
  queryCalendarItems,
  type CalendarDefinition,
  type CalendarEvent,
  type CalendarItem,
  type CalendarLocation,
  type CalendarMirrorConflict,
  type CalendarMirrorGroup,
  type CalendarMirrorGroupStatus,
  type CalendarMirrorProgress,
  type CalendarOperation,
  type CalendarOperationFailure,
  type CalendarSubscription,
} from '../types/calendar';
import { isSupportedTimeZone, systemTimeZone, useUiStore } from './uiStore';
import { writeThroughKanbanCalendarTask } from '../lib/kanbanCalendarProjection';
import { useVaultStore } from './vaultStore';

const DEVICE_ID_KEY = 'collab-calendar-device-id';
const profileInitializations = new Map<string, Promise<void>>();
const hostedSyncs = new Map<string, Promise<CalendarOriginSyncResult[]>>();
const activeHostedSyncs = new Map<string, number>();

interface HostedSubscriptionResult {
  calendar: CalendarDefinition;
  subscription: CalendarSubscription;
  warnings: string[];
}

function deviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, created);
  return created;
}

function defaultCalendarTimeZone(): string {
  const configured = useUiStore.getState().calendarDefaultTimeZone;
  return isSupportedTimeZone(configured) ? configured : systemTimeZone();
}

interface CalendarStoreState {
  profileId: string | null;
  calendars: CalendarDefinition[];
  subscriptions: CalendarSubscription[];
  sourceItems: CalendarItem[];
  items: CalendarItem[];
  visibleCalendarIds: string[];
  range: { from: string; to: string; includeUnscheduledTasks?: boolean } | null;
  loading: boolean;
  saving: boolean;
  syncing: boolean;
  syncResults: CalendarOriginSyncResult[];
  syncProgress: Record<string, CalendarSyncProgress>;
  conflicts: CalendarOperationFailure[];
  mirrorGroups: CalendarMirrorGroup[];
  mirrorConflicts: CalendarMirrorConflict[];
  mirrorStatuses: CalendarMirrorGroupStatus[];
  mirrorProgress: Record<string, CalendarMirrorProgress>;
  error: string | null;
  initialize: (profileId: string) => Promise<void>;
  loadRange: (from: string, to: string, includeUnscheduledTasks?: boolean) => Promise<void>;
  syncHosted: (origins: HostedCalendarOrigin[]) => Promise<CalendarOriginSyncResult[]>;
  retryConflict: (clientOperationId: string) => Promise<void>;
  discardConflict: (clientOperationId: string) => Promise<void>;
  removeHostedCache: (origin: HostedCalendarOrigin) => Promise<void>;
  searchItems: (query: string, limit?: number) => Promise<CalendarItem[]>;
  createSubscription: (
    name: string,
    color: string,
    feedUrl: string,
    location?: CalendarLocation,
  ) => Promise<CalendarSubscription>;
  refreshSubscription: (subscriptionId: string) => Promise<void>;
  refreshSubscriptions: (staleAfterMs?: number) => Promise<void>;
  deleteSubscription: (subscriptionId: string) => Promise<void>;
  listCalendarItems: (calendarId: string) => Promise<CalendarItem[]>;
  importItems: (calendarId: string, items: CalendarItem[]) => Promise<void>;
  setCalendarVisible: (calendarId: string, visible: boolean) => void;
  createCalendar: (name: string, color: string, location?: CalendarLocation) => Promise<CalendarDefinition>;
  updateCalendar: (
    calendarId: string,
    changes: Partial<Pick<CalendarDefinition, 'name' | 'color' | 'defaultTimeZone' | 'archived'>>,
  ) => Promise<CalendarDefinition>;
  createMirrorGroup: (name: string, calendarIds: string[]) => Promise<CalendarMirrorGroup>;
  updateMirrorGroup: (
    groupId: string,
    changes: Partial<Pick<CalendarMirrorGroup, 'name' | 'enabled'>>,
  ) => Promise<CalendarMirrorGroup>;
  deleteMirrorGroup: (groupId: string) => Promise<void>;
  resolveMirrorConflict: (
    conflictId: string,
    chosenMemberId: string,
    origins: HostedCalendarOrigin[],
  ) => Promise<void>;
  createEvent: (input: {
    calendarId: string;
    title: string;
    start: string;
    end: string;
    allDay: boolean;
    description?: string;
  }) => Promise<CalendarEvent>;
  saveItem: (item: CalendarItem, scope?: CalendarRecurrenceEditScope) => Promise<CalendarItem>;
  deleteItem: (item: CalendarItem, scope?: CalendarRecurrenceEditScope) => Promise<void>;
  clearError: () => void;
}

function operationFor(item: CalendarItem, expectedRevision: number): CalendarOperation {
  return {
    clientOperationId: crypto.randomUUID(),
    deviceId: deviceId(),
    expectedRevision,
    mutation: { type: 'upsertItem', item },
  };
}

function projectedItems(
  sourceItems: CalendarItem[],
  range: { from: string; to: string; includeUnscheduledTasks?: boolean } | null,
): CalendarItem[] {
  return range
    ? queryCalendarItems(sourceItems, { ...range, limit: 5_000 })
    : sourceItems.filter((item) => item.deletedAt == null);
}

function replaceSourceItems(sourceItems: CalendarItem[], replacements: CalendarItem[]): CalendarItem[] {
  const replacementIds = new Set(replacements.map((item) => item.id));
  return [...sourceItems.filter((item) => !replacementIds.has(item.id)), ...replacements];
}

function subscriptionItems(
  preview: ReturnType<typeof previewCalendarIcsImport>,
  subscriptionId: string,
): CalendarItem[] {
  return preview.entries.flatMap((entry) => {
    if (entry.action === 'conflict') return [];
    const item = entry.action === 'unchanged' && entry.existing ? entry.existing : entry.item;
    return [normalizeCalendarItem({
      ...item,
      sourceBinding: {
        kind: 'external',
        subscriptionId,
        externalUid: item.uid,
      },
    })];
  });
}

function assertValidSubscriptionPreview(
  preview: ReturnType<typeof previewCalendarIcsImport>,
): void {
  if (preview.conflicts > 0) {
    throw new Error('The calendar feed contains conflicting duplicate item identities.');
  }
  if (preview.warnings.length > 0) {
    throw new Error(`The calendar feed contains invalid or unsupported items: ${preview.warnings[0]}`);
  }
}

function recurrenceInstant(item: CalendarItem): number {
  if (!item.recurrenceId) return Number.NaN;
  return item.recurrenceId.kind === 'date'
    ? Date.parse(`${item.recurrenceId.date}T00:00:00.000Z`)
    : Date.parse(item.recurrenceId.dateTime);
}

function priorOccurrenceCount(master: CalendarItem, occurrence: CalendarItem): number {
  const range = calendarItemRange(master);
  const selected = recurrenceInstant(occurrence);
  if (!range || !Number.isFinite(selected)) return 0;
  return Math.max(0, expandRecurringItem(master, range.start - 1, selected + 1, 20_000).length - 1);
}

async function pushHostedOperation(
  profileId: string,
  calendar: CalendarDefinition,
  operation: CalendarOperation,
): Promise<void> {
  if (calendar.location.kind !== 'hosted') {
    await tauriCommands.calendarAcknowledgeOperations(profileId, [operation.clientOperationId]);
    return;
  }
  try {
    await tauriCommands.hostedCalendarRequest(
      calendar.location.serverUrl,
      'POST',
      '/api/v1/calendars/operations',
      { operations: [operation] },
    );
    await tauriCommands.calendarAcknowledgeOperations(profileId, [operation.clientOperationId]);
  } catch {
    // The local store already contains the edit and its durable operation. A
    // later calendar sync pass will replay it after the server reconnects.
  }
}

async function pushHostedOperations(
  profileId: string,
  calendar: CalendarDefinition,
  operations: CalendarOperation[],
): Promise<void> {
  if (operations.length === 0) return;
  if (calendar.location.kind !== 'hosted') {
    await tauriCommands.calendarAcknowledgeOperations(
      profileId,
      operations.map((operation) => operation.clientOperationId),
    );
    return;
  }
  for (let offset = 0; offset < operations.length; offset += 500) {
    const batch = operations.slice(offset, offset + 500);
    try {
      await tauriCommands.hostedCalendarRequest(
        calendar.location.serverUrl,
        'POST',
        '/api/v1/calendars/operations',
        { operations: batch },
      );
      await tauriCommands.calendarAcknowledgeOperations(
        profileId,
        batch.map((operation) => operation.clientOperationId),
      );
    } catch {
      // Every edit is already durable in the local operation queue. Leave this
      // batch and any remaining batches pending for normal calendar sync.
      return;
    }
  }
}

export const useCalendarStore = create<CalendarStoreState>()((set, get) => ({
  profileId: null,
  calendars: [],
  subscriptions: [],
  sourceItems: [],
  items: [],
  visibleCalendarIds: [],
  range: null,
  loading: false,
  saving: false,
  syncing: false,
  syncResults: [],
  syncProgress: {},
  conflicts: [],
  mirrorGroups: [],
  mirrorConflicts: [],
  mirrorStatuses: [],
  mirrorProgress: {},
  error: null,

  initialize: async (profileId) => {
    const pending = profileInitializations.get(profileId);
    if (pending) return pending;
    if (get().profileId === profileId && get().calendars.length > 0) return;
    const initialization = (async () => {
      set({
        profileId,
        loading: true,
        syncing: false,
        syncResults: [],
        syncProgress: {},
        conflicts: [],
        subscriptions: [],
        mirrorGroups: [],
        mirrorConflicts: [],
        mirrorStatuses: [],
        mirrorProgress: {},
        error: null,
      });
      try {
        let [calendars, subscriptions, conflicts, mirrorGroups, mirrorConflicts] = await Promise.all([
          tauriCommands.calendarList(profileId),
          tauriCommands.calendarListSubscriptions(profileId),
          tauriCommands.calendarListFailedOperations(profileId),
          tauriCommands.calendarListMirrorGroups(profileId),
          tauriCommands.calendarListMirrorConflicts(profileId, undefined, false),
        ]);
        if (calendars.length === 0) {
          const calendar = createCalendarDefinition({
            location: { kind: 'local', profileId },
            name: 'Personal',
            color: '#a78bfa',
            defaultTimeZone: defaultCalendarTimeZone(),
          });
          await tauriCommands.calendarSave(profileId, calendar);
          calendars = [calendar];
        }
        const activeIds = calendars.filter((calendar) => !calendar.archived).map((calendar) => calendar.id);
        set((state) => {
          const survivingIds = state.visibleCalendarIds.filter((id) => activeIds.includes(id));
          return {
            calendars,
            subscriptions,
            conflicts,
            mirrorGroups,
            mirrorConflicts,
            visibleCalendarIds: survivingIds.length > 0 ? survivingIds : activeIds,
          };
        });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        set({ loading: false });
      }
    })();
    profileInitializations.set(profileId, initialization);
    try {
      await initialization;
    } finally {
      profileInitializations.delete(profileId);
    }
  },

  loadRange: async (from, to, includeUnscheduledTasks = false) => {
    const profileId = get().profileId;
    if (!profileId) return;
    set({ loading: true, error: null, range: { from, to, includeUnscheduledTasks } });
    try {
      const storedItems = await tauriCommands.calendarListItems(profileId, from, to, 5_000, true);
      const items = queryCalendarItems(storedItems, {
        from,
        to,
        limit: 5_000,
        includeUnscheduledTasks,
      });
      if (get().profileId === profileId && get().range?.from === from && get().range?.to === to
        && get().range?.includeUnscheduledTasks === includeUnscheduledTasks) {
        set({ sourceItems: storedItems, items });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ loading: false });
    }
  },

  syncHosted: async (origins) => {
    const profileId = get().profileId;
    if (!profileId || origins.length === 0) return [];
    const syncKey = `${profileId}:${origins
      .map((origin) => `${origin.serverUrl}:${origin.userId}`)
      .sort()
      .join('|')}`;
    const existing = hostedSyncs.get(syncKey);
    if (existing) return existing;
    const sync = (async () => {
      activeHostedSyncs.set(profileId, (activeHostedSyncs.get(profileId) ?? 0) + 1);
      set({ syncing: true });
      let results = await syncHostedCalendars(profileId, origins, get().calendars, (progress) => {
        if (get().profileId !== profileId) return;
        set((state) => ({
          syncProgress: { ...state.syncProgress, [progress.originKey]: progress },
        }));
      });
      if (get().profileId !== profileId) return results;
      try {
        const existingSubscriptions = await tauriCommands.calendarListSubscriptions(profileId);
        for (const origin of origins) {
          const normalizedServerUrl = origin.serverUrl.replace(/\/$/, '');
          const remoteSubscriptions = await tauriCommands.hostedCalendarRequest<CalendarSubscription[]>(
            normalizedServerUrl,
            'GET',
            '/api/v1/calendars/subscriptions',
          );
          const remoteIds = new Set(remoteSubscriptions.map((entry) => entry.id));
          for (const subscription of remoteSubscriptions) {
            await tauriCommands.calendarSaveSubscription(profileId, {
              ...subscription,
              serverUrl: normalizedServerUrl,
              userId: origin.userId,
            });
          }
          for (const stale of existingSubscriptions.filter((entry) => (
            entry.serverUrl?.replace(/\/$/, '') === normalizedServerUrl
            && entry.userId === origin.userId
            && !remoteIds.has(entry.id)
          ))) {
            await tauriCommands.calendarDeleteSubscription(profileId, stale.id);
          }
        }
        const [calendars, subscriptions, conflicts] = await Promise.all([
          tauriCommands.calendarList(profileId),
          tauriCommands.calendarListSubscriptions(profileId),
          tauriCommands.calendarListFailedOperations(profileId),
        ]);
        const mirror = await bridgeCalendarMirrors({
          profileId,
          calendars,
          connectedOriginKeys: new Set(origins.map(hostedCalendarOriginKey)),
          deviceId: deviceId(),
          adapter: tauriCommands,
          onProgress: (mirrorProgress) => {
            if (get().profileId !== profileId) return;
            set((state) => ({
              mirrorProgress: {
                ...state.mirrorProgress,
                [mirrorProgress.groupId]: mirrorProgress,
              },
            }));
          },
        });
        if (mirror.appliedOperations > 0) {
          results = await syncHostedCalendars(profileId, origins, calendars, (progress) => {
            if (get().profileId !== profileId) return;
            set((state) => ({
              syncProgress: { ...state.syncProgress, [progress.originKey]: progress },
            }));
          });
        }
        const mirrorConflicts = await tauriCommands.calendarListMirrorConflicts(profileId, undefined, false);
        const activeIds = calendars.filter((calendar) => !calendar.archived).map((calendar) => calendar.id);
        const range = get().range;
        let sourceItems = get().sourceItems;
        let items = get().items;
        if (range) {
          sourceItems = await tauriCommands.calendarListItems(
            profileId,
            range.from,
            range.to,
            5_000,
            true,
          );
          items = projectedItems(sourceItems, range);
        }
        set((state) => ({
          calendars,
          subscriptions,
          sourceItems,
          items,
          syncResults: results,
          conflicts,
          mirrorConflicts,
          mirrorStatuses: mirror.statuses,
          visibleCalendarIds: Array.from(new Set([
            ...state.visibleCalendarIds.filter((id) => activeIds.includes(id)),
            ...activeIds.filter((id) => !state.calendars.some((calendar) => calendar.id === id)),
          ])),
        }));
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error), syncResults: results });
      }
      return results;
    })();
    hostedSyncs.set(syncKey, sync);
    try {
      return await sync;
    } finally {
      hostedSyncs.delete(syncKey);
      const remaining = Math.max(0, (activeHostedSyncs.get(profileId) ?? 1) - 1);
      if (remaining === 0) activeHostedSyncs.delete(profileId);
      else activeHostedSyncs.set(profileId, remaining);
      if (get().profileId === profileId) set({ syncing: remaining > 0 });
    }
  },

  retryConflict: async (clientOperationId) => {
    const profileId = get().profileId;
    if (!profileId) return;
    try {
      await tauriCommands.calendarRetryOperation(profileId, clientOperationId);
      const conflicts = await tauriCommands.calendarListFailedOperations(profileId);
      if (get().profileId === profileId) set({ conflicts, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  discardConflict: async (clientOperationId) => {
    const profileId = get().profileId;
    if (!profileId) return;
    try {
      await tauriCommands.calendarDiscardOperation(profileId, clientOperationId);
      const conflicts = await tauriCommands.calendarListFailedOperations(profileId);
      if (get().profileId === profileId) set({ conflicts, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  removeHostedCache: async (origin) => {
    const profileId = get().profileId;
    if (!profileId) return;
    const originKey = `${origin.serverUrl.replace(/\/$/, '')}::${origin.userId}`;
    try {
      await tauriCommands.calendarRemoveHostedCache(profileId, origin.serverUrl, origin.userId);
      const [calendars, conflicts] = await Promise.all([
        tauriCommands.calendarList(profileId),
        tauriCommands.calendarListFailedOperations(profileId),
      ]);
      const range = get().range;
      const sourceItems = range
        ? await tauriCommands.calendarListItems(profileId, range.from, range.to, 5_000, true)
        : get().sourceItems;
      set((state) => {
        const syncProgress = { ...state.syncProgress };
        delete syncProgress[originKey];
        return {
          calendars,
          conflicts,
          sourceItems,
          items: projectedItems(sourceItems, range),
          visibleCalendarIds: state.visibleCalendarIds.filter((id) => calendars.some((calendar) => calendar.id === id)),
          syncResults: state.syncResults.filter((result) => result.originKey !== originKey),
          syncProgress,
          error: null,
        };
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  searchItems: async (query, limit = 100) => {
    const profileId = get().profileId;
    if (!profileId || !query.trim()) return [];
    try {
      return await tauriCommands.calendarSearchItems(profileId, query.trim(), limit);
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  },

  createSubscription: async (name, color, rawFeedUrl, location) => {
    const profileId = get().profileId;
    if (!profileId) throw new Error('Calendar profile is not initialized.');
    let feedUrl: string;
    try {
      const parsed = new URL(rawFeedUrl.trim());
      if (parsed.protocol !== 'https:') throw new Error();
      feedUrl = parsed.toString();
    } catch {
      throw new Error('Calendar subscriptions require a valid HTTPS URL.');
    }
    if (location?.kind === 'hosted') {
      const origin = {
        serverUrl: location.serverUrl.replace(/\/$/, ''),
        userId: location.userId,
      };
      set({ saving: true, error: null });
      try {
        const response = await tauriCommands.hostedCalendarRequest<HostedSubscriptionResult>(
          origin.serverUrl,
          'POST',
          '/api/v1/calendars/subscriptions',
          {
            name,
            color,
            defaultTimeZone: defaultCalendarTimeZone(),
            feedUrl,
          },
        );
        const calendar = normalizeRemoteCalendar(response.calendar, origin);
        const subscription = {
          ...response.subscription,
          serverUrl: origin.serverUrl,
          userId: origin.userId,
        };
        await Promise.all([
          tauriCommands.calendarSave(profileId, calendar),
          tauriCommands.calendarSaveSubscription(profileId, subscription),
        ]);
        await get().syncHosted([origin]);
        return subscription;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ error: message });
        throw error;
      } finally {
        set({ saving: false });
      }
    }
    const now = new Date().toISOString();
    const subscriptionId = crypto.randomUUID();
    const calendar = createCalendarDefinition({
      location: { kind: 'subscription', subscriptionId },
      name,
      color,
      defaultTimeZone: defaultCalendarTimeZone(),
      now,
    });
    calendar.readOnly = true;
    set({ saving: true, error: null });
    try {
      const response = await tauriCommands.fetchCalendarFeed(feedUrl);
      if (!response.content) throw new Error('The calendar feed returned no content.');
      const preview = previewCalendarIcsImport(response.content, calendar, [], now);
      assertValidSubscriptionPreview(preview);
      const items = subscriptionItems(preview, subscriptionId);
      const subscription: CalendarSubscription = {
        id: subscriptionId,
        calendarId: calendar.id,
        feedUrl: response.resolvedUrl,
        etag: response.etag,
        lastModified: response.lastModified,
        lastRefreshedAt: now,
        createdAt: now,
        updatedAt: now,
      };
      await tauriCommands.calendarReplaceSubscription(profileId, calendar, items, subscription);
      set((state) => {
        const sourceItems = [...state.sourceItems, ...items];
        return {
          calendars: [...state.calendars, calendar],
          subscriptions: [...state.subscriptions, subscription],
          visibleCalendarIds: [...state.visibleCalendarIds, calendar.id],
          sourceItems,
          items: projectedItems(sourceItems, state.range),
        };
      });
      return subscription;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  refreshSubscription: async (subscriptionId) => {
    const profileId = get().profileId;
    const subscription = get().subscriptions.find((entry) => entry.id === subscriptionId);
    const calendar = subscription
      ? get().calendars.find((entry) => entry.id === subscription.calendarId)
      : undefined;
    if (!profileId || !subscription || !calendar) throw new Error('Calendar subscription is not available.');
    set({ saving: true, error: null });
    const attemptedAt = new Date().toISOString();
    try {
      if (subscription.serverUrl && subscription.userId) {
        const origin = {
          serverUrl: subscription.serverUrl.replace(/\/$/, ''),
          userId: subscription.userId,
        };
        const response = await tauriCommands.hostedCalendarRequest<HostedSubscriptionResult>(
          origin.serverUrl,
          'POST',
          `/api/v1/calendars/subscriptions/${subscriptionId}/refresh`,
        );
        const updated = {
          ...response.subscription,
          serverUrl: origin.serverUrl,
          userId: origin.userId,
        };
        await tauriCommands.calendarSaveSubscription(profileId, updated);
        await get().syncHosted([origin]);
        return;
      }
      const response = await tauriCommands.fetchCalendarFeed(
        subscription.feedUrl,
        subscription.etag,
        subscription.lastModified,
      );
      let nextCalendar = calendar;
      let nextItems: CalendarItem[] | null = null;
      if (!response.notModified) {
        if (!response.content) throw new Error('The calendar feed returned no content.');
        const existing = await tauriCommands.calendarListCalendarItems(profileId, calendar.id, 5_000);
        const preview = previewCalendarIcsImport(response.content, calendar, existing, attemptedAt);
        assertValidSubscriptionPreview(preview);
        nextCalendar = normalizeCalendarDefinition({
          ...calendar,
          revision: calendar.revision + 1,
          updatedAt: attemptedAt,
        });
        nextItems = subscriptionItems(preview, subscriptionId);
      }
      const updated: CalendarSubscription = {
        ...subscription,
        feedUrl: response.resolvedUrl,
        etag: response.etag,
        lastModified: response.lastModified,
        lastRefreshedAt: attemptedAt,
        lastError: undefined,
        updatedAt: attemptedAt,
      };
      if (nextItems) {
        await tauriCommands.calendarReplaceSubscription(
          profileId,
          nextCalendar,
          nextItems,
          updated,
        );
      } else {
        await tauriCommands.calendarSaveSubscription(profileId, updated);
      }
      set((state) => {
        const sourceItems = nextItems
          ? [
              ...state.sourceItems.filter((item) => item.calendarId !== calendar.id),
              ...nextItems,
            ]
          : state.sourceItems;
        return {
          calendars: state.calendars.map((entry) => entry.id === calendar.id ? nextCalendar : entry),
          subscriptions: state.subscriptions.map((entry) => entry.id === subscriptionId ? updated : entry),
          sourceItems,
          items: projectedItems(sourceItems, state.range),
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = { ...subscription, lastError: message, updatedAt: attemptedAt };
      try {
        await tauriCommands.calendarSaveSubscription(profileId, failed);
      } catch {
        // Keep the original error as the actionable failure.
      }
      set((state) => ({
        subscriptions: state.subscriptions.map((entry) => entry.id === subscriptionId ? failed : entry),
        error: message,
      }));
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  refreshSubscriptions: async (staleAfterMs = 15 * 60_000) => {
    const cutoff = Date.now() - staleAfterMs;
    for (const subscription of get().subscriptions) {
      const lastRefresh = subscription.lastRefreshedAt ? Date.parse(subscription.lastRefreshedAt) : 0;
      if (lastRefresh > cutoff) continue;
      try {
        await get().refreshSubscription(subscription.id);
      } catch {
        // One stale feed must not prevent unrelated subscriptions from refreshing.
      }
    }
  },

  deleteSubscription: async (subscriptionId) => {
    const profileId = get().profileId;
    const subscription = get().subscriptions.find((entry) => entry.id === subscriptionId);
    if (!profileId || !subscription) throw new Error('Calendar subscription is not available.');
    set({ saving: true, error: null });
    try {
      if (subscription.serverUrl) {
        await tauriCommands.hostedCalendarRequest(
          subscription.serverUrl,
          'DELETE',
          `/api/v1/calendars/subscriptions/${subscriptionId}`,
        );
      }
      await tauriCommands.calendarDeleteSubscription(profileId, subscriptionId);
      set((state) => {
        const calendars = state.calendars.filter((entry) => entry.id !== subscription.calendarId);
        const sourceItems = state.sourceItems.filter((item) => item.calendarId !== subscription.calendarId);
        return {
          calendars,
          subscriptions: state.subscriptions.filter((entry) => entry.id !== subscriptionId),
          visibleCalendarIds: state.visibleCalendarIds.filter((id) => id !== subscription.calendarId),
          sourceItems,
          items: projectedItems(sourceItems, state.range),
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  listCalendarItems: async (calendarId) => {
    const profileId = get().profileId;
    if (!profileId) throw new Error('Calendar profile is not initialized.');
    return tauriCommands.calendarListCalendarItems(profileId, calendarId, 5_000);
  },

  importItems: async (calendarId, inputs) => {
    const profileId = get().profileId;
    const calendar = get().calendars.find((entry) => entry.id === calendarId);
    if (!profileId || !calendar) throw new Error('Calendar is not available.');
    if (calendar.readOnly) throw new Error('Calendar is read-only.');
    if (inputs.length === 0) return;
    if (inputs.length > 5_000) throw new Error('Calendar imports cannot apply more than 5,000 items.');

    const items = inputs.map((input) => {
      if (input.calendarId !== calendarId) throw new Error('An imported item targets a different calendar.');
      return normalizeCalendarItem(input);
    });
    const operations = items.map((item) => operationFor(item, Math.max(0, item.revision - 1)));
    set({ saving: true, error: null });
    try {
      await tauriCommands.calendarUpsertItems(
        profileId,
        items.map((item, index) => [item, operations[index]]),
      );
      await pushHostedOperations(profileId, calendar, operations);
      set((state) => {
        const sourceItems = replaceSourceItems(state.sourceItems, items);
        return { sourceItems, items: projectedItems(sourceItems, state.range) };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  setCalendarVisible: (calendarId, visible) => set((state) => ({
    visibleCalendarIds: visible
      ? Array.from(new Set([...state.visibleCalendarIds, calendarId]))
      : state.visibleCalendarIds.filter((id) => id !== calendarId),
  })),

  createCalendar: async (name, color, requestedLocation) => {
    const profileId = get().profileId;
    if (!profileId) throw new Error('Calendar profile is not initialized.');
    const location = requestedLocation ?? { kind: 'local' as const, profileId };
    let calendar = createCalendarDefinition({
      location,
      name,
      color,
      defaultTimeZone: defaultCalendarTimeZone(),
    });
    set({ saving: true, error: null });
    try {
      if (location.kind === 'hosted') {
        calendar = await tauriCommands.hostedCalendarRequest<CalendarDefinition>(
          location.serverUrl,
          'POST',
          '/api/v1/calendars',
          calendar,
        );
      }
      await tauriCommands.calendarSave(profileId, calendar);
      set((state) => ({
        calendars: [...state.calendars, calendar],
        visibleCalendarIds: [...state.visibleCalendarIds, calendar.id],
      }));
      return calendar;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  updateCalendar: async (calendarId, changes) => {
    const profileId = get().profileId;
    const existing = get().calendars.find((calendar) => calendar.id === calendarId);
    if (!profileId || !existing) throw new Error('Calendar is not available.');
    if (existing.readOnly) throw new Error('Calendar is read-only.');
    const calendar = normalizeCalendarDefinition({
      ...existing,
      ...changes,
      revision: existing.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const operation: CalendarOperation = {
      clientOperationId: crypto.randomUUID(),
      deviceId: deviceId(),
      expectedRevision: existing.revision,
      mutation: { type: 'updateCalendar', calendar },
    };
    set({ saving: true, error: null });
    try {
      if (calendar.location.kind === 'hosted') {
        await tauriCommands.calendarSaveWithOperation(profileId, calendar, operation);
        await pushHostedOperation(profileId, calendar, operation);
      } else {
        await tauriCommands.calendarSave(profileId, calendar);
      }
      set((state) => ({
        calendars: state.calendars.map((entry) => entry.id === calendar.id ? calendar : entry),
        visibleCalendarIds: calendar.archived
          ? state.visibleCalendarIds.filter((id) => id !== calendar.id)
          : Array.from(new Set([...state.visibleCalendarIds, calendar.id])),
      }));
      return calendar;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  createMirrorGroup: async (name, calendarIds) => {
    const profileId = get().profileId;
    if (!profileId) throw new Error('Calendar profile is not initialized.');
    const calendars = calendarIds.map((calendarId) => {
      const calendar = get().calendars.find((entry) => entry.id === calendarId);
      if (!calendar) throw new Error('A selected calendar is no longer available.');
      if (calendar.location.kind !== 'local' && calendar.location.kind !== 'hosted') {
        throw new Error(`${calendar.name} cannot be mirrored.`);
      }
      return calendar;
    });
    const now = new Date().toISOString();
    const group: CalendarMirrorGroup = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      name: name.trim(),
      enabled: true,
      members: calendars.map((calendar) => ({
        id: crypto.randomUUID(),
        calendarId: calendar.id,
        location: calendar.location as Extract<CalendarLocation, { kind: 'local' | 'hosted' }>,
        addedAt: now,
      })),
      createdAt: now,
      updatedAt: now,
    };
    validateCalendarMirrorGroup(group, get().calendars);
    set({ saving: true, error: null });
    try {
      await tauriCommands.calendarSaveMirrorGroup(profileId, group);
      set((state) => ({ mirrorGroups: [...state.mirrorGroups, group] }));
      return group;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  updateMirrorGroup: async (groupId, changes) => {
    const profileId = get().profileId;
    const existing = get().mirrorGroups.find((group) => group.id === groupId);
    if (!profileId || !existing) throw new Error('Calendar mirror group is not available.');
    const group: CalendarMirrorGroup = {
      ...existing,
      ...changes,
      name: changes.name?.trim() || existing.name,
      updatedAt: new Date().toISOString(),
    };
    validateCalendarMirrorGroup(group, get().calendars);
    set({ saving: true, error: null });
    try {
      await tauriCommands.calendarSaveMirrorGroup(profileId, group);
      set((state) => ({
        mirrorGroups: state.mirrorGroups.map((entry) => entry.id === group.id ? group : entry),
        mirrorStatuses: state.mirrorStatuses.map((status) => (
          status.groupId === group.id && !group.enabled
            ? { ...status, state: 'disabled', missingMemberIds: [] }
            : status
        )),
      }));
      return group;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  deleteMirrorGroup: async (groupId) => {
    const profileId = get().profileId;
    if (!profileId) throw new Error('Calendar profile is not initialized.');
    set({ saving: true, error: null });
    try {
      await tauriCommands.calendarDeleteMirrorGroup(profileId, groupId);
      set((state) => ({
        mirrorGroups: state.mirrorGroups.filter((group) => group.id !== groupId),
        mirrorStatuses: state.mirrorStatuses.filter((status) => status.groupId !== groupId),
        mirrorConflicts: state.mirrorConflicts.filter((conflict) => conflict.groupId !== groupId),
        mirrorProgress: Object.fromEntries(
          Object.entries(state.mirrorProgress).filter(([entryGroupId]) => entryGroupId !== groupId),
        ),
      }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  resolveMirrorConflict: async (conflictId, chosenMemberId, origins) => {
    const profileId = get().profileId;
    const conflict = get().mirrorConflicts.find((entry) => entry.id === conflictId);
    const group = conflict && get().mirrorGroups.find((entry) => entry.id === conflict.groupId);
    if (!profileId || !conflict || !group) throw new Error('Calendar mirror conflict is not available.');
    set({ saving: true, error: null });
    try {
      const result = await resolveCalendarMirrorConflict({
        profileId,
        group,
        conflict,
        chosenMemberId,
        calendars: get().calendars,
        connectedOriginKeys: new Set(origins.map(hostedCalendarOriginKey)),
        deviceId: deviceId(),
        adapter: tauriCommands,
      });
      const mirrorConflicts = await tauriCommands.calendarListMirrorConflicts(profileId, undefined, false);
      set((state) => ({
        mirrorConflicts,
        mirrorStatuses: state.mirrorStatuses.map((status) => {
          if (status.groupId !== group.id) return status;
          const conflictCount = mirrorConflicts.filter((entry) => entry.groupId === group.id).length;
          return { ...status, conflictCount, state: conflictCount > 0 ? 'conflict' : 'ready' };
        }),
      }));
      if (result.appliedOperations > 0 && origins.length > 0) {
        await get().syncHosted(origins);
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  createEvent: async ({ calendarId, title, start, end, allDay, description }) => {
    const profileId = get().profileId;
    const calendar = get().calendars.find((entry) => entry.id === calendarId);
    if (!profileId || !calendar) throw new Error('Calendar is not available.');
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const event = normalizeCalendarItem({
      id,
      uid: `${id}@collab.local`,
      calendarId,
      kind: 'event',
      title,
      description,
      reminders: [],
      start: allDay
        ? { kind: 'date', date: start }
        : { kind: 'dateTime', dateTime: new Date(start).toISOString(), timeZone: calendar.defaultTimeZone },
      end: allDay
        ? { kind: 'date', date: end }
        : { kind: 'dateTime', dateTime: new Date(end).toISOString(), timeZone: calendar.defaultTimeZone },
      availability: 'busy',
      revision: 0,
      createdAt: now,
      updatedAt: now,
    }) as CalendarEvent;
    set({ saving: true, error: null });
    try {
      const operation = operationFor(event, 0);
      await tauriCommands.calendarUpsertItem(profileId, event, operation);
      await pushHostedOperation(profileId, calendar, operation);
      set((state) => {
        const sourceItems = replaceSourceItems(state.sourceItems, [event]);
        return { sourceItems, items: projectedItems(sourceItems, state.range) };
      });
      return event;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  saveItem: async (input, scope = 'series') => {
    const profileId = get().profileId;
    if (!profileId) throw new Error('Calendar profile is not initialized.');
    const now = new Date().toISOString();
    const originalOccurrence = get().items.find((item) => item.id === input.id) ?? input;
    if (input.kind === 'task' && originalOccurrence.kind === 'task'
      && input.sourceBinding?.kind === 'kanban') {
      set({ saving: true, error: null });
      try {
        const saved = await writeThroughKanbanCalendarTask(
          originalOccurrence,
          input,
          useVaultStore.getState().vault,
        );
        set((state) => {
          const sourceItems = replaceSourceItems(state.sourceItems, [saved]);
          return { sourceItems, items: projectedItems(sourceItems, state.range) };
        });
        return saved;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ error: message });
        throw error;
      } finally {
        set({ saving: false });
      }
    }
    let plannedInputs = [input];
    if (input.recurrenceId && input.recurrenceSeriesId) {
      const master = get().sourceItems.find((item) => item.id === input.recurrenceSeriesId);
      if (!master?.recurrence) throw new Error('The recurring series is not available in the local calendar cache.');
      const recurrenceKey = calendarTimeValueKey(input.recurrenceId);
      const existingException = get().sourceItems.find((item) => item.uid === master.uid
        && item.recurrenceId != null
        && calendarTimeValueKey(item.recurrenceId) === recurrenceKey);
      plannedInputs = planRecurringEdit({
        master,
        originalOccurrence,
        editedOccurrence: input,
        scope,
        now,
        exceptionId: existingException?.id ?? crypto.randomUUID(),
        followingSeriesId: crypto.randomUUID(),
        priorOccurrences: priorOccurrenceCount(master, originalOccurrence),
      }).upserts;
    }
    set({ saving: true, error: null });
    try {
      const savedItems: CalendarItem[] = [];
      for (const planned of plannedInputs) {
        const existing = get().sourceItems.find((item) => item.id === planned.id);
        const item = normalizeCalendarItem({
          ...planned,
          revision: existing ? existing.revision + 1 : planned.revision,
          createdAt: existing?.createdAt ?? planned.createdAt,
          updatedAt: now,
        });
        const calendar = get().calendars.find((entry) => entry.id === item.calendarId);
        if (!calendar) throw new Error('Calendar is not available.');
        const operation = operationFor(item, existing?.revision ?? 0);
        await tauriCommands.calendarUpsertItem(profileId, item, operation);
        await pushHostedOperation(profileId, calendar, operation);
        savedItems.push(item);
      }
      set((state) => {
        const sourceItems = replaceSourceItems(state.sourceItems, savedItems);
        return { sourceItems, items: projectedItems(sourceItems, state.range) };
      });
      return savedItems[savedItems.length - 1];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  deleteItem: async (item, scope = 'occurrence') => {
    const profileId = get().profileId;
    if (!profileId) throw new Error('Calendar is not available.');
    if (item.sourceBinding?.kind === 'kanban') {
      const message = 'Kanban tasks must be archived or deleted from their source board.';
      set({ error: message });
      throw new Error(message);
    }
    if (item.recurrenceId && item.recurrenceSeriesId) {
      const master = get().sourceItems.find((entry) => entry.id === item.recurrenceSeriesId);
      if (!master?.recurrence) throw new Error('The recurring series is not available in the local calendar cache.');
      if (scope === 'occurrence') {
        const exdates = [...(master.recurrence.exdates ?? [])];
        const key = calendarTimeValueKey(item.recurrenceId);
        if (!exdates.some((value) => calendarTimeValueKey(value) === key)) exdates.push(item.recurrenceId);
        await get().saveItem({ ...master, recurrence: { ...master.recurrence, exdates } }, 'series');
        return;
      }
      if (scope === 'following') {
        const recurrence = splitRecurrence(
          master.recurrence,
          item.recurrenceId,
          priorOccurrenceCount(master, item),
        ).previous;
        if (recurrence) {
          await get().saveItem({ ...master, recurrence }, 'series');
          return;
        }
      }
      item = master;
    }
    const calendar = get().calendars.find((entry) => entry.id === item.calendarId);
    if (!calendar) throw new Error('Calendar is not available.');
    const deletedAt = new Date().toISOString();
    const operation: CalendarOperation = {
      clientOperationId: crypto.randomUUID(),
      deviceId: deviceId(),
      expectedRevision: item.revision,
      mutation: { type: 'deleteItem', calendarId: item.calendarId, itemId: item.id, deletedAt },
    };
    set({ saving: true, error: null });
    try {
      await tauriCommands.calendarDeleteItem(profileId, item.calendarId, item.id, deletedAt, operation);
      await pushHostedOperation(profileId, calendar, operation);
      set((state) => {
        const tombstone = { ...item, revision: item.revision + 1, updatedAt: deletedAt, deletedAt };
        const sourceItems = replaceSourceItems(state.sourceItems, [tombstone]);
        return { sourceItems, items: projectedItems(sourceItems, state.range) };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: false });
    }
  },

  clearError: () => set({ error: null }),
}));
