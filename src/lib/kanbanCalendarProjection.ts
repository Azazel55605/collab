import {
  createCalendarDefinition,
  normalizeCalendarItem,
  type CalendarDefinition,
  type CalendarRecurrence,
  type CalendarTask,
  type CalendarTimeValue,
} from '../types/calendar';
import {
  normalizeKanbanBoard,
  type KanbanBoard,
  type KanbanRecurrenceRule,
} from '../types/kanban';
import { tauriCommands } from './tauri';
import { createVaultClient } from './vaultClient';
import type { VaultMeta } from '../types/vault';

export interface LocalKanbanProjectionSource {
  fileId: string;
  path: string;
  sourceRevision: number;
  content: string;
}

export interface LocalKanbanProjection {
  calendar: CalendarDefinition;
  items: CalendarTask[];
}

export interface KanbanCalendarPatch {
  startDate?: string;
  dueDate?: string;
  completed: boolean;
  recurrence?: KanbanRecurrenceRule;
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function recurrenceFromKanban(rule: KanbanRecurrenceRule | null | undefined): CalendarRecurrence | undefined {
  if (!rule?.enabled) return undefined;
  const interval = Math.max(1, Math.min(365, Math.trunc(rule.interval ?? 1)));
  if (rule.mode === 'weekly') {
    const days = (rule.weekdays ?? [])
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      .map((day) => WEEKDAYS[day]);
    return { rrule: `FREQ=WEEKLY;INTERVAL=${interval}${days.length ? `;BYDAY=${days.join(',')}` : ''}` };
  }
  if (rule.mode === 'monthly') return { rrule: `FREQ=MONTHLY;INTERVAL=${interval}` };
  return { rrule: `FREQ=DAILY;INTERVAL=${interval}` };
}

function recurrenceToKanban(recurrence: CalendarRecurrence | undefined): KanbanRecurrenceRule | undefined {
  if (!recurrence) return undefined;
  const parts = new Map(recurrence.rrule.split(';').flatMap((entry) => {
    const [key, value] = entry.split('=', 2);
    return key && value ? [[key.toUpperCase(), value.toUpperCase()] as const] : [];
  }));
  const interval = Math.max(1, Number.parseInt(parts.get('INTERVAL') ?? '1', 10) || 1);
  const frequency = parts.get('FREQ');
  if (frequency === 'DAILY') return { enabled: true, mode: interval === 1 ? 'daily' : 'interval', interval };
  if (frequency === 'MONTHLY') return { enabled: true, mode: 'monthly', interval };
  if (frequency === 'WEEKLY') {
    const weekdays = (parts.get('BYDAY') ?? '').split(',').flatMap((day) => {
      const index = WEEKDAYS.indexOf(day);
      return index >= 0 ? [index] : [];
    });
    return { enabled: true, mode: 'weekly', interval, weekdays };
  }
  throw new Error('This recurrence rule cannot be written to a Kanban task.');
}

function dateValue(date: string | undefined): CalendarTimeValue | undefined {
  return date ? { kind: 'date', date } : undefined;
}

function dateFromTime(value: CalendarTimeValue | undefined): string | undefined {
  if (!value) return undefined;
  return value.kind === 'date' ? value.date : value.dateTime.slice(0, 10);
}

function timestamp(value: number | null | undefined, fallback: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function stableSegment(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function projectLocalKanbanCalendar(input: {
  profileId: string;
  originKey: string;
  vaultName: string;
  sources: LocalKanbanProjectionSource[];
  now?: string;
  defaultTimeZone?: string;
}): LocalKanbanProjection {
  const now = input.now ?? new Date().toISOString();
  const calendarId = `kanban-local-${stableSegment(input.originKey)}`;
  const latestRevision = input.sources.reduce(
    (latest, source) => Math.max(latest, Math.max(0, Math.trunc(source.sourceRevision))),
    0,
  );
  const calendar = createCalendarDefinition({
    id: calendarId,
    globalId: calendarId,
    location: { kind: 'kanban', originKey: input.originKey },
    name: `Assigned tasks · ${input.vaultName}`,
    color: '#a78bfa',
    defaultTimeZone: input.defaultTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    now,
  });
  calendar.revision = latestRevision;
  calendar.readOnly = true;

  const items = input.sources.flatMap((source) => {
    let board: KanbanBoard;
    try {
      board = normalizeKanbanBoard(JSON.parse(source.content));
    } catch {
      return [];
    }
    return board.columns.flatMap((column) => column.cards.flatMap((card) => {
      if (card.archived || !card.assignees.includes(input.profileId)) return [];
      const id = `${calendarId}-${stableSegment(`${source.fileId}\0${card.id}`)}`;
      return [normalizeCalendarItem({
        id,
        uid: `kanban:${input.originKey}:${source.fileId}:${card.id}`,
        calendarId,
        kind: 'task',
        title: card.title.trim() || 'Untitled task',
        description: card.description,
        reminders: [],
        attendees: [],
        attachments: [{
          id: `kanban:${source.fileId}:${card.id}`,
          kind: 'kanbanTask',
          name: card.title.trim() || 'Open Kanban task',
          fileId: source.fileId,
          cardId: card.id,
          path: source.path,
        }],
        sourceBinding: {
          kind: 'kanban',
          fileId: source.fileId,
          cardId: card.id,
          path: source.path,
          sourceRevision: Math.max(0, Math.trunc(source.sourceRevision)),
        },
        start: dateValue(card.startDate),
        due: dateValue(card.dueDate),
        recurrence: recurrenceFromKanban(card.recurrence),
        priority: card.priority,
        status: card.isDone ? 'completed' : 'needs-action',
        completedAt: card.isDone ? timestamp(card.completedAt, now) : undefined,
        revision: Math.max(0, Math.trunc(source.sourceRevision)),
        createdAt: timestamp(card.createdAt, now),
        updatedAt: now,
      }) as CalendarTask];
    }));
  });
  return { calendar, items };
}

export function calendarTaskToKanbanPatch(task: CalendarTask): KanbanCalendarPatch {
  return {
    startDate: dateFromTime(task.start),
    dueDate: dateFromTime(task.due),
    completed: task.status === 'completed',
    recurrence: recurrenceToKanban(task.recurrence),
  };
}

export function applyCalendarPatchToKanban(
  input: unknown,
  cardId: string,
  patch: KanbanCalendarPatch,
): KanbanBoard {
  const board = normalizeKanbanBoard(input as KanbanBoard);
  let found = false;
  const columns = board.columns.map((column) => ({
    ...column,
    cards: column.cards.map((card) => {
      if (card.id !== cardId) return card;
      found = true;
      return {
        ...card,
        startDate: patch.startDate,
        dueDate: patch.dueDate,
        isDone: patch.completed,
        completedAt: patch.completed ? card.completedAt ?? Date.now() : null,
        recurrence: patch.recurrence ?? null,
      };
    }),
  }));
  if (!found) throw new Error('The linked Kanban task no longer exists.');
  return { ...board, columns };
}

export async function writeThroughKanbanCalendarTask(
  original: CalendarTask,
  edited: CalendarTask,
  activeVault: VaultMeta | null,
): Promise<CalendarTask> {
  const binding = original.sourceBinding;
  if (binding?.kind !== 'kanban') throw new Error('The task is not linked to a Kanban card.');
  const patch = calendarTaskToKanbanPatch(edited);
  if (binding.serverUrl && binding.vaultId) {
    await tauriCommands.hostedVaultRequest(
      binding.serverUrl,
      'POST',
      `/api/v1/vaults/${encodeURIComponent(binding.vaultId)}/files/${encodeURIComponent(binding.fileId)}/kanban-cards/${encodeURIComponent(binding.cardId)}/calendar`,
      {
        expectedSourceRevision: binding.sourceRevision ?? 0,
        ...patch,
      },
    );
  } else {
    if (!activeVault || activeVault.kind !== 'local' || !binding.path) {
      throw new Error('Open the source vault before editing this Kanban task.');
    }
    const client = createVaultClient(activeVault);
    const source = (await client.listFiles()).flatMap(function flatten(file): typeof file[] {
      return [file, ...(file.children ?? []).flatMap(flatten)];
    }).find((file) => file.relativePath === binding.path);
    if (!source || source.isFolder) throw new Error('The linked Kanban board is unavailable.');
    if (binding.sourceRevision != null && Math.trunc(source.modifiedAt) !== binding.sourceRevision) {
      throw new Error('The Kanban task changed. Refresh Calendar before editing it.');
    }
    const document = await client.readDocument(binding.path);
    const board = applyCalendarPatchToKanban(JSON.parse(document.content), binding.cardId, patch);
    const result = await client.writeDocument(
      binding.path,
      JSON.stringify(board, null, 2),
      document.version,
      document.content,
    );
    if (result.conflict) throw new Error('The Kanban task changed while Calendar was saving it.');
  }
  return normalizeCalendarItem({
    ...original,
    start: edited.start,
    due: edited.due,
    status: edited.status === 'completed' ? 'completed' : 'needs-action',
    completedAt: edited.status === 'completed' ? edited.completedAt ?? new Date().toISOString() : undefined,
    recurrence: edited.recurrence,
    revision: original.revision + 1,
    updatedAt: new Date().toISOString(),
    sourceBinding: {
      ...binding,
      sourceRevision: (binding.sourceRevision ?? 0) + 1,
    },
  }) as CalendarTask;
}
