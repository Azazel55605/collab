# Database Workspace

Phase 1 adds desktop SQL Server connection management and metadata browsing.
Phase 2 adds [queries and read-only results](./database-queries.md). Phase 3 adds
[staged row editing](./database-queries.md#edit-table-rows) for eligible SQL Server tables. Phase 4 adds
[local SQLite files and vault snapshots](./database-queries.md#local-sqlite). [Plan](../plans/database-editor-plan.md),
[Phase 0 contract](../plans/database-editor-phase0-contract.md).

## Connect And Browse

Open **Databases** in the activity bar, or **Open databases** on the vault picker.
A vault is not required; the workspace is also available while a vault is locked.
It is loaded lazily when opened.

1. Choose **New connection**, enter a connection/environment label, plain hostname
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

Phase 2 executes SQL and guards running work, dirty scripts and open/unknown
transactions before disposal. See [queries and read-only results](./database-queries.md).

## Native Ownership And Credentials

`src-tauri/src/database/` owns the registry, native-issued UUID handles, connections,
credentials, metadata queries, cancellation trees and the global eight-socket
budget. Commands in `commands/database.rs` accept only the main desktop window.
Android registers none of these commands and does not depend on the SQL Server
adapter. The collaboration server remains unrelated.

A workspace token binds all commands to the active local application profile.
Profile changes invalidate the token, cancel pending logins/metadata operations,
close sessions and release cached secrets. A native current-profile guard rejects
late activation by a previous profile; frontend profile notifications are ordered
before a new workspace activation. A view switch preserves native sessions;
profile switches and process exit do not.

Sockets are never implicitly pooled, replayed or reconnected. Each tab has its own
client. Root metadata uses the connection's dedicated metadata client; tab metadata
uses a separate short-lived client in the pinned database, never the tab's client.
All clients, including in-flight handshakes and metadata clients, count against the
same eight-socket limit. Logins/operations have bounded deadlines. Failed or dropped
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
indexes plus a cursor; it accepts no SQL from the frontend. Queries are fixed,
parameterized `sys.*` reads using the connected account's permissions. Each query
fetches 101 bounded rows to return 100 plus a continuation cursor. Field casts,
row/field checks and one-page rendering bound this path; metadata is not collected
into an unbounded cache. Empty lists explain that permissions may hide objects.

TLS, SQL-login, permission, timeout, stale binding, budget and credential failures
have safe codes and actionable UI text. Raw backend diagnostics, connection
strings, SQL values and passwords are never forwarded to the renderer or logs.
Metadata results from closed sessions/previous profiles are rejected; stale React
responses cannot populate a new profile's view.

## Validation And Remaining Acceptance

The Phase 1 fixture extension uses the same disposable Developer containers as
Phase 0, with generated certificates and loopback ports:

```sh
cargo test -p collab database::tests -- --test-threads=1
COLLAB_DB_SPIKE_ACCEPT_EULA=yes python scripts/database-driver-spike.py \
  --versions 2019 2022 2025 --skip-build --native-adapter \
  --output /tmp/database-phase1-evidence.json
```

Prebuild the native tests and isolated spike before using `--skip-build`.
[Recorded fixture evidence](../build/database-phase1-evidence.json) includes the
production registry checks alongside the driver comparison. Native tests cover
owned pending-login cancellation, token invalidation, forged bindings, independent
connections/tabs, wrong-password/TLS classification, paged metadata, columns/indexes,
typed cursor injection rejection, connection budgets and cleanup. Unit fixtures
never connect to an arbitrary user endpoint.

Browser QA uses Playwright because the Browser plugin is not available. The flow
is an isolated workspace route → select connection → enter synthetic password →
connect → open database session → render schemas → open/close connection dialog.
Chromium at 1440×900 and 900×700 showed meaningful content, no framework overlay,
no page errors, cleared password input, pinned context and no horizontal overflow.
This uses synthetic IPC responses; it is not real native IPC certification.

Outstanding installed-platform acceptance remains: Windows/macOS driver linking
and certificate roots, Linux installed package/Flatpak behavior, real OS credential
save/read/delete and unlock failures, suspend/network changes, and actual Tauri
WebView IPC/rendering. Integrated authentication, Entra, additional CA imports,
SQLite file authority and all query/mutation behavior retain their later-phase gates.

### Batch Check Results

- All 21 recorded fixture cases passed: 18 driver/TLS cases plus the production
  registry integration test on SQL Server 2019, 2022 and 2025. Fixture containers
  and generated credentials were cleaned up.
- Rust workspace tests/checks passed; final native profile-guard changes passed
  the affected native regressions, workspace check and refreshed real fixture run.
- The desktop suite passed 384 files with one skipped; three existing
  deck/spreadsheet tests hit their five-second timeout during concurrent builds.
  Both affected files passed all 79 tests on a one-worker rerun without timeout
  or implementation changes. The final database/routing regressions passed
  separately, including form password separation and session-only storage controls.
- TypeScript, desktop production build/bundle budgets, admin tests/build, mobile
  tests (258), crate boundaries, version alignment, lint and formatting passed.
  Existing lint warnings remain; new database files add none.
- Dependency audit completed with the same nine allowed workspace warnings.
  Advisory policy was not changed.
- Compose configuration passed. Server smoke could not build the unchanged
  server image because upstream Debian-security APT indexes returned **Hash Sum
  mismatch**. This is an unverified smoke check, not a passing server acceptance.

Browser QA used the installed Python Playwright CLI and Chromium 1187 against an
isolated Vite route at `http://127.0.0.1:1422/`. That temporary route and its
synthetic IPC fixture were removed after screenshot/interaction checks.

| Browser check                                                     | Result                         |
| ----------------------------------------------------------------- | ------------------------------ |
| Expected URL/title and meaningful workspace content               | Passed                         |
| Framework error overlay / uncaught page errors                    | None                           |
| Connection → cleared password → pinned database session → schemas | Passed                         |
| Connection dialog, close interaction and accessible field labels  | Passed                         |
| Desktop/compact screenshot inspection, overflow                   | Passed at 1440×900 and 900×700 |

These browser results do not replace the native and OS acceptance gaps above.
