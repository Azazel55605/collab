# Database Release Validation

Status: **Testing**. The desktop workspace implements connection management,
query execution, row editing, and supported schema changes. This guide tracks
evidence and remaining acceptance. Record the build, platform, engine version,
test case, expected result and observed result with each installed-app run.

## Driver And Capability Matrix

| Engine     | Desktop adapter and version scope                                                                                                               | Authentication and transport                                                                                                            | Editing scope                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL Server | Microsoft `mssql-tds` 0.4.0 with the [vendored diagnostic limits](../../vendor/mssql-tds/COLLAB-PATCH.md). Fixture targets 2019, 2022 and 2025. | SQL login, verified TLS using system trust, optional certificate hostname. Windows integrated authentication and Entra remain deferred. | Pinned query sessions, multiple results, eligible keyed table edits, table/nullable column creation, primary keys, indexes.                 |
| SQLite     | `rusqlite` 0.41 with the bundled `libsqlite3-sys` 0.39.1 shared with SQLx.                                                                      | Desktop picker opens or creates a local file, with explicit read-only mode. SQLite vault attachments are separate snapshots.            | Typed queries, keyed edits including eligible WITHOUT ROWID tables, schema creation and indexing, native rename and bounded column removal. |
| MariaDB    | SQLx MySQL 0.9, minimum MariaDB 10.11. Fixtures target 10.11 and 11.4.                                                                          | SQL login and hostname-verified TLS using desktop system trust.                                                                         | One prepared statement per run, eligible trigger-free keyed InnoDB edits, table/nullable column creation, primary keys, indexes.            |

Linux durable network passwords use Secret Service, Windows uses Credential
Manager, and macOS uses Keychain. Flatpak exposes session-only passwords.
See [connection setup](../desktop/database-workspace.md) and
[query and edit behavior](../desktop/database-queries.md).

## Run Disposable Fixtures

These commands use only newly created loopback containers and temporary files.
SQL Server Developer requires license acceptance.

```sh
cargo test --locked -p collab --lib database::

COLLAB_DB_SPIKE_ACCEPT_EULA=yes python3 scripts/database-driver-spike.py \
  --versions 2019 2022 2025 --native-only --native-adapter \
  --output /tmp/collab-sqlserver-acceptance.json

./scripts/database-mariadb-fixture.sh 10.11
./scripts/database-mariadb-fixture.sh 11.4
```

The fixtures generate credentials and CAs, bind a random loopback port, and
remove their own instances after the run. The SQL Server report includes the
image digest, cancellation time, encoded result bytes, rows retained, and
Linux process peak RSS where available. Keep these measurements scoped to the
test executable.

## Phase 7 Fixture Results

On 2026-11-13, Linux x86_64 passed the SQL Server 2019, 2022 and 2025
registry and editing fixtures, the MariaDB 10.11 and 11.4 TLS fixtures,
and the SQLite temporary-file suite. Each SQL Server run streamed 15,360
rows (8,353,098 encoded bytes). Cancellation took 2–3 ms and peak RSS for
the test process was approximately 42–43 MiB. See the
[SQL Server fixture report](./database-phase7-sqlserver-evidence.json).

The MariaDB fixture killed a running query's connection and verified the
driver reports an unknown outcome and retires the tab. The SQLite
regression closed a session while its result queue was full and verified
that the file was released and its uncommitted write rolled back.

## Automated Coverage

| Area                           | Evidence                                                                                                                                                                                                                                                        | Remaining qualification                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL Server driver and registry | TLS/login rejection, independent sessions, paged metadata, exact values, bounded diagnostics, streamed results, server-side cancellation, killed connection, stalled consumer, row conflicts, simulated lost commit acknowledgement, and stale schema previews. | Slow/lossy network, repeated cancellation races and permission or credential changes during use on installed clients.                         |
| MariaDB driver                 | TLS hostname and login rejection, typed results, strict mode, DDL implicit commits, retired cancellation, killed connection, atomic edit conflicts, generated values, and stale schema previews.                                                                | Connection loss during commit, slow/lossy links, expired credentials and permission changes, and large-result profiling on installed clients. |
| SQLite driver                  | Read-only mode, file replacement, WAL contention and snapshot, cancelled SQL, rollback on shutdown under backpressure, process-exit recovery, keyed edits, and preservation of unrelated data/indexes during supported schema rewrites.                         | Native picker and backup dialogs, file move during a long write, and recovery on installed platform filesystems.                              |
| Rendered desktop UI            | Chromium with mocked IPC exercised connection and metadata flows, SQLite edit/backup flows, and schema preview with destructive confirmation and refresh.                                                                                                       | Real Tauri IPC/WebViews, keyboard and screen readers, package permissions, and repeated suspend/resume.                                       |

Earlier driver and workspace evidence is retained in the
[Phase 0 contract](../plans/database-editor-phase0-contract.md) and
[Phase 1 report](./database-phase1-evidence.json). See the
[database plan](../plans/database-editor-plan.md) for delivery status.

## Installed Desktop Acceptance

Use a disposable database or copy for every destructive, failure-injection or
load case. Record **pass**, **fail**, or **blocked** for each applicable
platform and engine. Keep screenshots and traces free of passwords, connection
strings, private SQL, and result data.

| Installed target | Acceptance to record                                                                                    | Status  |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ------- |
| Linux native     | SQL Server and MariaDB TLS, Secret Service save/unlock/delete, SQLite picker and backup, WebKitGTK IPC. | Pending |
| Linux Flatpak    | Network access and system trust, session-only password flow, file portal grants for open/create/backup. | Pending |
| Windows          | SQL login and system trust, Credential Manager, file picker, WebView2 and installation/update.          | Pending |
| macOS            | SQL login and system trust, Keychain, file picker, WKWebView and installation/update.                   | Pending |

### Functional And Failure Cases

- [ ] Connect with valid, expired or revoked credentials. Verify a wrong
      hostname and an unknown CA fail. Rotate saved credentials and check that
      profile switching clears live sessions.
- [ ] Browse multiple metadata pages, run selected SQL, inspect exact large
      numeric values and export the loaded results.
- [ ] Stage conflicting edits from two sessions. Verify rollback and refresh.
      Check generated values and safe rejection of keyless or unsupported tables.
- [ ] Preview schema changes, modify the schema elsewhere, then verify that the
      old preview is rejected. Check the SQLite dependency and data-loss prompts.
- [ ] Apply a permission change after preview, then verify a safe error and
      inspect the database. Repeat with a stalled or disconnected network at
      query, Apply, and commit boundaries. Check that ambiguous outcomes are
      explicit and that SQL is never replayed automatically.
- [ ] Cancel repeatedly near completion. Close a busy tab and switch profiles
      with an open transaction. Check rollback, explicit disposal and secret
      cleanup. Suspend and resume an active connection.
- [ ] Use keyboard navigation and a screen reader for connection, schema, query,
      result, row-edit and preview controls. Check readable scaling and focus
      restoration after errors or dialogs.

### Packaged Performance

- [ ] Use large results, wide rows, multiple SQL Server result sets, long text
      and binary values, and large metadata catalogs. Record time to first
      result and completion, rows and bytes delivered, and truncation status.
- [ ] Throttle the renderer and verify the two-frame credit window, cancellation
      and terminal outcome. Measure native and WebView memory before, during,
      and after closing the tab. Record repeated runs and retained memory.

Keep the plan and main tracker in **Testing** until installed evidence covers
the release targets or the release scope explicitly documents an exception.
