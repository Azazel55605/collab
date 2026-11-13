# Database Workspace

The desktop workspace supports SQL Server and MariaDB connections and local
SQLite files. See [queries, row edits and schema changes](./database-queries.md),
the [file-type guide](../file-types.md), and the
[release validation matrix](../build/database-release-validation.md).

## Connect To SQL Server

Open **Databases** in the activity bar, or **Open databases** on the vault picker.
A vault is not required; the workspace is also available while a vault is locked.
It is loaded lazily when opened.

1. Choose **New connection**, select **SQL Server**, and enter a connection/environment label, plain hostname
   or IP, separate TCP port, initial database and SQL username. Named-instance
   discovery and integrated/Entra authentication are not implemented.
2. TLS encryption and certificate verification are mandatory. The optional
   certificate hostname handles a deliberate server-address alias. The certificate
   must chain to system roots. Additional per-connection CAs and trust exceptions
   remain unsupported; there is no silent certificate bypass.
3. Save the connection. Use a session-only password or explicitly select the
   operating system credential store. Session-only passwords are cleared from
   the form after connecting and retained natively only while connections need them.
4. Select the saved connection, then **Test** or **Connect**. Test closes its socket
   and does not add an active connection. Connecting does not execute a script.
5. Select an active connection to browse visible databases. **Open session** creates
   a separate physical session pinned to that database. Browse schemas, tables,
   views, columns and indexes from its metadata panel. Pages contain at most 100
   objects; **Next page** replaces the previous page.

Saved connection selection does not retarget a session tab. Tabs show the original
connection/database; the header also shows the environment and transaction state.
**Disconnect** closes that connection and its tabs while leaving other connections
alone. Closing a tab closes only its physical session. Editing a saved connection
closes its current connections/tabs. Removing it also attempts to delete its saved
credentials; credential-store failure is explicit and can be retried.

Resolve running work, dirty scripts, and open transactions before disposal.
For an unknown outcome, verify the database before retrying.

## Connect To MariaDB

Choose **New connection**, select **MariaDB**, and enter the hostname, TCP
port (default 3306), database and SQL login. The hostname or IP must match a
name or address on the server certificate. Install the issuing CA in the
desktop system trust store for a private CA. The active connection shows the
server version, InnoDB availability, SQL mode and connection collation.

Select a database and **Open session**. In a session, **Browse metadata**
lists its tables and views, with columns and indexes available for each object.

## Native Ownership And Credentials

`src-tauri/src/database/` owns the registry, native-issued UUID handles, connections,
credentials, metadata queries, cancellation trees and the global eight-session
budget shared by network connections and local SQLite sessions. Commands in
`commands/database.rs` accept only the main desktop window. The desktop owns
database execution. The hosted server stores SQLite snapshot attachments.

A workspace token binds all commands to the active local application profile.
Profile changes invalidate the token, cancel pending logins/metadata operations,
close sessions and release cached secrets. A native current-profile guard rejects
late activation by a previous profile; frontend profile notifications are ordered
before a new workspace activation. A view switch preserves native sessions;
profile switches and process exit do not.

Sockets are never implicitly pooled, replayed or reconnected. Each tab has its own
client. Root metadata uses the connection's dedicated metadata client; tab metadata
uses a separate short-lived client in the pinned database. SQLite metadata uses
a bounded reservation on the picker-owned file session.
All clients, including in-flight handshakes and metadata clients, count against the
same eight-session limit. Logins/operations have bounded deadlines. Failed or dropped
metadata responses retire that socket; errors instruct the user to reconnect.

Credentials use `collab-database-v1` and an application-profile-scoped native UUID
for each password revision. Metadata stores only that opaque reference, never a
password or connection string. Changing the target/login requires a password before
opting into durable storage again; a prior credential cannot silently follow a new
host. Password updates use independent entries so stale operations cannot delete
or overwrite a concurrent winner's secret. Retired references remain in bounded
metadata until deletion succeeds and can be retried by saving/removing the profile.
OS credential writes and local metadata replacement cannot form one atomic OS
transaction: failures are surfaced and newly created entries get a cleanup attempt.
Simultaneous filesystem and credential-store failures still require native
qualification and user recovery, not a plaintext fallback.

On Linux, durable storage explicitly uses Secret Service; session-only mode does
not touch it or keyutils. Windows uses Credential Manager and macOS uses Keychain.
Keyring calls run on blocking workers without holding the registry lock. Flatpak
exposes session-only storage until Secret Service packaging is qualified; this
phase adds no sandbox permission. Credentials never enter Zustand, localStorage,
vault files, results or diagnostic errors. Native cached passwords are zeroized
on drop; this does not claim third-party driver allocations are fully zeroized.

Connection metadata lives in the app configuration directory, in a bounded
`database-<profile hash>.json` file replaced atomically through a private temporary
file. There are at most 32 saved connections and 32 retired credential references
per connection. No query history or result persistence is introduced.

## Metadata And Errors

The native API accepts a typed request for databases, schemas, objects, columns or
indexes plus a cursor; it accepts no SQL from the frontend. Queries use fixed statements and bound parameters against SQL Server system
catalogs, MariaDB information schema, or SQLite schema tables and pragmas. Each query
fetches 101 bounded rows to return 100 plus a continuation cursor. Field casts,
row/field checks and one-page rendering bound this path; metadata is not collected
into an unbounded cache. Empty lists explain that permissions may hide objects.

TLS, SQL-login, permission, timeout, stale binding, budget and credential failures
have safe codes and actionable UI text. Raw backend diagnostics, connection
strings, SQL values and passwords are never forwarded to the renderer or logs.
Metadata results from closed sessions/previous profiles are rejected; stale React
responses cannot populate a new profile's view.

## Testing

Follow the [release validation matrix](../build/database-release-validation.md)
for disposable fixture commands, known coverage gaps, and installed-platform
acceptance. Historical evidence for driver selection and the initial workspace
is retained in the [Phase 0 contract](../plans/database-editor-phase0-contract.md)
and [Phase 1 fixture report](../build/database-phase1-evidence.json).
