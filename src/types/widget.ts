export const WIDGET_SCHEMA_VERSION = 1;

export type WidgetKind =
  | 'agenda'
  | 'month'
  | 'birthday'
  | 'countdown'
  | 'tasks'
  | 'capture'
  | 'shortcuts';
/** A quick-capture tile. Each only opens an existing mobile flow. */
export type WidgetCaptureAction = 'note' | 'task' | 'event' | 'files';
export type WidgetEntryKind =
  | 'note'
  | 'board'
  | 'canvas'
  | 'sheet'
  | 'pdf'
  | 'folder'
  | 'file';
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
