import type {
  DatabaseBinding,
  DatabaseBrowseRequest,
  DatabaseEditFailure,
} from '../../types/database';
import { tauriCommands } from '../tauri';

import { type EditDraft, updateQuery, useDatabaseQueries } from './queryStore';

export function editFailure(error: unknown): DatabaseEditFailure {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error as DatabaseEditFailure;
  }
  return {
    code: typeof error === 'string' ? error : 'connection_failed',
    change_index: null,
    server_code: null,
  };
}

function editState(binding: DatabaseBinding) {
  return useDatabaseQueries.getState().tabs[binding.tab_id]?.edit;
}

function updateEdit(
  binding: DatabaseBinding,
  request: DatabaseBrowseRequest,
  update: (draft: EditDraft) => EditDraft,
) {
  updateQuery(binding.tab_id, (tab) =>
    tab.edit?.request === request ? { ...tab, edit: update(tab.edit) } : tab,
  );
}

async function fetchPage(token: string, binding: DatabaseBinding, request: DatabaseBrowseRequest) {
  try {
    const page = await tauriCommands.databaseEditLoad(token, binding, request);
    updateEdit(binding, request, (draft) => ({ ...draft, page, busy: false }));
  } catch (error) {
    updateEdit(binding, request, (draft) => ({
      ...draft,
      busy: false,
      failure: editFailure(error),
    }));
  }
}

export function openTableEdit(
  token: string,
  binding: DatabaseBinding,
  request: DatabaseBrowseRequest,
) {
  const tab = useDatabaseQueries.getState().tabs[binding.tab_id];
  if (
    !tab ||
    tab.receiving ||
    tab.edit ||
    tab.status.phase !== 'idle' ||
    tab.status.transaction !== 'none'
  )
    return;
  updateQuery(binding.tab_id, (current) => ({
    ...current,
    edit: {
      request,
      page: null,
      changes: [],
      busy: true,
      failure: null,
      outcome: 'draft',
      committedRows: [],
    },
  }));
  return fetchPage(token, binding, request);
}

export function reloadTableEdit(token: string, binding: DatabaseBinding) {
  const draft = editState(binding);
  if (!draft || draft.busy || draft.outcome === 'unknown') return;
  updateEdit(binding, draft.request, (current) => ({
    ...current,
    busy: true,
    page: null,
    changes: [],
    failure: null,
    outcome: current.outcome === 'committed' ? 'committed' : 'draft',
  }));
  return fetchPage(token, binding, draft.request);
}

export async function applyTableEdit(token: string, binding: DatabaseBinding) {
  const draft = editState(binding);
  if (!draft?.page || draft.busy || draft.outcome !== 'draft' || !draft.changes.length) return;
  const { request, page, changes } = draft;
  updateEdit(binding, request, (current) => ({ ...current, busy: true, failure: null }));
  try {
    const result = await tauriCommands.databaseEditApply(token, binding, page.id, changes);
    if (result.outcome === 'committed') {
      updateEdit(binding, request, (current) => ({
        ...current,
        outcome: 'committed',
        page: null,
        changes: [],
        committedRows: result.rows,
        committedColumns: page.columns.map((column) => column.name),
      }));
      await fetchPage(token, binding, request);
    } else {
      updateEdit(binding, request, (current) => ({
        ...current,
        busy: false,
        failure: result.failure,
        outcome:
          result.outcome === 'unknown'
            ? 'unknown'
            : ['schema_conflict', 'row_conflict'].includes(result.failure.code)
              ? 'conflict'
              : 'draft',
      }));
    }
  } catch (error) {
    const failure = editFailure(error);
    const nativeRejection = !!error && typeof error === 'object' && 'code' in error;
    updateEdit(binding, request, (current) => ({
      ...current,
      busy: false,
      failure,
      // The renderer cannot infer settlement from a lost IPC response.
      outcome: !nativeRejection || failure.code === 'unresolved_session' ? 'unknown' : 'draft',
    }));
  }
}
