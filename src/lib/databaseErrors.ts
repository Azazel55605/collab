const messages: Record<string, string> = {
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
    'The database workspace limit was reached. Close unused sessions or narrow the metadata selection.',
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
