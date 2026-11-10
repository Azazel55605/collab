/** Desktop database metadata only. Passwords never enter stores or persistence. */
export interface DatabaseConnection {
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
export interface DatabaseWorkspace {
  token: string;
  profiles: DatabaseConnection[];
  connections: DatabaseConnected[];
  tabs: DatabaseBinding[];
  durable_credentials: boolean;
}
export type DatabaseMetadataRequest =
  | { kind: 'completion'; after: string }
  | { kind: 'databases'; after: string }
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
