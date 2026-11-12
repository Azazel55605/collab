import { beforeEach, expect, it, vi } from 'vitest';

import type { DatabaseBinding, DatabaseEditChange, DatabaseEditPage } from '../../types/database';
import { tauriCommands } from '../tauri';

import { ensureQuery, hasQueryDraft, updateQuery, useDatabaseQueries } from './queryStore';
import { applyTableEdit, openTableEdit, reloadTableEdit } from './tableEditing';

vi.mock('../tauri', () => ({
  tauriCommands: { databaseEditLoad: vi.fn(), databaseEditApply: vi.fn() },
}));

const binding: DatabaseBinding = {
  profile_id: 'profile',
  connection_id: 'connection',
  session_id: 'session',
  tab_id: 'edit',
  database: 'test',
  generation: 1,
};
const request = { schema: 'dbo', table: 'Products', filter_column: null, filter_text: '' };
const page: DatabaseEditPage = {
  id: 'snapshot',
  schema: 'dbo',
  table: 'Products',
  columns: [],
  rows: [],
  more: false,
};
const change: DatabaseEditChange = { kind: 'insert', values: [] };
const tab = () => useDatabaseQueries.getState().tabs[binding.tab_id];
const draft = () => tab().edit!;

beforeEach(() => {
  useDatabaseQueries.setState({ tabs: {} });
  ensureQuery(binding);
  vi.mocked(tauriCommands.databaseEditLoad).mockResolvedValue(page);
});

async function stage() {
  await openTableEdit('token', binding, request);
  updateQuery(binding.tab_id, (tab) => ({ ...tab, edit: { ...tab.edit!, changes: [change] } }));
}

it('preserves pending values after a conflict and requires a fresh snapshot before applying', async () => {
  vi.mocked(tauriCommands.databaseEditApply).mockResolvedValue({
    outcome: 'rejected',
    failure: { code: 'row_conflict', change_index: 0, server_code: null },
  });
  await stage();
  await applyTableEdit('token', binding);
  expect(draft()).toMatchObject({ outcome: 'conflict', changes: [change] });
  expect(hasQueryDraft(tab())).toBe(true);
  await applyTableEdit('token', binding);
  expect(tauriCommands.databaseEditApply).toHaveBeenCalledTimes(1);
  await reloadTableEdit('token', binding);
  expect(draft()).toMatchObject({ outcome: 'draft', changes: [], page });
});

it('keeps a lost Apply response unresolved and never retries or reloads', async () => {
  vi.mocked(tauriCommands.databaseEditApply).mockRejectedValue(new Error('IPC lost'));
  await stage();
  await applyTableEdit('token', binding);
  await reloadTableEdit('token', binding);
  await applyTableEdit('token', binding);
  expect(draft()).toMatchObject({ outcome: 'unknown', changes: [change] });
  expect(hasQueryDraft(tab())).toBe(true);
  expect(tauriCommands.databaseEditLoad).toHaveBeenCalledTimes(1);
  expect(tauriCommands.databaseEditApply).toHaveBeenCalledTimes(1);
});

it('keeps acknowledged generated values when refreshing the committed table fails', async () => {
  const values = [{ kind: 'integer' as const, decimal: '9223372036854775807' }];
  vi.mocked(tauriCommands.databaseEditApply).mockResolvedValue({
    outcome: 'committed',
    rows: [values],
  });
  await stage();
  vi.mocked(tauriCommands.databaseEditLoad).mockRejectedValueOnce({
    code: 'connection_failed',
    change_index: null,
    server_code: null,
  });
  await applyTableEdit('token', binding);
  expect(draft()).toMatchObject({
    outcome: 'committed',
    changes: [],
    page: null,
    committedRows: [values],
    failure: { code: 'connection_failed' },
  });
  expect(hasQueryDraft(tab())).toBe(false);
  expect(tauriCommands.databaseEditApply).toHaveBeenCalledWith('token', binding, page.id, [change]);
});
