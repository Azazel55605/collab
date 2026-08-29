export const WIDGET_SCHEMA_VERSION = 1;

export type WidgetKind =
  'agenda' | 'month' | 'birthday' | 'countdown' | 'tasks' | 'capture' | 'shortcuts' | 'sync';
/** A quick-capture tile. Each only opens an existing mobile flow. */
export type WidgetCaptureAction = 'note' | 'task' | 'event' | 'files';
export type WidgetEntryKind = 'note' | 'board' | 'canvas' | 'sheet' | 'pdf' | 'folder' | 'file';
export type WidgetPrivacy = 'full' | 'titleOnly' | 'private';
export type WidgetTaskSource = 'calendar' | 'kanban';
export type WidgetTaskDue = 'overdue' | 'today' | 'upcoming' | 'unscheduled';
/** Whether a launcher tap may complete a task natively, must hand off to the
 * app, or has no completion action at all. Decided in Rust before publication. */
export type WidgetTaskCompletion = 'available' | 'confirmInApp' | 'unavailable';

export interface WidgetDisplayOptions {
  horizonDays: number;
  maxItems: number;
  showCompleted: boolean;
}

export interface WidgetActionOptions {
  openItem: boolean;
  toggleTask: boolean;
}

/**
 * Task-widget source selection. Account, vault, and assignee filtering is
 * expressed through `selectedSourceIds`, because each hosted account and each
 * Kanban origin owns its own calendar and the Kanban projection is already
 * scoped to the signed-in user's assignments.
 */
export interface WidgetTaskOptions {
  includeCalendarTasks: boolean;
  includeKanbanTasks: boolean;
  includeUndated: boolean;
  /** Opaque Kanban board file identifiers. Empty means every board. */
  selectedBoardIds: string[];
}

export interface WidgetCaptureOptions {
  actions: WidgetCaptureAction[];
}

/** A pinned vault entry, addressed only by stable opaque identity. The owning
 * server is resolved from the replica inventory, never stored here. */
export interface WidgetPinnedTarget {
  vaultId: string;
  fileId: string;
}

export interface WidgetShortcutOptions {
  pinned: WidgetPinnedTarget[];
  includeRecent: boolean;
}

/** The operational rollup a sync widget renders. Decided in Rust from the
 * background ledger and the replica queues. */
export type WidgetSyncState =
  | 'upToDate'
  | 'syncing'
  | 'pendingChanges'
  | 'actionRequired'
  | 'authenticationRequired'
  | 'offline'
  | 'paused';

/**
 * The privacy-safe synchronization rollup carried by a sync snapshot. Every
 * field is a count, a coarse state, or a pre-rendered phrase — never a server
 * URL, an account name, or an error body.
 */
export interface WidgetSyncSummary {
  state: WidgetSyncState;
  lastSuccessAt?: string;
  lastSuccessLabel?: string;
  pendingOperations: number;
  failedOperations: number;
  activeJobs: number;
  attentionRequired: number;
  accounts: number;
  vaults: number;
  progressCompleted: number;
  progressTotal?: number;
  canSyncNow: boolean;
}

/**
 * One hosted account a sync widget can be scoped to. `accountId` is the opaque
 * identity stored in the configuration; `label` is the server URL and is for
 * in-app settings only — it must never reach a snapshot or launcher storage.
 */
export interface WidgetSyncAccount {
  accountId: string;
  label: string;
  vaults: number;
}

export interface WidgetConfiguration {
  schemaVersion: number;
  configurationId: string;
  kind: WidgetKind;
  selectedSourceIds: string[];
  selectedItemIds: string[];
  privacy: WidgetPrivacy;
  display: WidgetDisplayOptions;
  actions: WidgetActionOptions;
  tasks: WidgetTaskOptions;
  capture: WidgetCaptureOptions;
  shortcuts: WidgetShortcutOptions;
  updatedAt: string;
}

export interface WidgetAppearanceSnapshot {
  schemaVersion: number;
  theme: 'dark' | 'midnight' | 'warm' | 'light';
  accent: 'violet' | 'blue' | 'emerald' | 'rose' | 'orange' | 'cyan';
  fontScale: number;
  timeZone: string;
  timeFormat: 'system' | '12-hour' | '24-hour';
  showDeclined: boolean;
}

export interface WidgetDiagnostics {
  schemaVersion: number;
  configurationId: string;
  lastAttemptAt: string;
  lastSuccessAt?: string;
  lastError?: string;
  updateCause: string;
  generationDurationMs: number;
  serializedBytes: number;
  itemCount: number;
  truncated: boolean;
  freshSources: number;
  staleSources: number;
  unavailableSources: number;
}
