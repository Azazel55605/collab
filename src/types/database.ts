/** Desktop database metadata only. Passwords never enter stores or persistence. */
export type DatabaseNetworkEngine = 'sql_server' | 'maria_db';
export type DatabaseEngine = DatabaseNetworkEngine | 'sqlite';
export interface MariaDbCapabilities {
  version: string;
  sql_mode: string;
  collation: string;
  innodb: boolean;
}
export interface DatabaseConnection {
  engine?: DatabaseNetworkEngine;
  id: string;
  label: string;
  environment: string;
  host: string;
  port: number;
  database: string;
  username: string;
  certificate_hostname: string | null;
  remember_password: boolean;
}
export interface DatabaseConnected {
  engine?: DatabaseNetworkEngine;
  maria_capabilities?: MariaDbCapabilities | null;
  id: string;
  saved_id: string;
  label: string;
  environment: string;
  database: string;
}
export interface DatabaseBinding {
  profile_id: string;
  connection_id: string;
  session_id: string;
  tab_id: string;
  database: string;
  generation: number;
}
export type SqliteOpenMode = 'read_only' | 'read_write' | 'create';
export interface DatabaseSqliteFile {
  binding: DatabaseBinding;
  label: string;
  read_only: boolean;
}
export interface DatabaseWorkspace {
  token: string;
  profiles: DatabaseConnection[];
  connections: DatabaseConnected[];
  tabs: DatabaseBinding[];
  durable_credentials: boolean;
  sqlite_files?: DatabaseSqliteFile[];
}
export type DatabaseMetadataRequest =
  | { kind: 'completion'; after: string }
  | { kind: 'databases' | 'maria_tables'; after: string }
  | { kind: 'maria_columns'; table: string; after: number }
  | { kind: 'maria_indexes'; table: string; after: string }
  | { kind: 'schemas'; after: number }
  | { kind: 'objects'; schema_id: number; after: number }
  | { kind: 'columns' | 'indexes'; object_id: number; after: number };
export interface DatabaseMetadataItem {
  id: string;
  name: string;
  kind: string;
  detail: string;
}
export interface DatabaseMetadataPage {
  items: DatabaseMetadataItem[];
  next: string | null;
}

export type DatabaseValue =
  | { kind: 'null' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'integer'; decimal: string }
  | { kind: 'decimal'; decimal: string; precision: number; scale: number }
  | { kind: 'float'; round_trip_decimal: string; bits: number }
  | { kind: 'text'; value: string }
  | { kind: 'binary'; base64: string }
  | { kind: 'uuid'; value: string }
  | { kind: 'date'; iso8601: string }
  | { kind: 'time'; iso8601: string; fractional_digits: number }
  | { kind: 'date_time'; iso8601: string; fractional_digits: number; offset_minutes: number | null }
  | { kind: 'opaque'; engine_type: string; display: string }
  | { kind: 'truncated'; engine_type: string; preview: string; original_bytes: number | null };
export interface DatabaseColumn {
  name: string;
  engine_type: string;
  nullable: boolean;
  generated: boolean;
  version_token: boolean;
  precision: number | null;
  scale: number | null;
}
export type DatabaseFinishReason =
  'complete' | 'cancelled' | 'row_limit' | 'byte_limit' | 'cell_limit';
export interface DatabaseExecutionError {
  code: string;
  source: { start_utf16: number; end_utf16: number } | null;
  server_code: number | null;
  outcome_unknown: boolean;
}
export type DatabaseResultEvent =
  | { event: 'columns'; result_set: number; columns: DatabaseColumn[] }
  | { event: 'rows'; result_set: number; rows: DatabaseValue[][] }
  | { event: 'message'; severity: number; safe_text: string }
  | { event: 'affected_rows'; result_set: number; exact_count: string }
  | { event: 'finished'; reason: DatabaseFinishReason }
  | { event: 'failed'; error: DatabaseExecutionError };
export interface DatabaseResultFrame {
  binding: DatabaseBinding;
  query_id: string;
  sequence: number;
  event: DatabaseResultEvent;
}
export interface DatabaseQueryStatus {
  query_id: string | null;
  phase: 'idle' | 'running' | 'cancelling' | 'finishing' | 'retired' | 'outcome_unknown';
  transaction: 'none' | 'open' | 'failed' | 'unknown';
  reason: DatabaseFinishReason | null;
}
export interface DatabaseQueryPoll {
  frame: DatabaseResultFrame | null;
  status: DatabaseQueryStatus;
}
export interface DatabaseHistoryEntry {
  sql: string;
  executed_at: string;
}

export interface DatabaseBrowseRequest {
  schema: string;
  table: string;
  filter_column: string | null;
  filter_text: string;
}

export type DatabaseTransactionAction = 'begin' | 'commit' | 'rollback';

export interface DatabaseEditColumn {
  name: string;
  engine_type: string;
  input:
    | 'sqlite'
    | 'integer'
    | 'decimal'
    | 'boolean'
    | 'text'
    | 'binary'
    | 'uuid'
    | 'date'
    | 'time'
    | 'date_time'
    | 'date_time_offset';
  nullable: boolean;
  generated: boolean;
  has_default: boolean;
  key: boolean;
}
export interface DatabaseEditRow {
  id: string;
  values: DatabaseValue[];
}
export interface DatabaseEditPage {
  id: string;
  schema: string;
  table: string;
  columns: DatabaseEditColumn[];
  rows: DatabaseEditRow[];
  more: boolean;
}
export type SqliteStorage = 'integer' | 'real' | 'text' | 'binary';
export type DatabaseEditInput =
  | { kind: 'default' }
  | { kind: 'null' }
  | { kind: 'value'; text: string }
  | { kind: 'sqlite_value'; storage: SqliteStorage; text: string };
export interface DatabaseEditField {
  column: number;
  value: DatabaseEditInput;
}
export type DatabaseEditChange =
  | { kind: 'insert'; values: DatabaseEditField[] }
  | { kind: 'update'; row_id: string; values: DatabaseEditField[] }
  | { kind: 'delete'; row_id: string };
export interface DatabaseEditFailure {
  code: string;
  server_code: number | null;
  change_index: number | null;
}
export type DatabaseEditResult =
  | { outcome: 'committed'; rows: (DatabaseValue[] | null)[] }
  | { outcome: 'rejected' | 'unknown'; failure: DatabaseEditFailure };
