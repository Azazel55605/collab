import { create } from 'zustand';

import type {
  DatabaseBinding,
  DatabaseBrowseRequest,
  DatabaseColumn,
  DatabaseExecutionError,
  DatabaseFinishReason,
  DatabaseQueryStatus,
  DatabaseResultFrame,
  DatabaseValue,
  DatabaseWorkspace,
} from '../../types/database';
import { registerDatabaseDraftGuard } from '../databaseLifecycle';
import { tauriCommands } from '../tauri';

export interface ResultSet {
  columns: DatabaseColumn[];
  rows: DatabaseValue[][];
}
export interface ScriptFile {
  vaultId: string;
  path: string;
  version: string;
  base: string;
}
export interface QueryTab {
  script: ScriptFile | null;
  browse: DatabaseBrowseRequest | null;
  binding: DatabaseBinding;
  sql: string;
  dirty: boolean;
  status: DatabaseQueryStatus;
  results: Record<number, ResultSet>;
  messages: string[];
  counts: string[];
  error: DatabaseExecutionError | null;
  reason: DatabaseFinishReason | null;
  receiving: boolean;
  bytes: number;
}
interface State {
  tabs: Record<string, QueryTab>;
}
export const idleStatus: DatabaseQueryStatus = {
  query_id: null,
  phase: 'idle',
  transaction: 'none',
  reason: null,
};
export const useDatabaseQueries = create<State>(() => ({ tabs: {} }));
export function ensureQuery(binding: DatabaseBinding) {
  if (!useDatabaseQueries.getState().tabs[binding.tab_id])
    useDatabaseQueries.setState((state) => ({
      tabs: {
        ...state.tabs,
        [binding.tab_id]: {
          script: null,
          browse: null,
          binding,
          sql: '',
          dirty: false,
          status: idleStatus,
          results: {},
          messages: [],
          counts: [],
          error: null,
          reason: null,
          receiving: false,
          bytes: 0,
        },
      },
    }));
}
export function updateQuery(id: string, update: (tab: QueryTab) => QueryTab) {
  useDatabaseQueries.setState((state) => {
    const tab = state.tabs[id];
    return tab ? { tabs: { ...state.tabs, [id]: update(tab) } } : state;
  });
}
export function forgetQuery(id: string) {
  useDatabaseQueries.setState((state) => {
    const tabs = { ...state.tabs };
    delete tabs[id];
    return { tabs };
  });
}
registerDatabaseDraftGuard((profile) =>
  Object.values(useDatabaseQueries.getState().tabs).some(
    (tab) => tab.dirty && (!profile || tab.binding.profile_id === profile),
  ),
);
window.addEventListener('database:profile-closed', (event) => {
  const profile = (event as CustomEvent<{ profile: string }>).detail.profile;
  useDatabaseQueries.setState((state) => ({
    tabs: Object.fromEntries(
      Object.entries(state.tabs).filter(([, tab]) => tab.binding.profile_id !== profile),
    ),
  }));
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export function applyFrame(tab: QueryTab, frame: DatabaseResultFrame): QueryTab {
  if (
    frame.binding.session_id !== tab.binding.session_id ||
    frame.binding.tab_id !== tab.binding.tab_id ||
    frame.binding.profile_id !== tab.binding.profile_id ||
    frame.binding.connection_id !== tab.binding.connection_id ||
    frame.binding.database !== tab.binding.database ||
    frame.binding.generation !== tab.binding.generation ||
    frame.query_id !== tab.status.query_id
  )
    throw new Error('stale_query');
  const size = bytes(frame);
  if (size > 256 * 1024 || tab.bytes + size > 8 * 1024 * 1024) throw new Error('limit_reached');
  const next = { ...tab, bytes: tab.bytes + size };
  const event = frame.event;
  switch (event.event) {
    case 'columns':
      if (event.columns.length > 256) throw new Error('limit_reached');
      next.results = { ...tab.results, [event.result_set]: { columns: event.columns, rows: [] } };
      break;
    case 'rows': {
      const result = tab.results[event.result_set];
      if (
        !result ||
        event.rows.length > 128 ||
        result.rows.length + event.rows.length > 100000 ||
        event.rows.some((row) => row.length !== result.columns.length)
      )
        throw new Error('invalid_sequence');
      next.results = {
        ...tab.results,
        [event.result_set]: { ...result, rows: [...result.rows, ...event.rows] },
      };
      break;
    }
    case 'message':
      if (tab.messages.length >= 256) throw new Error('limit_reached');
      next.messages = [...tab.messages, event.safe_text];
      break;
    case 'affected_rows':
      next.counts = [...tab.counts, event.exact_count];
      break;
    case 'failed':
      next.error = tab.browse ? { ...event.error, source: null } : event.error;
      next.receiving = false;
      break;
    case 'finished':
      next.reason = event.reason;
      next.receiving = false;
      break;
  }
  return next;
}
/** Pulls live outside component effects, so switching tabs/views cannot drop work.
 * Native sender has two credits and an independent slow-consumer deadline. */
export async function executeQuery(
  token: string,
  binding: DatabaseBinding,
  selection?: { start_utf16: number; end_utf16: number },
  rollback = false,
  browse?: DatabaseBrowseRequest,
) {
  ensureQuery(binding);
  const before = useDatabaseQueries.getState().tabs[binding.tab_id];
  if (before.receiving) return;
  updateQuery(binding.tab_id, (tab) => ({
    ...tab,
    receiving: true,
    browse: browse ?? null,
    status: { ...tab.status, phase: 'running', query_id: null },
    error: null,
    reason: null,
    results: {},
    messages: [],
    counts: [],
    bytes: 0,
  }));
  let id: string | null = null;
  let after: number | null = null;
  try {
    id = browse
      ? await tauriCommands.databaseTableBrowse(token, binding, browse)
      : rollback
        ? await tauriCommands.databaseQueryRollback(token, binding)
        : await tauriCommands.databaseQueryStart(token, binding, before.sql, selection);
    updateQuery(binding.tab_id, (tab) => ({
      ...tab,
      status: { ...tab.status, query_id: id, phase: 'running' },
    }));
    while (useDatabaseQueries.getState().tabs[binding.tab_id]?.receiving) {
      const poll = await tauriCommands.databaseQueryPoll(token, binding, id, after);
      const current = useDatabaseQueries.getState().tabs[binding.tab_id];
      if (!current || current.status.query_id !== id) break;
      updateQuery(binding.tab_id, (tab) => ({ ...tab, status: poll.status }));
      if (poll.frame) {
        if (poll.frame.sequence !== (after === null ? 0 : after + 1))
          throw new Error('invalid_sequence');
        updateQuery(binding.tab_id, (tab) => applyFrame(tab, poll.frame!));
        after = poll.frame.sequence;
        if (poll.frame.event.event === 'finished' || poll.frame.event.event === 'failed') {
          // Release the final native credit; no idle polling remains after completion.
          const final = await tauriCommands.databaseQueryPoll(token, binding, id, after);
          updateQuery(binding.tab_id, (tab) => ({
            ...tab,
            status: final.status,
            receiving: false,
          }));
          break;
        }
      } else if (poll.status.phase === 'retired' || poll.status.phase === 'outcome_unknown') {
        updateQuery(binding.tab_id, (tab) => ({
          ...tab,
          receiving: false,
          error: {
            code: 'connection_failed',
            source: null,
            server_code: null,
            outcome_unknown: poll.status.phase === 'outcome_unknown',
          },
        }));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, poll.frame ? 0 : 40));
    }
  } catch (error) {
    if (id) await tauriCommands.databaseQueryCancel(token, binding, id).catch(() => {});
    const code =
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : 'connection_failed';
    updateQuery(binding.tab_id, (tab) => ({
      ...tab,
      receiving: false,
      status: id ? tab.status : before.status,
      error: { code, source: null, server_code: null, outcome_unknown: !!id },
    }));
    if (id) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (!useDatabaseQueries.getState().tabs[binding.tab_id]) break;
        try {
          const status = await tauriCommands.databaseQueryStatus(token, binding);
          updateQuery(binding.tab_id, (t) => ({ ...t, status }));
          if (!['running', 'cancelling', 'finishing'].includes(status.phase)) break;
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

/** Native registry snapshots retire frontend caches as well as sockets. */
export function syncQueryTabs(profile: string, workspace: DatabaseWorkspace) {
  const valid = new Set(workspace.tabs.map((tab) => tab.tab_id));
  useDatabaseQueries.setState((state) => ({
    tabs: Object.fromEntries(
      Object.entries(state.tabs).filter(
        ([id, tab]) => tab.binding.profile_id !== profile || valid.has(id),
      ),
    ),
  }));
}
