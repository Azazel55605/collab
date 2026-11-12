import { useMemo, useState } from 'react';

import { type EditDraft, type ResultSet, updateQuery } from '../../lib/database/queryStore';
import { applyTableEdit, reloadTableEdit } from '../../lib/database/tableEditing';
import { valueText } from '../../lib/database/values';
import { databaseError } from '../../lib/databaseErrors';
import type {
  DatabaseBinding,
  DatabaseEditChange,
  DatabaseEditColumn,
  DatabaseEditField,
  DatabaseEditInput,
  DatabaseEditPage,
  DatabaseValue,
  SqliteStorage,
} from '../../types/database';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Field, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Textarea } from '../ui/textarea';

import ResultGrid from './ResultGrid';

type EditorSelection = { kind: 'insert' } | { kind: 'cell'; row: number; column: number };

const sqliteStorageTypes: Record<SqliteStorage, string> = {
  integer: 'Integer',
  real: 'Real',
  text: 'Text',
  binary: 'BLOB (Base64)',
};

function showInput(input: DatabaseEditInput) {
  if (input.kind === 'sqlite_value') return `${sqliteStorageTypes[input.storage]} · ${input.text}`;
  return input.kind === 'value' ? input.text : input.kind === 'null' ? 'NULL' : 'DEFAULT';
}

function initialInput(column: DatabaseEditColumn, value?: DatabaseValue): DatabaseEditInput {
  if (value?.kind === 'null') return { kind: 'null' };
  if (column.input === 'sqlite') {
    const storage =
      value?.kind === 'float'
        ? 'real'
        : value?.kind === 'integer' || value?.kind === 'binary'
          ? value.kind
          : 'text';
    return { kind: 'sqlite_value', storage, text: value ? valueText(value) : '' };
  }
  return {
    kind: 'value',
    text: value ? valueText(value) : column.input === 'boolean' ? 'false' : '',
  };
}
function editError(code: string) {
  switch (code) {
    case 'read_only_result':
      return 'This table does not meet the edit requirements. Use Browse rows to view its data.';
    case 'schema_conflict':
      return 'The table definition changed. Reload the rows before staging changes again.';
    case 'row_conflict':
      return 'A row changed or disappeared. Review your pending values before reloading.';
    case 'invalid_parameter':
      return 'Check the value, required fields, and the column type.';
    case 'query_failed':
      return 'The database rejected the change. Check the error number and review your values.';
    case 'limit_reached':
      return 'The edit limit was reached. Filter to fewer rows or stage a smaller batch.';
    default:
      return databaseError(code);
  }
}

export default function TableEditDialog({
  token,
  binding,
  draft,
}: {
  token: string;
  binding: DatabaseBinding;
  draft: EditDraft;
}) {
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const [review, setReview] = useState(false);
  const [discard, setDiscard] = useState(false);
  const { page, changes, busy, outcome, failure } = draft;
  const changeCount = `${changes.length} ${changes.length === 1 ? 'change' : 'changes'}`;
  const canStage = !!page && !busy && (outcome === 'draft' || outcome === 'committed');
  const result = useMemo<ResultSet | null>(
    () =>
      page && {
        columns: page.columns.map((column) => ({
          ...column,
          version_token: column.engine_type === 'timestamp',
          precision: null,
          scale: null,
        })),
        rows: page.rows.map((row) => row.values),
      },
    [page],
  );
  const byRow = useMemo(
    () =>
      new Map(
        changes.flatMap((change) => (change.kind === 'insert' ? [] : [[change.row_id, change]])),
      ),
    [changes],
  );
  const close = () => updateQuery(binding.tab_id, (tab) => ({ ...tab, edit: undefined }));
  const returnToSession = () =>
    updateQuery(binding.tab_id, (tab) =>
      tab.edit ? { ...tab, edit: { ...tab.edit, visible: false } } : tab,
    );
  const requestClose = () => {
    if (busy || outcome === 'unknown') return;
    if (changes.length) setDiscard(true);
    else close();
  };
  const stage = (change: DatabaseEditChange) => {
    if (!canStage) return;
    updateQuery(binding.tab_id, (tab) => {
      if (!tab.edit) return tab;
      const pending = [...tab.edit.changes];
      const existing =
        change.kind === 'insert'
          ? -1
          : pending.findIndex((item) => item.kind !== 'insert' && item.row_id === change.row_id);
      if (existing >= 0) pending[existing] = change;
      else if (pending.length < 128) pending.push(change);
      else return tab;
      return {
        ...tab,
        edit: { ...tab.edit, outcome: 'draft', changes: pending, failure: null, committedRows: [] },
      };
    });
    setSelection(null);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent className="flex max-h-[90vh] flex-col overflow-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            Edit {draft.request.schema}.{draft.request.table}
          </DialogTitle>
          <DialogDescription>
            Select a cell to edit its value or stage a row deletion. Apply commits the reviewed
            changes together.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{binding.database}</Badge>
          {page && (
            <Badge variant="secondary">
              {page.rows.length} rows {page.more && '· first 100'}
            </Badge>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!canStage || changes.length >= 128}
            onClick={() => setSelection({ kind: 'insert' })}
          >
            Insert row
          </Button>
          <Button
            size="sm"
            disabled={!changes.length || busy || outcome === 'unknown'}
            onClick={() => setReview(true)}
          >
            Review changes ({changes.length})
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !!changes.length || outcome === 'unknown'}
            onClick={() => void reloadTableEdit(token, binding)}
          >
            Reload rows
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={outcome === 'unknown' ? returnToSession : requestClose}
          >
            {outcome === 'unknown' ? 'Return to session' : 'Exit edit mode'}
          </Button>
        </div>
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            {page ? 'Applying changes…' : 'Loading editable rows…'}
          </p>
        )}
        {outcome === 'unknown' && (
          <p role="alert" className="text-sm text-destructive">
            Apply outcome unknown. Verify the data in a new session before trying again. Close this
            session explicitly to clear the unresolved operation.
          </p>
        )}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {outcome === 'committed' && 'Changes committed. Refresh failed. '}
            {failure.change_index != null && `Change ${failure.change_index + 1}. `}
            {editError(failure.code)}
            {failure.server_code != null && ` Database error ${failure.server_code}.`}
          </p>
        )}
        {outcome === 'committed' && (
          <p role="status" className="text-sm">
            Committed {draft.committedRows.length}{' '}
            {draft.committedRows.length === 1 ? 'change' : 'changes'}.
          </p>
        )}
        {draft.committedRows.some(Boolean) && (
          <details className="text-sm">
            <summary className="cursor-pointer">Values returned by the database</summary>
            <div className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
              {draft.committedRows.flatMap((row, index) =>
                row
                  ? [
                      <p key={index}>
                        {index + 1}.{' '}
                        {row
                          .map(
                            (value, column) =>
                              `${draft.committedColumns?.[column] ?? column + 1} = ${valueText(value)}`,
                          )
                          .join(' · ')}
                      </p>,
                    ]
                  : [],
              )}
            </div>
          </details>
        )}
        {result && page && (
          <div className="flex h-80 min-h-40 flex-col rounded-md border">
            <ResultGrid
              key={page.id}
              result={result}
              onCellActivate={
                canStage ? (row, column) => setSelection({ kind: 'cell', row, column }) : undefined
              }
              rowClass={(index) => {
                const pending = byRow.get(page.rows[index].id);
                return pending?.kind === 'delete'
                  ? 'bg-destructive/15 line-through'
                  : pending
                    ? 'bg-primary/10'
                    : undefined;
              }}
            />
          </div>
        )}
        {selection && page && (
          <CellEditDialog
            page={page}
            selection={selection}
            pending={selection.kind === 'cell' ? byRow.get(page.rows[selection.row].id) : undefined}
            onClose={() => setSelection(null)}
            onStage={stage}
          />
        )}
        {review && page && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open && !busy) setReview(false);
            }}
          >
            <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>
                  Review {changes.length} pending {changes.length === 1 ? 'change' : 'changes'}
                </DialogTitle>
                <DialogDescription>
                  Changes apply in order in one transaction. Other writers may have to wait during
                  Apply.
                </DialogDescription>
              </DialogHeader>
              <ol className="max-h-72 space-y-2 overflow-auto text-sm">
                {changes.map((change, index) => (
                  <li key={index} className="rounded-md border px-3 py-2">
                    <ChangeSummary page={page} change={change} />
                    {outcome === 'draft' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          updateQuery(binding.tab_id, (tab) =>
                            tab.edit
                              ? {
                                  ...tab,
                                  edit: {
                                    ...tab.edit,
                                    changes: tab.edit.changes.filter((_, i) => i !== index),
                                    failure: null,
                                  },
                                }
                              : tab,
                          )
                        }
                      >
                        Remove change
                      </Button>
                    )}
                  </li>
                ))}
              </ol>
              {outcome === 'conflict' ? (
                <Button
                  variant="destructive"
                  onClick={() => {
                    setReview(false);
                    void reloadTableEdit(token, binding);
                  }}
                >
                  Reload rows and discard pending changes
                </Button>
              ) : (
                <Button
                  disabled={busy || !changes.length || outcome !== 'draft'}
                  onClick={() => {
                    setReview(false);
                    void applyTableEdit(token, binding);
                  }}
                >
                  Apply {changeCount}
                </Button>
              )}
            </DialogContent>
          </Dialog>
        )}
        {discard && (
          <Dialog open onOpenChange={setDiscard}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Discard pending row changes?</DialogTitle>
                <DialogDescription>These changes are staged locally.</DialogDescription>
              </DialogHeader>
              <Button variant="outline" onClick={() => setDiscard(false)}>
                Keep editing
              </Button>
              <Button variant="destructive" onClick={close}>
                Discard changes and close
              </Button>
            </DialogContent>
          </Dialog>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChangeSummary({ page, change }: { page: DatabaseEditPage; change: DatabaseEditChange }) {
  const row =
    change.kind === 'insert' ? undefined : page.rows.find((row) => row.id === change.row_id);
  const key =
    row &&
    page.columns
      .flatMap((column, index) =>
        column.key ? [`${column.name} = ${valueText(row.values[index])}`] : [],
      )
      .join(', ');
  return (
    <>
      <p className="font-medium capitalize">
        {change.kind} {key}
      </p>
      {change.kind !== 'delete' &&
        change.values.map(({ column, value }) => (
          <p key={column} className="break-all font-mono text-xs">
            {page.columns[column].name}: {row && `${valueText(row.values[column])} → `}
            {showInput(value)}
          </p>
        ))}
      {change.kind === 'insert' && !change.values.length && (
        <p className="text-xs">Database defaults</p>
      )}
    </>
  );
}

function CellEditDialog({
  page,
  selection,
  pending,
  onClose,
  onStage,
}: {
  page: DatabaseEditPage;
  selection: EditorSelection;
  pending?: DatabaseEditChange;
  onClose: () => void;
  onStage: (change: DatabaseEditChange) => void;
}) {
  const inserting = selection.kind === 'insert';
  const row = selection.kind === 'cell' ? page.rows[selection.row] : undefined;
  const cell = selection.kind === 'cell' ? selection.column : null;
  const indexes =
    cell === null
      ? page.columns.flatMap((column, index) => (column.generated ? [] : [index]))
      : page.columns[cell].generated || page.columns[cell].key || pending?.kind === 'delete'
        ? []
        : [cell];
  const [values, setValues] = useState<DatabaseEditField[]>(() =>
    indexes.map((column) => {
      const metadata = page.columns[column];
      const existing =
        pending?.kind === 'update'
          ? pending.values.find((value) => value.column === column)?.value
          : undefined;
      return {
        column,
        value:
          existing ??
          (row
            ? initialInput(metadata, row.values[column])
            : metadata.has_default || metadata.nullable
              ? { kind: 'default' }
              : initialInput(metadata)),
      };
    }),
  );
  const stage = () => {
    if (inserting) {
      onStage({ kind: 'insert', values: values.filter((field) => field.value.kind !== 'default') });
    } else if (row && values.length) {
      const retained =
        pending?.kind === 'update' ? pending.values.filter((item) => item.column !== cell) : [];
      onStage({ kind: 'update', row_id: row.id, values: [...retained, ...values] });
    }
  };
  const incomplete = values.some(({ column, value }) => {
    if (value.kind === 'sqlite_value') {
      return !value.text && (value.storage === 'integer' || value.storage === 'real');
    }
    return (
      value.kind === 'value' &&
      !value.text &&
      !['text', 'binary'].includes(page.columns[column].input)
    );
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>
            {cell === null ? 'Insert row' : `Edit ${page.columns[cell].name}`}
          </DialogTitle>
          <DialogDescription>
            {indexes.length || inserting
              ? 'Stage values for review before applying them.'
              : 'Keys and generated values are read-only on existing rows.'}
          </DialogDescription>
        </DialogHeader>
        {cell !== null && row && !indexes.length && (
          <pre className="break-all whitespace-pre-wrap text-xs">{valueText(row.values[cell])}</pre>
        )}
        {values.map(({ column, value }) => (
          <TypedField
            key={column}
            column={page.columns[column]}
            inserting={inserting}
            value={value}
            onChange={(next) =>
              setValues((fields) =>
                fields.map((field) => (field.column === column ? { column, value: next } : field)),
              )
            }
          />
        ))}
        <div className="flex flex-wrap gap-2">
          {(indexes.length > 0 || inserting) && (
            <Button disabled={incomplete} onClick={stage}>
              {inserting ? 'Stage insert' : 'Stage edit'}
            </Button>
          )}
          {row && pending?.kind !== 'delete' && (
            <Button
              variant="destructive"
              onClick={() => onStage({ kind: 'delete', row_id: row.id })}
            >
              Stage delete row
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TypedField({
  column,
  value,
  onChange,
  inserting,
}: {
  inserting: boolean;
  column: DatabaseEditColumn;
  value: DatabaseEditInput;
  onChange: (value: DatabaseEditInput) => void;
}) {
  const label = `${column.name} value`;
  const allowDefault =
    (inserting || column.input !== 'sqlite') && (column.has_default || column.nullable);
  const hints: Partial<Record<DatabaseEditColumn['input'], string>> = {
    binary: 'Base64',
    date: 'YYYY-MM-DD',
    time: 'HH:MM:SS.fffffff',
    date_time: 'YYYY-MM-DDTHH:MM:SS.fffffff',
    date_time_offset: 'YYYY-MM-DDTHH:MM:SS.fffffff+01:00',
  };
  return (
    <Field>
      <FieldLabel>
        {column.name} · {column.engine_type}
      </FieldLabel>
      {(column.nullable || allowDefault) && (
        <Select
          value={value.kind === 'sqlite_value' ? 'value' : value.kind}
          onValueChange={(kind) =>
            onChange(
              kind === 'null'
                ? { kind: 'null' }
                : kind === 'default'
                  ? { kind: 'default' }
                  : initialInput(column),
            )
          }
        >
          <SelectTrigger aria-label={`${column.name} value mode`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="value">Value</SelectItem>
            {column.nullable && <SelectItem value="null">NULL</SelectItem>}
            {allowDefault && <SelectItem value="default">Database default</SelectItem>}
          </SelectContent>
        </Select>
      )}
      {value.kind === 'sqlite_value' && (
        <>
          <Select
            value={value.storage}
            onValueChange={(storage: SqliteStorage) => onChange({ ...value, storage })}
          >
            <SelectTrigger aria-label={`${column.name} storage class`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(sqliteStorageTypes).map(([storage, name]) => (
                <SelectItem key={storage} value={storage}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Textarea
            aria-label={label}
            maxLength={value.storage === 'binary' ? 24 * 1024 : 16 * 1024}
            value={value.text}
            onChange={(event) => onChange({ ...value, text: event.target.value })}
          />
        </>
      )}
      {value.kind === 'value' &&
        (column.input === 'boolean' ? (
          <Select value={value.text} onValueChange={(text) => onChange({ kind: 'value', text })}>
            <SelectTrigger aria-label={label}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="false">False</SelectItem>
              <SelectItem value="true">True</SelectItem>
            </SelectContent>
          </Select>
        ) : column.input === 'text' ? (
          <Textarea
            aria-label={label}
            maxLength={2048}
            value={value.text}
            onChange={(event) => onChange({ kind: 'value', text: event.target.value })}
          />
        ) : (
          <Input
            aria-label={label}
            placeholder={hints[column.input]}
            maxLength={8192}
            inputMode={
              column.input === 'integer'
                ? 'numeric'
                : column.input === 'decimal'
                  ? 'decimal'
                  : 'text'
            }
            value={value.text}
            onChange={(event) => onChange({ kind: 'value', text: event.target.value })}
          />
        ))}
    </Field>
  );
}
