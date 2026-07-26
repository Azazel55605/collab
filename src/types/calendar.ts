import { expandRecurringItem, recurrenceIncludes, validateRecurrenceRule } from '../lib/calendarRecurrence';

export const CALENDAR_SCHEMA_VERSION = 1;
export const MAX_CALENDAR_QUERY_ITEMS = 5_000;
export const MAX_CALENDAR_NAME_LENGTH = 120;
export const MAX_CALENDAR_ITEM_TITLE_LENGTH = 500;
export const MAX_CALENDAR_ITEM_TEXT_LENGTH = 100_000;
export const MAX_CALENDAR_RECURRENCE_VALUE_LENGTH = 4_096;
export const MAX_CALENDAR_RECURRENCE_DATES = 512;
export const MAX_CALENDAR_ATTENDEES = 100;
export const MAX_CALENDAR_ATTACHMENTS = 50;
export const MAX_CALENDAR_ICALENDAR_PROPERTIES = 64;
export const MAX_CALENDAR_ICALENDAR_PROPERTY_LENGTH = 16_384;
const MAX_CALENDAR_EXPANDED_CANDIDATES = 20_000;

export type CalendarItemKind = 'event' | 'task' | 'birthday';
export type CalendarAvailability = 'busy' | 'free';
export type CalendarTaskPriority = 'low' | 'medium' | 'high';
export type CalendarTaskStatus = 'needs-action' | 'in-progress' | 'completed' | 'cancelled';
export type CalendarAttendanceResponse = 'needs-action' | 'accepted' | 'declined' | 'tentative';
export type CalendarAttendeeRole = 'organizer' | 'required' | 'optional';

export type CalendarLocation =
  | { kind: 'local'; profileId: string }
  | { kind: 'hosted'; serverUrl: string; userId: string }
  | { kind: 'subscription'; subscriptionId: string; serverUrl?: string; userId?: string }
  | { kind: 'kanban'; originKey: string };

export type CalendarTimeValue =
  | { kind: 'date'; date: string }
  | { kind: 'dateTime'; dateTime: string; timeZone: string };

export type CalendarReminder =
  | { kind: 'relative'; minutesBefore: number }
  | { kind: 'absolute'; at: string };

export interface CalendarRecurrence {
  /** RFC 5545 RRULE value without the `RRULE:` prefix. */
  rrule: string;
  rdates?: CalendarTimeValue[];
  exdates?: CalendarTimeValue[];
}

interface CalendarAttendeeBase {
  id: string;
  displayName?: string;
  response: CalendarAttendanceResponse;
  role: CalendarAttendeeRole;
}

export type CalendarAttendee =
  | (CalendarAttendeeBase & { kind: 'collabUser'; serverUrl: string; userId: string })
  | (CalendarAttendeeBase & { kind: 'email'; email: string });

interface CalendarAttachmentBase {
  id: string;
  name: string;
}

export type CalendarAttachment =
  | (CalendarAttachmentBase & {
      kind: 'vaultFile';
      serverUrl?: string;
      vaultId?: string;
      fileId: string;
      path?: string;
    })
  | (CalendarAttachmentBase & {
      kind: 'kanbanTask';
      serverUrl?: string;
      vaultId?: string;
      fileId: string;
      cardId: string;
      path?: string;
    })
  | (CalendarAttachmentBase & {
      kind: 'uploaded';
      attachmentId: string;
      contentType?: string;
      sizeBytes?: number;
    })
  | (CalendarAttachmentBase & { kind: 'externalUrl'; url: string });

export interface CalendarEventLocation {
  label: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  provider?: string;
  providerPlaceId?: string;
}

export interface CalendarReminderScheduleEntry {
  scheduleId: string;
  profileId: string;
  itemId: string;
  recurrenceId?: CalendarTimeValue;
  fireAt: string;
  title: string;
  body?: string;
}

export interface CalendarReminderScheduler {
  reconcileProfile(profileId: string, entries: CalendarReminderScheduleEntry[]): Promise<void>;
  cancelProfile(profileId: string): Promise<void>;
}

export type CalendarSourceBinding =
  | {
      kind: 'kanban';
      serverUrl?: string;
      vaultId?: string;
      fileId: string;
      cardId: string;
      path?: string;
      sourceRevision?: number;
    }
  | {
      kind: 'external';
      subscriptionId: string;
      externalUid: string;
    };

interface CalendarItemBase {
  id: string;
  uid: string;
  calendarId: string;
  title: string;
  description?: string;
  url?: string;
  reminders: CalendarReminder[];
  attendees: CalendarAttendee[];
  attachments: CalendarAttachment[];
  recurrence?: CalendarRecurrence;
  recurrenceId?: CalendarTimeValue;
  recurrenceSeriesId?: string;
  sourceBinding?: CalendarSourceBinding;
  /** Bounded, validated unknown X-* content lines preserved for iCalendar round trips. */
  icalendarProperties?: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface CalendarEvent extends CalendarItemBase {
  kind: 'event';
  start: CalendarTimeValue;
  end: CalendarTimeValue;
  location?: CalendarEventLocation;
  availability: CalendarAvailability;
}

export interface CalendarTask extends CalendarItemBase {
  kind: 'task';
  start?: CalendarTimeValue;
  due?: CalendarTimeValue;
  priority?: CalendarTaskPriority;
  status: CalendarTaskStatus;
  completedAt?: string;
}

export interface CalendarBirthday extends CalendarItemBase {
  kind: 'birthday';
  date: string;
  birthYear?: number;
}

export type CalendarItem = CalendarEvent | CalendarTask | CalendarBirthday;

export interface CalendarDefinition {
  schemaVersion: number;
  id: string;
  globalId: string;
  location: CalendarLocation;
  name: string;
  color: string;
  defaultTimeZone: string;
  archived: boolean;
  readOnly: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface CalendarSubscription {
  id: string;
  calendarId: string;
  feedUrl: string;
  etag?: string;
  lastModified?: string;
  lastRefreshedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  serverUrl?: string;
  userId?: string;
}

export interface CalendarPublishedFeed {
  id: string;
  calendarId: string;
  createdAt: string;
  lastAccessedAt?: string;
}

export interface CreatedCalendarPublishedFeed extends CalendarPublishedFeed {
  feedPath: string;
}

export interface CalendarCalDavCredential {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface CreatedCalendarCalDavCredential extends CalendarCalDavCredential {
  username: string;
  password: string;
  caldavPath: string;
}

export type CalendarMutation =
  | { type: 'createCalendar'; calendar: CalendarDefinition }
  | { type: 'updateCalendar'; calendar: CalendarDefinition }
  | { type: 'deleteCalendar'; calendarId: string }
  | { type: 'upsertItem'; item: CalendarItem }
  | { type: 'deleteItem'; calendarId: string; itemId: string; deletedAt: string };

export interface CalendarOperation {
  clientOperationId: string;
  deviceId: string;
  expectedRevision?: number;
  sourceChangeId?: string;
  propagationLineage?: string[];
  mutation: CalendarMutation;
}

export interface CalendarOperationFailure {
  operation: CalendarOperation;
  attemptCount: number;
  lastError: string;
  lastAttemptAt: string;
}

export interface CalendarSyncState {
  originKey: string;
  cursor?: string;
  lastSyncedAt?: string;
  lastError?: string;
}

export interface CalendarMirrorMember {
  id: string;
  calendarId: string;
  location: Extract<CalendarLocation, { kind: 'local' | 'hosted' }>;
  addedAt: string;
}

export interface CalendarMirrorGroup {
  schemaVersion: 1;
  id: string;
  name: string;
  enabled: boolean;
  members: CalendarMirrorMember[];
  createdAt: string;
  updatedAt: string;
}

export interface CalendarMirrorAnchor {
  groupId: string;
  logicalItemKey: string;
  memberId: string;
  itemId?: string;
  revision?: number;
  fingerprint: string;
  deletedAt?: string;
  updatedAt: string;
}

export interface CalendarMirrorConflictVersion {
  memberId: string;
  fingerprint: string;
  item?: CalendarItem;
}

export interface CalendarMirrorConflict {
  id: string;
  groupId: string;
  logicalItemKey: string;
  status: 'unresolved' | 'resolved';
  versions: CalendarMirrorConflictVersion[];
  detectedAt: string;
  resolvedAt?: string;
}

export type CalendarMirrorGroupState = 'ready' | 'waiting' | 'conflict' | 'disabled' | 'error';

export interface CalendarMirrorGroupStatus {
  groupId: string;
  state: CalendarMirrorGroupState;
  missingMemberIds: string[];
  conflictCount: number;
  lastBridgedAt?: string;
  error?: string;
}

export type CalendarMirrorProgressPhase =
  | 'checking'
  | 'applying'
  | 'waiting'
  | 'conflict'
  | 'complete'
  | 'disabled'
  | 'error';

export interface CalendarMirrorProgress {
  groupId: string;
  groupName: string;
  phase: CalendarMirrorProgressPhase;
  processedOperations: number;
  totalOperations: number | null;
  detail?: string;
  error?: string;
}

export interface CalendarRemoteChange {
  sequence: number;
  entityType: 'calendar' | 'item';
  entityId: string;
  operation: 'upsert' | 'delete';
  payload?: unknown;
  changedAt: string;
}

export interface CalendarChangesPage {
  changes: CalendarRemoteChange[];
  cursor: number;
  hasMore: boolean;
}

export interface CalendarCleanupResult {
  calendarsRemoved: number;
  itemsRemoved: number;
}

export interface CalendarQueryRange {
  from: string;
  to: string;
  limit?: number;
  includeDeleted?: boolean;
  includeUnscheduledTasks?: boolean;
}

export class CalendarValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarValidationError';
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CalendarValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CalendarValidationError(`${label} is required.`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new CalendarValidationError(`${label} exceeds ${maxLength} characters.`);
  }
  return normalized;
}

function optionalString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value == null || value === '') return undefined;
  return requiredString(value, label, maxLength);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CalendarValidationError(`${label} must be a non-negative integer.`);
  }
  return value as number;
}

function normalizeInstant(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new CalendarValidationError(`${label} must include a UTC or numeric offset.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new CalendarValidationError(`${label} is not a valid timestamp.`);
  }
  return date.toISOString();
}

export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function isCalendarTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function normalizeDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isCalendarDate(value)) {
    throw new CalendarValidationError(`${label} must use a valid YYYY-MM-DD date.`);
  }
  return value;
}

export function normalizeCalendarTimeValue(value: unknown, label = 'Calendar time'): CalendarTimeValue {
  const input = record(value, label);
  if (input.kind === 'date') {
    return { kind: 'date', date: normalizeDate(input.date, `${label} date`) };
  }
  if (input.kind === 'dateTime') {
    const timeZone = requiredString(input.timeZone, `${label} time zone`, 255);
    if (!isCalendarTimeZone(timeZone)) {
      throw new CalendarValidationError(`${label} time zone is not a recognized IANA time zone.`);
    }
    return {
      kind: 'dateTime',
      dateTime: normalizeInstant(input.dateTime, `${label} timestamp`),
      timeZone,
    };
  }
  throw new CalendarValidationError(`${label} kind must be date or dateTime.`);
}

function normalizeLocation(value: unknown): CalendarLocation {
  const input = record(value, 'Calendar location');
  if (input.kind === 'local') {
    return { kind: 'local', profileId: requiredString(input.profileId, 'Local profile ID', 255) };
  }
  if (input.kind === 'hosted') {
    const rawUrl = requiredString(input.serverUrl, 'Server URL', 2_048);
    let serverUrl: URL;
    try {
      serverUrl = new URL(rawUrl);
    } catch {
      throw new CalendarValidationError('Server URL is invalid.');
    }
    if (serverUrl.protocol !== 'https:' && serverUrl.protocol !== 'http:') {
      throw new CalendarValidationError('Server URL must use HTTP or HTTPS.');
    }
    serverUrl.hash = '';
    serverUrl.search = '';
    serverUrl.pathname = serverUrl.pathname.replace(/\/+$/, '');
    return {
      kind: 'hosted',
      serverUrl: serverUrl.toString().replace(/\/$/, ''),
      userId: requiredString(input.userId, 'Hosted user ID', 255),
    };
  }
  if (input.kind === 'subscription') {
    return {
      kind: 'subscription',
      subscriptionId: requiredString(input.subscriptionId, 'Subscription ID', 255),
      serverUrl: input.serverUrl == null ? undefined : normalizeServerUrl(input.serverUrl, 'Subscription server URL'),
      userId: optionalString(input.userId, 'Subscription user ID', 255),
    };
  }
  if (input.kind === 'kanban') {
    return { kind: 'kanban', originKey: requiredString(input.originKey, 'Kanban origin key', 2_048) };
  }
  throw new CalendarValidationError('Calendar location kind is invalid.');
}

function normalizeReminder(value: unknown): CalendarReminder {
  const input = record(value, 'Calendar reminder');
  if (input.kind === 'relative') {
    const minutesBefore = nonNegativeInteger(input.minutesBefore, 'Reminder minutes');
    if (minutesBefore > 525_600) {
      throw new CalendarValidationError('Relative reminders cannot exceed one year.');
    }
    return { kind: 'relative', minutesBefore };
  }
  if (input.kind === 'absolute') {
    return { kind: 'absolute', at: normalizeInstant(input.at, 'Reminder timestamp') };
  }
  throw new CalendarValidationError('Calendar reminder kind is invalid.');
}

function normalizeServerUrl(value: unknown, label: string): string {
  const raw = requiredString(value, label, 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CalendarValidationError(`${label} is invalid.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CalendarValidationError(`${label} must use HTTP or HTTPS.`);
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function normalizeAttendee(value: unknown): CalendarAttendee {
  const input = record(value, 'Calendar attendee');
  const response: CalendarAttendanceResponse = input.response === 'accepted'
    || input.response === 'declined'
    || input.response === 'tentative'
    ? input.response
    : 'needs-action';
  const role: CalendarAttendeeRole = input.role === 'organizer' || input.role === 'optional'
    ? input.role
    : 'required';
  const base = {
    id: requiredString(input.id, 'Attendee ID', 255),
    displayName: optionalString(input.displayName, 'Attendee display name', 500),
    response,
    role,
  };
  if (input.kind === 'collabUser') {
    return {
      ...base,
      kind: 'collabUser',
      serverUrl: normalizeServerUrl(input.serverUrl, 'Attendee server URL'),
      userId: requiredString(input.userId, 'Attendee user ID', 255),
    };
  }
  if (input.kind === 'email') {
    const email = requiredString(input.email, 'Attendee email', 320).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new CalendarValidationError('Attendee email is invalid.');
    }
    return { ...base, kind: 'email', email };
  }
  throw new CalendarValidationError('Calendar attendee kind is invalid.');
}

function normalizeAttachment(value: unknown): CalendarAttachment {
  const input = record(value, 'Calendar attachment');
  const base = {
    id: requiredString(input.id, 'Attachment ID', 255),
    name: requiredString(input.name, 'Attachment name', 500),
  };
  if (input.kind === 'vaultFile') {
    return {
      ...base,
      kind: 'vaultFile',
      serverUrl: input.serverUrl == null ? undefined : normalizeServerUrl(input.serverUrl, 'Attachment server URL'),
      vaultId: optionalString(input.vaultId, 'Attachment vault ID', 255),
      fileId: requiredString(input.fileId, 'Attachment file ID', 255),
      path: optionalString(input.path, 'Attachment path', 4_096),
    };
  }
  if (input.kind === 'kanbanTask') {
    return {
      ...base,
      kind: 'kanbanTask',
      serverUrl: input.serverUrl == null ? undefined : normalizeServerUrl(input.serverUrl, 'Attachment server URL'),
      vaultId: optionalString(input.vaultId, 'Attachment vault ID', 255),
      fileId: requiredString(input.fileId, 'Attachment file ID', 255),
      cardId: requiredString(input.cardId, 'Attachment card ID', 255),
      path: optionalString(input.path, 'Attachment path', 4_096),
    };
  }
  if (input.kind === 'uploaded') {
    return {
      ...base,
      kind: 'uploaded',
      attachmentId: requiredString(input.attachmentId, 'Uploaded attachment ID', 255),
      contentType: optionalString(input.contentType, 'Attachment content type', 255),
      sizeBytes: input.sizeBytes == null ? undefined : nonNegativeInteger(input.sizeBytes, 'Attachment size'),
    };
  }
  if (input.kind === 'externalUrl') {
    const url = requiredString(input.url, 'Attachment URL', 2_048);
    try {
      new URL(url);
    } catch {
      throw new CalendarValidationError('Attachment URL is invalid.');
    }
    return { ...base, kind: 'externalUrl', url };
  }
  throw new CalendarValidationError('Calendar attachment kind is invalid.');
}

function normalizeEventLocation(value: unknown): CalendarEventLocation | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'string') return { label: requiredString(value, 'Event location', 2_048) };
  const input = record(value, 'Event location');
  const latitude = input.latitude == null ? undefined : Number(input.latitude);
  const longitude = input.longitude == null ? undefined : Number(input.longitude);
  if (latitude != null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) {
    throw new CalendarValidationError('Event location latitude must be between -90 and 90.');
  }
  if (longitude != null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
    throw new CalendarValidationError('Event location longitude must be between -180 and 180.');
  }
  return {
    label: requiredString(input.label, 'Event location label', 2_048),
    address: optionalString(input.address, 'Event location address', 2_048),
    latitude,
    longitude,
    provider: optionalString(input.provider, 'Event location provider', 255),
    providerPlaceId: optionalString(input.providerPlaceId, 'Event location provider ID', 1_024),
  };
}

function normalizeRecurrence(value: unknown): CalendarRecurrence | undefined {
  if (value == null) return undefined;
  const input = record(value, 'Calendar recurrence');
  const rrule = requiredString(
    input.rrule,
    'Recurrence rule',
    MAX_CALENDAR_RECURRENCE_VALUE_LENGTH,
  ).replace(/^RRULE:/i, '');
  if (/[\r\n]/.test(rrule)) {
    throw new CalendarValidationError('Recurrence rules cannot contain line breaks.');
  }
  try {
    validateRecurrenceRule(rrule);
  } catch {
    throw new CalendarValidationError('Recurrence rule is not valid RFC 5545 syntax.');
  }
  if (
    (Array.isArray(input.rdates) && input.rdates.length > MAX_CALENDAR_RECURRENCE_DATES)
    || (Array.isArray(input.exdates) && input.exdates.length > MAX_CALENDAR_RECURRENCE_DATES)
  ) {
    throw new CalendarValidationError(
      `Recurrence additions and exclusions cannot exceed ${MAX_CALENDAR_RECURRENCE_DATES} values each.`,
    );
  }
  return {
    rrule,
    rdates: Array.isArray(input.rdates)
      ? input.rdates.map((entry) => normalizeCalendarTimeValue(entry, 'Recurrence date'))
      : undefined,
    exdates: Array.isArray(input.exdates)
      ? input.exdates.map((entry) => normalizeCalendarTimeValue(entry, 'Recurrence exclusion'))
      : undefined,
  };
}

function normalizeSourceBinding(value: unknown): CalendarSourceBinding | undefined {
  if (value == null) return undefined;
  const input = record(value, 'Calendar source binding');
  if (input.kind === 'kanban') {
    return {
      kind: 'kanban',
      serverUrl: optionalString(input.serverUrl, 'Source server URL', 2_048),
      vaultId: optionalString(input.vaultId, 'Source vault ID', 255),
      fileId: requiredString(input.fileId, 'Source file ID', 255),
      cardId: requiredString(input.cardId, 'Source card ID', 255),
      path: optionalString(input.path, 'Source display path', 2_048),
      sourceRevision: input.sourceRevision == null
        ? undefined
        : nonNegativeInteger(input.sourceRevision, 'Source revision'),
    };
  }
  if (input.kind === 'external') {
    return {
      kind: 'external',
      subscriptionId: requiredString(input.subscriptionId, 'Subscription ID', 255),
      externalUid: requiredString(input.externalUid, 'External UID', 2_048),
    };
  }
  throw new CalendarValidationError('Calendar source binding kind is invalid.');
}

function normalizeIcalendarProperties(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_CALENDAR_ICALENDAR_PROPERTIES) {
    throw new CalendarValidationError(`Calendar items cannot preserve more than ${MAX_CALENDAR_ICALENDAR_PROPERTIES} iCalendar properties.`);
  }
  const properties = value.map((entry) => {
    const line = requiredString(
      entry,
      'Preserved iCalendar property',
      MAX_CALENDAR_ICALENDAR_PROPERTY_LENGTH,
    );
    if (/[\r\n]/.test(line)
      || !/^X-[A-Z0-9-]+(?:;[^:]*)?:/i.test(line)
      || /^X-COLLAB-/i.test(line)) {
      throw new CalendarValidationError('Preserved iCalendar properties must be safe X-* content lines.');
    }
    return line;
  });
  return properties.length ? properties : undefined;
}

function normalizeItemBase(input: Record<string, unknown>) {
  const attendees = Array.isArray(input.attendees) ? input.attendees : [];
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  if (attendees.length > MAX_CALENDAR_ATTENDEES) {
    throw new CalendarValidationError(`Calendar items cannot have more than ${MAX_CALENDAR_ATTENDEES} attendees.`);
  }
  if (attachments.length > MAX_CALENDAR_ATTACHMENTS) {
    throw new CalendarValidationError(`Calendar items cannot have more than ${MAX_CALENDAR_ATTACHMENTS} attachments.`);
  }
  return {
    id: requiredString(input.id, 'Calendar item ID', 255),
    uid: requiredString(input.uid, 'Calendar item UID', 2_048),
    calendarId: requiredString(input.calendarId, 'Calendar ID', 255),
    title: requiredString(input.title, 'Calendar item title', MAX_CALENDAR_ITEM_TITLE_LENGTH),
    description: optionalString(input.description, 'Calendar item description', MAX_CALENDAR_ITEM_TEXT_LENGTH),
    url: optionalString(input.url, 'Calendar item URL', 2_048),
    reminders: Array.isArray(input.reminders) ? input.reminders.map(normalizeReminder) : [],
    attendees: attendees.map(normalizeAttendee),
    attachments: attachments.map(normalizeAttachment),
    recurrence: normalizeRecurrence(input.recurrence),
    recurrenceId: input.recurrenceId == null
      ? undefined
      : normalizeCalendarTimeValue(input.recurrenceId, 'Recurrence instance'),
    recurrenceSeriesId: optionalString(input.recurrenceSeriesId, 'Recurrence series ID', 255),
    sourceBinding: normalizeSourceBinding(input.sourceBinding),
    icalendarProperties: normalizeIcalendarProperties(input.icalendarProperties),
    revision: nonNegativeInteger(input.revision, 'Calendar item revision'),
    createdAt: normalizeInstant(input.createdAt, 'Calendar item createdAt'),
    updatedAt: normalizeInstant(input.updatedAt, 'Calendar item updatedAt'),
    deletedAt: input.deletedAt == null ? undefined : normalizeInstant(input.deletedAt, 'Calendar item deletedAt'),
  };
}

function timeSortValue(value: CalendarTimeValue, endOfDay: boolean): number {
  if (value.kind === 'dateTime') return new Date(value.dateTime).getTime();
  return new Date(`${value.date}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`).getTime();
}

function assertCompatibleRange(start: CalendarTimeValue, end: CalendarTimeValue) {
  if (start.kind !== end.kind) {
    throw new CalendarValidationError('Calendar event start and end must both be dates or both be date-times.');
  }
  // All-day end dates are exclusive, matching iCalendar DTEND semantics.
  const startValue = timeSortValue(start, false);
  const endValue = timeSortValue(end, false);
  if (endValue <= startValue) {
    throw new CalendarValidationError('Calendar event end must be after its start.');
  }
}

export function normalizeCalendarDefinition(value: unknown): CalendarDefinition {
  const input = record(value, 'Calendar');
  const defaultTimeZone = requiredString(input.defaultTimeZone, 'Default time zone', 255);
  if (!isCalendarTimeZone(defaultTimeZone)) {
    throw new CalendarValidationError('Default time zone is not a recognized IANA time zone.');
  }
  const location = normalizeLocation(input.location);
  const color = requiredString(input.color, 'Calendar color', 20);
  if (!/^#[0-9a-f]{6}$/i.test(color)) {
    throw new CalendarValidationError('Calendar color must be a six-digit hex color.');
  }
  const readOnlyByLocation = location.kind === 'subscription' || location.kind === 'kanban';
  return {
    schemaVersion: CALENDAR_SCHEMA_VERSION,
    id: requiredString(input.id, 'Calendar ID', 255),
    globalId: requiredString(input.globalId, 'Calendar global ID', 255),
    location,
    name: requiredString(input.name, 'Calendar name', MAX_CALENDAR_NAME_LENGTH),
    color: color.toLowerCase(),
    defaultTimeZone,
    archived: input.archived === true,
    readOnly: readOnlyByLocation || input.readOnly === true,
    revision: nonNegativeInteger(input.revision, 'Calendar revision'),
    createdAt: normalizeInstant(input.createdAt, 'Calendar createdAt'),
    updatedAt: normalizeInstant(input.updatedAt, 'Calendar updatedAt'),
    deletedAt: input.deletedAt == null ? undefined : normalizeInstant(input.deletedAt, 'Calendar deletedAt'),
  };
}

export function normalizeCalendarItem(value: unknown): CalendarItem {
  const input = record(value, 'Calendar item');
  const base = normalizeItemBase(input);
  if (input.kind === 'event') {
    const start = normalizeCalendarTimeValue(input.start, 'Event start');
    const end = normalizeCalendarTimeValue(input.end, 'Event end');
    assertCompatibleRange(start, end);
    return {
      ...base,
      kind: 'event',
      start,
      end,
      location: normalizeEventLocation(input.location),
      availability: input.availability === 'free' ? 'free' : 'busy',
    };
  }
  if (input.kind === 'task') {
    const status: CalendarTaskStatus = input.status === 'in-progress'
      || input.status === 'completed'
      || input.status === 'cancelled'
      ? input.status
      : 'needs-action';
    const priority = input.priority === 'low' || input.priority === 'medium' || input.priority === 'high'
      ? input.priority
      : undefined;
    return {
      ...base,
      kind: 'task',
      start: input.start == null ? undefined : normalizeCalendarTimeValue(input.start, 'Task start'),
      due: input.due == null ? undefined : normalizeCalendarTimeValue(input.due, 'Task due'),
      priority,
      status,
      completedAt: input.completedAt == null ? undefined : normalizeInstant(input.completedAt, 'Task completedAt'),
    };
  }
  if (input.kind === 'birthday') {
    const date = normalizeDate(input.date, 'Birthday date');
    const derivedYear = Number(date.slice(0, 4));
    const birthYear = input.birthYear == null
      ? undefined
      : nonNegativeInteger(input.birthYear, 'Birth year');
    if (birthYear != null && (birthYear < 1 || birthYear > derivedYear)) {
      throw new CalendarValidationError('Birth year must not be later than the birthday date year.');
    }
    return { ...base, kind: 'birthday', date, birthYear };
  }
  throw new CalendarValidationError('Calendar item kind is invalid.');
}

export function calendarItemRange(item: CalendarItem): { start: number; end: number } | null {
  if (item.kind === 'event') {
    return {
      start: timeSortValue(item.start, false),
      end: timeSortValue(item.end, false),
    };
  }
  if (item.kind === 'task') {
    const start = item.start ?? item.due;
    const end = item.due ?? item.start;
    if (!start || !end) return null;
    return {
      start: timeSortValue(start, false),
      end: timeSortValue(end, true),
    };
  }
  const year = new Date().getUTCFullYear();
  const monthDay = item.date.slice(4);
  const start = new Date(`${year}${monthDay}T00:00:00.000Z`).getTime();
  return { start, end: start + 86_400_000 };
}

function normalizeQueryBound(value: string, label: string): number {
  if (isCalendarDate(value)) return new Date(`${value}T00:00:00.000Z`).getTime();
  return new Date(normalizeInstant(value, label)).getTime();
}

export function queryCalendarItems(items: CalendarItem[], range: CalendarQueryRange): CalendarItem[] {
  const from = normalizeQueryBound(range.from, 'Calendar query start');
  const to = normalizeQueryBound(range.to, 'Calendar query end');
  if (to <= from) throw new CalendarValidationError('Calendar query end must be after its start.');
  const requestedLimit = range.limit ?? 500;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_CALENDAR_QUERY_ITEMS) {
    throw new CalendarValidationError(`Calendar query limit must be between 1 and ${MAX_CALENDAR_QUERY_ITEMS}.`);
  }

  const masterById = new Map(items.filter((item) => item.recurrence && !item.recurrenceId)
    .map((item) => [item.id, item]));
  const activeExceptions = new Set(items.flatMap((item) => {
    if (!item.recurrenceId) return [];
    const master = item.recurrenceSeriesId ? masterById.get(item.recurrenceSeriesId) : undefined;
    if (master && (master.deletedAt || !recurrenceIncludes(master, item.recurrenceId))) return [];
    return [item.id];
  }));
  const exceptionKeys = new Set(items.flatMap((item) => item.recurrenceId && activeExceptions.has(item.id)
    ? [`${item.calendarId}\u0000${item.uid}\u0000${calendarTimeValueKey(item.recurrenceId)}`]
    : []));
  const expanded: CalendarItem[] = [];
  for (const item of items) {
    const remaining = MAX_CALENDAR_EXPANDED_CANDIDATES - expanded.length;
    if (remaining <= 0) break;
    if (item.recurrenceId) {
      if (!activeExceptions.has(item.id)) continue;
      const master = item.recurrenceSeriesId ? masterById.get(item.recurrenceSeriesId) : undefined;
      expanded.push(master && !item.recurrence ? { ...item, recurrence: master.recurrence } : item);
      continue;
    }
    const occurrences = expandRecurringItem(item, from, to, Math.min(requestedLimit, remaining));
    expanded.push(...occurrences.filter((occurrence) => !occurrence.recurrenceId || !exceptionKeys.has(
      `${occurrence.calendarId}\u0000${occurrence.uid}\u0000${calendarTimeValueKey(occurrence.recurrenceId)}`,
    )));
  }
  return expanded
    .filter((item) => range.includeDeleted === true || item.deletedAt == null)
    .map<{ item: CalendarItem; itemRange: { start: number; end: number } | null }>((item) => {
      if (item.kind !== 'birthday') return { item, itemRange: calendarItemRange(item) };
      const monthDay = item.date.slice(4);
      const fromYear = new Date(from).getUTCFullYear();
      const toYear = new Date(Math.max(from, to - 1)).getUTCFullYear();
      for (let year = fromYear; year <= toYear; year += 1) {
        const start = new Date(`${year}${monthDay}T00:00:00.000Z`).getTime();
        if (Number.isFinite(start) && start < to && start + 86_400_000 > from) {
          return { item, itemRange: { start, end: start + 86_400_000 } };
        }
      }
      return { item, itemRange: null };
    })
    .filter((entry) => (
      entry.itemRange != null
        ? entry.itemRange.start < to && entry.itemRange.end > from
        : range.includeUnscheduledTasks === true && entry.item.kind === 'task'
    ))
    .sort((left, right) => (left.itemRange?.start ?? Number.POSITIVE_INFINITY)
      - (right.itemRange?.start ?? Number.POSITIVE_INFINITY)
      || left.item.title.localeCompare(right.item.title)
      || left.item.id.localeCompare(right.item.id))
    .slice(0, requestedLimit)
    .map((entry) => entry.item);
}

export function calendarTimeValueKey(value: CalendarTimeValue): string {
  return value.kind === 'date' ? `date:${value.date}` : `dateTime:${value.dateTime}`;
}

export function createCalendarDefinition(input: {
  id?: string;
  globalId?: string;
  location: CalendarLocation;
  name: string;
  color: string;
  defaultTimeZone: string;
  now?: string;
}): CalendarDefinition {
  const now = input.now ?? new Date().toISOString();
  return normalizeCalendarDefinition({
    schemaVersion: CALENDAR_SCHEMA_VERSION,
    id: input.id ?? crypto.randomUUID(),
    globalId: input.globalId ?? crypto.randomUUID(),
    location: input.location,
    name: input.name,
    color: input.color,
    defaultTimeZone: input.defaultTimeZone,
    archived: false,
    readOnly: false,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  });
}
