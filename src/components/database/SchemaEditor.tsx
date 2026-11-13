import { useState } from 'react';

import { databaseError } from '../../lib/databaseErrors';
import { tauriCommands } from '../../lib/tauri';
import type {
  DatabaseBinding,
  DatabaseEngine,
  DatabaseSchemaChange,
  DatabaseSchemaColumn,
  DatabaseSchemaPreview,
  DatabaseSchemaType,
} from '../../types/database';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Field, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Textarea } from '../ui/textarea';

const operations: { kind: DatabaseSchemaChange['kind']; label: string }[] = [
  { kind: 'create_table', label: 'Create table' },
  { kind: 'add_column', label: 'Add nullable column' },
  { kind: 'add_primary_key', label: 'Add primary key' },
  { kind: 'create_index', label: 'Create index' },
  { kind: 'rename_column', label: 'Rename column' },
  { kind: 'drop_column', label: 'Drop column' },
];

const types: { kind: DatabaseSchemaType; label: string }[] = [
  { kind: 'integer', label: 'Integer' },
  { kind: 'big_integer', label: 'Big integer' },
  { kind: 'decimal', label: 'Decimal (19, 4)' },
  { kind: 'short_text', label: 'Short text (191 characters)' },
  { kind: 'text', label: 'Text' },
  { kind: 'binary', label: 'Binary' },
  { kind: 'date_time', label: 'Date and time' },
];

function blankColumn(): DatabaseSchemaColumn {
  return { name: '', data_type: 'integer', nullable: true, primary_key: false };
}

function schemaError(error: unknown) {
  const failure =
    typeof error === 'object' && error !== null
      ? (error as { code?: string; server_code?: number })
      : { code: String(error) };
  const messages: Record<string, string> = {
    schema_conflict:
      'The target schema changed or the object already exists. Refresh metadata and review a new preview.',
    schema_dependency:
      'Check whether the table is eligible and the column has a key, index, default, constraint, or foreign-key dependency. SQLite column removal also requires a database without views or triggers.',
    permission_denied:
      'This operation requires schema visibility and permission to change the table. MariaDB also requires LOCK TABLES for existing tables.',
    limit_reached:
      'The schema exceeds the operation limits. SQLite column removal is limited to database files of 64 MiB or less.',
    invalid_identifier: 'Enter a valid table, column, schema or index name.',
    invalid_parameter: 'Check required names, duplicate columns, and the selected options.',
  };
  return (
    (messages[failure.code ?? ''] ?? databaseError(failure.code)) +
    (failure.server_code ? ` Database error ${failure.server_code}.` : '')
  );
}

export default function SchemaEditor({
  token,
  binding,
  engine,
  target,
  onClose,
  onApplied,
}: {
  token: string;
  binding: DatabaseBinding;
  engine: DatabaseEngine;
  target: { schema: string; table: string };
  onClose: () => void;
  onApplied: () => void;
}) {
  const [kind, setKind] = useState<DatabaseSchemaChange['kind']>(
    target.table ? 'add_column' : 'create_table',
  );
  const [schema, setSchema] = useState(target.schema);
  const [table, setTable] = useState(target.table);
  const [columns, setColumns] = useState([blankColumn()]);
  const [columnList, setColumnList] = useState('');
  const [name, setName] = useState('');
  const [column, setColumn] = useState('');
  const [unique, setUnique] = useState(false);
  const [preview, setPreview] = useState<DatabaseSchemaPreview | null>(null);
  const [confirmLoss, setConfirmLoss] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false);
  const sqlite = engine === 'sqlite';
  const create = kind === 'create_table';
  const list = columnList
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean);
  const visibleOperations = operations.filter((op) =>
    sqlite
      ? op.kind !== 'add_primary_key'
      : op.kind !== 'rename_column' && op.kind !== 'drop_column',
  );
  const getPreview = async () => {
    const change: DatabaseSchemaChange = (() => {
      switch (kind) {
        case 'create_table':
          return { kind, columns };
        case 'add_column':
          return { kind, column: { ...columns[0], nullable: true, primary_key: false } };
        case 'add_primary_key':
          return { kind, columns: list };
        case 'create_index':
          return { kind, name, columns: list, unique };
        case 'rename_column':
          return { kind, column, name };
        case 'drop_column':
          return { kind, column };
      }
    })();
    setBusy(true);
    setError('');
    try {
      setPreview(
        await tauriCommands.databaseSchemaPreview(token, binding, { schema, table, change }),
      );
      setConfirmLoss(false);
    } catch (error) {
      setError(schemaError(error));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await tauriCommands.databaseSchemaApply(
        token,
        binding,
        preview.id,
        confirmLoss,
      );
      if (result.outcome === 'applied') {
        onApplied();
        return;
      }
      setUnknown(result.outcome === 'unknown');
      setError(schemaError(result.failure));
    } catch (error) {
      setError(schemaError(error));
    } finally {
      setBusy(false);
      setPreview(null);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit database schema</DialogTitle>
          <DialogDescription>
            Review the generated SQL before applying a change to {binding.database}.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {unknown && (
          <p role="status" className="text-sm text-muted-foreground">
            The change may have applied. Verify the schema in a new session before retrying.
          </p>
        )}
        {preview ? (
          <>
            <pre
              aria-label="Generated SQL"
              className="overflow-auto rounded-md border p-3 text-xs whitespace-pre-wrap"
            >
              {preview.sql}
            </pre>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            {preview.destructive && (
              <Field orientation="horizontal">
                <Checkbox
                  disabled={busy}
                  id="schema-confirm-loss"
                  checked={confirmLoss}
                  onCheckedChange={(value) => setConfirmLoss(value === true)}
                />
                <FieldLabel htmlFor="schema-confirm-loss">
                  Permanently remove the column and its values
                </FieldLabel>
              </Field>
            )}
            <div className="flex gap-2">
              <Button
                variant={preview.destructive ? 'destructive' : 'default'}
                disabled={busy || (preview.destructive && !confirmLoss)}
                onClick={() => void apply()}
              >
                {busy ? 'Applying…' : 'Apply schema change'}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>
                Back
              </Button>
            </div>
          </>
        ) : unknown ? (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy) void getPreview();
            }}
          >
            <Field>
              <FieldLabel htmlFor="schema-operation">Change</FieldLabel>
              <Select
                value={kind}
                disabled={busy}
                onValueChange={(kind: DatabaseSchemaChange['kind']) => {
                  setKind(kind);
                  setError('');
                }}
              >
                <SelectTrigger id="schema-operation">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {visibleOperations.map((op) => (
                    <SelectItem key={op.kind} value={op.kind}>
                      {op.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="schema-name">Schema</FieldLabel>
                <Input
                  id="schema-name"
                  value={schema}
                  required
                  maxLength={128}
                  readOnly={engine !== 'sql_server'}
                  disabled={busy}
                  onChange={(event) => setSchema(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="schema-table">Table</FieldLabel>
                <Input
                  id="schema-table"
                  value={table}
                  required
                  maxLength={128}
                  disabled={busy}
                  onChange={(event) => setTable(event.target.value)}
                />
              </Field>
            </div>
            {(create || kind === 'add_column') &&
              columns.slice(0, create ? columns.length : 1).map((item, index) => (
                <div key={index} className="grid grid-cols-2 gap-2 rounded-md border p-3">
                  <Field>
                    <FieldLabel htmlFor={`schema-column-${index}`}>
                      Column {index + 1} name
                    </FieldLabel>
                    <Input
                      id={`schema-column-${index}`}
                      value={item.name}
                      required
                      maxLength={128}
                      disabled={busy}
                      onChange={(event) =>
                        setColumns((previous) =>
                          previous.map((column, i) =>
                            i === index ? { ...column, name: event.target.value } : column,
                          ),
                        )
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`schema-type-${index}`}>Type</FieldLabel>
                    <Select
                      value={item.data_type}
                      disabled={busy}
                      onValueChange={(data_type: DatabaseSchemaType) =>
                        setColumns((previous) =>
                          previous.map((column, i) =>
                            i === index ? { ...column, data_type } : column,
                          ),
                        )
                      }
                    >
                      <SelectTrigger id={`schema-type-${index}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {types
                          .filter(
                            (type) =>
                              !sqlite ||
                              !['big_integer', 'short_text', 'decimal', 'date_time'].includes(
                                type.kind,
                              ),
                          )
                          .map((type) => (
                            <SelectItem key={type.kind} value={type.kind}>
                              {type.label}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  {create && (
                    <>
                      <Field orientation="horizontal">
                        <Checkbox
                          id={`schema-null-${index}`}
                          checked={item.nullable && !item.primary_key}
                          disabled={busy || item.primary_key}
                          onCheckedChange={(nullable) =>
                            setColumns((previous) =>
                              previous.map((column, i) =>
                                i === index ? { ...column, nullable: nullable === true } : column,
                              ),
                            )
                          }
                        />
                        <FieldLabel htmlFor={`schema-null-${index}`}>Nullable</FieldLabel>
                      </Field>
                      <Field orientation="horizontal">
                        <Checkbox
                          id={`schema-key-${index}`}
                          checked={item.primary_key}
                          disabled={busy}
                          onCheckedChange={(primaryKey) =>
                            setColumns((previous) =>
                              previous.map((column, i) =>
                                i === index
                                  ? { ...column, primary_key: primaryKey === true }
                                  : column,
                              ),
                            )
                          }
                        />
                        <FieldLabel htmlFor={`schema-key-${index}`}>Primary key</FieldLabel>
                      </Field>
                      {columns.length > 1 && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            setColumns((previous) => previous.filter((_, i) => i !== index))
                          }
                        >
                          Remove column {index + 1}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              ))}
            {create && (
              <Button
                type="button"
                variant="outline"
                disabled={busy || columns.length >= 32}
                onClick={() => setColumns((previous) => [...previous, blankColumn()])}
              >
                Add column definition
              </Button>
            )}
            {(kind === 'create_index' || kind === 'rename_column') && (
              <Field>
                <FieldLabel htmlFor="schema-new-name">
                  {kind === 'create_index' ? 'Index name' : 'New column name'}
                </FieldLabel>
                <Input
                  id="schema-new-name"
                  value={name}
                  required
                  maxLength={128}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
            )}
            {(kind === 'create_index' || kind === 'add_primary_key') && (
              <Field>
                <FieldLabel htmlFor="schema-key-columns">Columns, one per line</FieldLabel>
                <Textarea
                  id="schema-key-columns"
                  value={columnList}
                  required
                  maxLength={2048}
                  disabled={busy}
                  onChange={(event) => setColumnList(event.target.value)}
                />
              </Field>
            )}
            {(kind === 'drop_column' || kind === 'rename_column') && (
              <Field>
                <FieldLabel htmlFor="schema-old-column">Existing column name</FieldLabel>
                <Input
                  id="schema-old-column"
                  value={column}
                  required
                  maxLength={128}
                  disabled={busy}
                  onChange={(event) => setColumn(event.target.value)}
                />
              </Field>
            )}
            {kind === 'create_index' && (
              <Field orientation="horizontal">
                <Checkbox
                  id="schema-unique"
                  checked={unique}
                  disabled={busy}
                  onCheckedChange={(value) => setUnique(value === true)}
                />
                <FieldLabel htmlFor="schema-unique">Unique index</FieldLabel>
              </Field>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? 'Checking metadata…' : 'Preview SQL'}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
