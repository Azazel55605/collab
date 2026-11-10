const messages: Record<string, string> = {
  script_conflict:
    'The saved SQL script changed. Your draft is kept; reload it or save under a new name.',
  busy: 'This session is executing a query. Cancel it or wait for completion.',
  unresolved_session:
    'Resolve the running query, open transaction or unknown outcome before closing or changing this session.',
  query_failed:
    'SQL Server rejected the statement. Check the error number and highlighted source line.',
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
    'The server did not respond in time. The affected session was retired; reconnect explicitly.',
  wrong_binding: 'This connection or session is no longer active. Reopen the database workspace.',
  limit_reached:
    'A query, result or workspace limit was reached. Narrow the SQL/results or close unused sessions.',
  invalid_parameter:
    'Check the connection fields and use a plain hostname or IP address with a separate TCP port.',
  unsupported:
    'This option is unavailable in this package. Flatpak currently supports session-only passwords.',
};
export function databaseError(error: unknown): string {
  return typeof error === 'string' && messages[error]
    ? messages[error]
    : 'Could not complete the database operation. Database connections require the desktop app; check the server and try again.';
}

export function databaseQueryError(code: string): string {
  if (code === 'unsupported')
    return 'This SQL operation is unsupported. Use plain GO delimiters; SQLCMD commands and GO repeat counts are unavailable.';
  if (code === 'invalid_parameter') return 'Check the SQL text, selection and table/filter fields.';
  return databaseError(code);
}
