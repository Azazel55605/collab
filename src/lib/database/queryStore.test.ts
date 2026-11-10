import { beforeEach, expect, it, vi } from 'vitest';

import type {
  DatabaseBinding,
  DatabaseColumn,
  DatabaseResultEvent,
  DatabaseResultFrame,
} from '../../types/database';
import { hasDatabaseDrafts } from '../databaseLifecycle';
import { tauriCommands } from '../tauri';

import {
  applyFrame,
  ensureQuery,
  executeQuery,
  syncQueryTabs,
  updateQuery,
  useDatabaseQueries,
} from './queryStore';

vi.mock('../tauri', () => ({
  tauriCommands: {
    databaseQueryStart: vi.fn(),
    databaseQueryPoll: vi.fn(),
    databaseQueryCancel: vi.fn(),
    databaseQueryStatus: vi.fn(),
  },
}));
const binding: DatabaseBinding = {
  profile_id: 'p',
  connection_id: 'c',
  session_id: 's',
  tab_id: 't',
  database: 'db',
  generation: 1,
};
const column: DatabaseColumn = {
  name: 'id',
  engine_type: 'BigInt',
  nullable: false,
  generated: false,
  version_token: false,
  precision: null,
  scale: null,
};
const frame = (event: DatabaseResultEvent, sequence: number): DatabaseResultFrame => ({
  binding,
  query_id: 'q',
  sequence,
  event,
});
beforeEach(() => {
  useDatabaseQueries.setState({ tabs: {} });
  ensureQuery(binding);
  vi.clearAllMocks();
  vi.mocked(tauriCommands.databaseQueryCancel).mockResolvedValue(undefined);
});
it('keeps exact cells, enforces full binding and byte bounds, and rejects rows without columns', () => {
  updateQuery('t', (t) => ({ ...t, status: { ...t.status, query_id: 'q' } }));
  let tab = useDatabaseQueries.getState().tabs.t;
  expect(() => applyFrame(tab, frame({ event: 'rows', result_set: 0, rows: [] }, 0))).toThrow();
  tab = applyFrame(tab, frame({ event: 'columns', result_set: 0, columns: [column] }, 0));
  tab = applyFrame(
    tab,
    frame(
      {
        event: 'rows',
        result_set: 0,
        rows: [[{ kind: 'integer', decimal: '9223372036854775807' }]],
      },
      1,
    ),
  );
  expect(tab.results[0].rows[0][0]).toEqual({ kind: 'integer', decimal: '9223372036854775807' });
  expect(() =>
    applyFrame(tab, {
      ...frame({ event: 'message', severity: 0, safe_text: 'x' }, 2),
      binding: { ...binding, database: 'other' },
    }),
  ).toThrow('stale_query');
  expect(() =>
    applyFrame(
      { ...tab, bytes: 8 * 1024 * 1024 - 1 },
      frame({ event: 'message', severity: 0, safe_text: 'x' }, 2),
    ),
  ).toThrow('limit_reached');
});
it('starts only on explicit execution and acknowledges each frame before accepting another', async () => {
  expect(tauriCommands.databaseQueryStart).not.toHaveBeenCalled();
  updateQuery('t', (t) => ({ ...t, sql: 'SELECT 1', dirty: true }));
  vi.mocked(tauriCommands.databaseQueryStart).mockResolvedValue('q');
  const status = {
    query_id: 'q',
    phase: 'idle' as const,
    transaction: 'none' as const,
    reason: 'complete' as const,
  };
  vi.mocked(tauriCommands.databaseQueryPoll)
    .mockResolvedValueOnce({
      frame: frame({ event: 'columns', result_set: 0, columns: [column] }, 0),
      status,
    })
    .mockResolvedValueOnce({
      frame: frame({ event: 'rows', result_set: 0, rows: [[{ kind: 'null' }]] }, 1),
      status,
    })
    .mockResolvedValueOnce({ frame: frame({ event: 'finished', reason: 'complete' }, 2), status })
    .mockResolvedValueOnce({ frame: null, status });
  await executeQuery('token', binding, { start_utf16: 0, end_utf16: 8 });
  expect(tauriCommands.databaseQueryStart).toHaveBeenCalledWith('token', binding, 'SELECT 1', {
    start_utf16: 0,
    end_utf16: 8,
  });
  expect(vi.mocked(tauriCommands.databaseQueryPoll).mock.calls.map((args) => args[3])).toEqual([
    null,
    0,
    1,
    2,
  ]);
  expect(useDatabaseQueries.getState().tabs.t.results[0].rows).toEqual([[{ kind: 'null' }]]);
});
it('cancels a protocol failure without replaying SQL', async () => {
  updateQuery('t', (t) => ({ ...t, sql: 'INSERT t VALUES (1)' }));
  vi.mocked(tauriCommands.databaseQueryStart).mockResolvedValue('q');
  const status = {
    query_id: 'q',
    phase: 'idle' as const,
    transaction: 'none' as const,
    reason: null,
  };
  vi.mocked(tauriCommands.databaseQueryPoll).mockResolvedValue({
    frame: frame({ event: 'message', severity: 0, safe_text: 'bad sequence' }, 99),
    status,
  });
  vi.mocked(tauriCommands.databaseQueryStatus).mockResolvedValue(status);
  await executeQuery('token', binding);
  expect(tauriCommands.databaseQueryStart).toHaveBeenCalledTimes(1);
  expect(tauriCommands.databaseQueryCancel).toHaveBeenCalledWith('token', binding, 'q');
  expect(useDatabaseQueries.getState().tabs.t.error?.code).toBe('invalid_sequence');
});
it('guards dirty SQL by profile and clears it only after native profile teardown succeeds', () => {
  updateQuery('t', (t) => ({ ...t, dirty: true, sql: 'private SQL' }));
  expect(hasDatabaseDrafts('p')).toBe(true);
  expect(hasDatabaseDrafts('other')).toBe(false);
  window.dispatchEvent(
    new CustomEvent('database:profile-closed', { detail: { profile: 'other' } }),
  );
  expect(useDatabaseQueries.getState().tabs.t.sql).toBe('private SQL');
  window.dispatchEvent(new CustomEvent('database:profile-closed', { detail: { profile: 'p' } }));
  expect(useDatabaseQueries.getState().tabs).toEqual({});
});

it('drops result and SQL caches when a native registry snapshot retires their sessions', () => {
  updateQuery('t', (t) => ({ ...t, sql: 'private SQL', dirty: true }));
  syncQueryTabs('p', {
    token: 'token',
    profiles: [],
    connections: [],
    tabs: [],
    durable_credentials: true,
  });
  expect(useDatabaseQueries.getState().tabs).toEqual({});
});
