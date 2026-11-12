import type { DatabaseEngine } from '../types/database';

const messages: Record<string, string> = {
  database_moved:
    'The SQLite file moved or was replaced. Close the session and select the file again.',
  database_read_only: 'The SQLite file is read-only.',
  database_locked:
    'Another database operation is holding a lock. Wait for it to finish and try again.',
  invalid_database: 'The selected file could not be opened as a SQLite database.',
  script_conflict:
    'The saved SQL script changed. Your draft is kept; reload it or save under a new name.',
  busy: 'This session is executing a query. Cancel it or wait for completion.',
  unresolved_session:
    'Resolve the running query, open transaction or unknown outcome before closing or changing this session.',
  query_failed:
    'The database rejected the statement. Check the error number and highlighted source line.',
  cancelled: 'The query was cancelled. Previously committed statements are not undone.',
  invalid_sequence:
    'Result delivery was interrupted. The query will be stopped; reconnect explicitly.',
  stale_query: 'This execution is no longer active.',
  data_conversion: 'A result value could not be decoded safely.',
  credential_store_unavailable:
    'The operating system credential store is locked or unavailable. Unlock it, or choose session-only storage and enter your password when connecting.',
  credential_cleanup_failed:
    'A database credential could not be removed. Unlock the system credential store, then save or remove this connection again to retry cleanup.',
  schema_conflict:
    'The connection settings changed while this operation was running. Review the current settings and try again.',
  authentication_failed:
    'Sign-in failed or the credential store is locked or unavailable. Enter your SQL password, or unlock the system credential store and try again.',
  tls_rejected:
    'The server certificate could not be verified. Install a trusted certificate and check its hostname. Certificate verification is required.',
  permission_denied: 'This account does not have permission to access this database or metadata.',
  connection_failed:
    'The connection was lost or could not be opened. Check the server address and network, then disconnect and reconnect explicitly.',
  timeout:
    'The database operation did not finish in time. Check the session status before retrying.',
  wrong_binding: 'This connection or session is no longer active. Reopen the database workspace.',
  limit_reached:
    'A query, result or workspace limit was reached. Narrow the SQL/results or close unused sessions.',
  invalid_parameter:
    'Check the connection fields and use a plain hostname or IP address with a separate TCP port.',
  unsupported:
    'This operation is unavailable for this database engine, server version, or desktop package.',
};
export function databaseError(error: unknown): string {
  return typeof error === 'string' && messages[error]
    ? messages[error]
    : 'Could not complete the database operation. Database connections require the desktop app; check the server and try again.';
}

export function databaseQueryError(code: string, engine: DatabaseEngine = 'sql_server'): string {
  if (engine === 'maria_db' && code === 'cancelled') {
    return 'The client stopped waiting and closed this session. Check the database before rerunning the statement.';
  }
  if (engine === 'maria_db' && code === 'query_failed') {
    return 'MariaDB rejected the statement. Check its error number and run one statement at a time.';
  }
  if (code === 'unsupported')
    return 'This SQL operation is unsupported. Use plain GO delimiters; SQLCMD commands and GO repeat counts are unavailable.';
  if (code === 'invalid_parameter') return 'Check the SQL text, selection and table/filter fields.';
  return databaseError(code);
}
