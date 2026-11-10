# Database Editor Plan

Status: **Phase 2 implemented; native release acceptance pending**. Created **2026-11-10**.

[Phase 0 contract and driver evidence](./database-editor-phase0-contract.md) records
the Linux fixture results and outstanding native platform acceptance.

The [main tracker](./open-development-work.md) owns overall project status.
Checkboxes below describe implementation and acceptance, not features already
available. This plan adds a desktop database editor; it does not expand Collab
into a full database administration suite.

## Product Boundary

Provide a first-party workspace for connecting to databases, writing queries,
browsing data, inserting/updating/deleting rows, and making ordinary schema
changes. Microsoft SQL Server is the first usable target. SQLite and MariaDB are
required follow-on engines, supported through the same application contracts
with explicit dialect and capability differences.

Initial delivery is desktop only. Browser and Android database execution,
server-managed database connections, shared credentials, and scheduled queries
are deferred. No collaboration-server database proxy is required for desktop
connections. The collaboration server's own PostgreSQL database remains unrelated
to this feature.

Full administration is outside scope: backup/restore consoles, replication,
SQL Server Agent, instance lifecycle management, enterprise monitoring, and
comprehensive login/role administration. A general SQL editor can still execute
statements permitted by the connected account; this boundary limits dedicated
product features rather than claiming to restrict arbitrary SQL.

## User Experience

- Add a Databases workspace accessible independently of an open vault.
- Use a searchable secondary sidebar for connections, databases, schemas,
  tables, views, columns, keys and indexes. Load metadata on demand.
- Provide query tabs and table-browser tabs with a resizable editor/results
  split, result-set tabs, messages, errors and execution status.
- Display the connection, database, environment label and transaction state
  persistently. Running queries never silently follow a global connection switch.
- Offer SQL highlighting, schema-aware completion, execute selection/batch,
  cancellation, query history, formatting, CSV export and keyboard navigation.
- Keep result browsing read-only initially; add explicit edit mode with a pending
  changes panel and a review/apply/discard workflow.
- Preview generated SQL before schema changes. Describe unsupported capabilities
  instead of presenting controls that cannot work on the selected engine.
- Use shared controls, theme tokens and `DocumentTopBar` conventions. Reuse
  CodeMirror infrastructure and grid virtualization techniques, with a dedicated
  database result model rather than the `.sheet` formula/editing model.

Saved `.sql` scripts may use normal vault file APIs, revisions and collaboration.
Connection secrets, result sets and execution history are local, separate data.
Opening or receiving a script never connects or executes it automatically. Sharing
script text does not share credentials, permissions, results, or query execution.

## Architecture And Ownership

### Native Execution

Introduce a database domain contract for connection metadata, engine capabilities,
identifiers, typed parameters/results, schema objects and mutation plans. Portable
contracts must remain free of Tauri, SQLx, concrete drivers and OS integration.
Driver adapters and credential/file access live in native adapter modules. Phase 0
decides whether the portable surface warrants a new crate; any new crate must be
registered in the workspace boundary policy.

Typed wrappers in `src/lib/tauri.ts` expose native-owned connection, session,
query and result handles. Credentials and open database sockets stay in the
native layer after connection setup. Bound query admission, result bytes, queued
IPC batches, metadata caches, connection counts and idle retention. Stream results
with backpressure rather than transferring an unbounded JSON array.

Each query tab pins its session, database context, temporary objects and transaction
state. Metadata operations use independent sessions where needed. Pooling must
not move a transaction, temporary table or session setting onto another tab.
Define states including connecting, idle, executing, cancelling, transaction-open,
failed and outcome-unknown. Profile lock/switch, disconnect, tab close and app exit
must explicitly resolve session ownership and pending changes.

### Drivers And Engines

| Engine     | Connection model                                            | Adapter investigation                                                                                                                       |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL Server | Native TCP connection; explicit database and authentication | Evaluate Tiberius and Microsoft mssql-rs against real target servers; SQLx's existing core drivers are not a built-in MSSQL implementation. |
| SQLite     | Native-owned handle to an explicitly selected local file    | Evaluate the existing SQLx SQLite adapter for dynamic queries, cancellation, locking and bounded streaming.                                 |
| MariaDB    | Native TCP connection; explicit database and authentication | Evaluate SQLx's MySQL/MariaDB adapter against supported MariaDB versions and SQL modes.                                                     |

Driver selection is a Phase 0 gate, not a decision to add dependencies immediately.
Check released-version maintenance, licensing, packaging, TLS, type coverage,
authentication and cancellation. Decide the minimum supported server versions and
OS/authentication matrix before claiming compatibility.

Keep capability discovery explicit: schema namespaces, transactional DDL,
`RETURNING`/`OUTPUT`, generated columns, version tokens, identifier quoting,
parameter markers and available alteration operations differ between engines.
Avoid a generic SQL string rewriter that assumes those differences disappear.

### Credentials And Local Storage

Connection profiles contain non-secret display/endpoint/preferences data under
profile ownership, separate from connected Collab servers. Store secrets through
a dedicated native credential namespace using existing OS-keystore patterns.
Provide explicit session-only versus durable storage and explain keyring prompts.
Redact credentials, connection strings and SQL parameter values from diagnostics.
Use verified TLS by default for network connections; custom CA/trust decisions
are per connection and must not reuse a Collab-server exception implicitly.

SQLite files are not text documents and must not be written through `write_note`,
Yjs, or ordinary vault synchronization. Start with explicitly selected local files;
native pickers retain filesystem authority and return opaque handles rather than
adding arbitrary-path IPC access. Define WAL/SHM handling, locks, backup-copy
behavior and missing/moved-file errors. Opening a hosted download is an explicit
local copy, with no automatic write-back. Do not silently place plaintext database
files or result spill files in encrypted vault storage; encrypted-vault integration
requires a separate supported storage design.

Keep result caches session-scoped and in memory initially, with explicit limits.
A query history policy needs retention, clear/disable controls and profile
isolation: SQL text itself can contain sensitive literals. Persistent history
must use the profile's protected storage policy; otherwise keep it session-only.
Exports are explicit user actions, with destination confirmation and exact type
serialization. Sharing/exporting results never happens as a side effect of saving
SQL text.

## Editing And Execution Contracts

### Query Execution

- Preserve SQL NULL, empty strings, binary data, Unicode, time precision and exact
  decimal/integer values. Do not round SQL bigint/decimal through JavaScript Number.
- Support multiple result sets, messages, affected-row counts and source-relative
  errors. Implement SQL Server `GO` batch handling with lexical awareness; never
  split on occurrences inside strings/comments. SQLCMD directives are deferred.
- Parameterize generated filters and edits; quote identifiers per dialect. Raw
  user SQL remains raw SQL, executed only through an explicit run action.
- Do not infer a safe read-only connection by checking whether text starts with
  SELECT. Use database privileges/engine-enforced restrictions where available;
  connection labels and SQL Server application intent are not authorization.
- Cancellation must stop server work and drain/reset or retire the connection as
  appropriate. A UI timeout alone is not cancellation. Never transparently replay
  writes after disconnect; surface an unknown outcome when commit/execution may
  have succeeded without an acknowledgement.
- Browse tables with bounded server-side pages and deterministic ordering where
  available. Stream arbitrary queries without blindly appending LIMIT/OFFSET or
  re-executing statements to fetch another page. Distinguish sorting loaded rows
  from querying the full dataset and mark truncated results clearly.

### Safe Row Changes

Enable editing only for supported base-table rows with a primary or suitable
unique, non-null key and a verifiable concurrency predicate. Arbitrary query
results, joins and views remain read-only unless a later feature proves a safe
mapping. Never fall back to physical row position, an assumed SQLite rowid, or
updating every row matching a non-unique filter.

Stage typed inserts/updates/deletes locally. Preserve NULL/default/generated-value
distinctions and show errors without discarding pending edits. On Apply, use
parameterized statements and an engine-appropriate transaction, verify exactly
one target row per update/delete, and check original values or an available
version token. A conflict rolls back the batch and offers reload/review rather
than a blind retry. Retrieve generated identifiers/defaults before refreshing.

Separate grid Apply transactions from manual query transactions. Never commit an
unrelated transaction implicitly. Show open transactions persistently and resolve
them explicitly before session disposal. Concurrency predicates, affected-row
semantics and transaction behavior require adapter-specific tests.

### Schema Changes

Browse and edit ordinary table/column definitions, keys and indexes through a
capability-driven form and generated SQL preview. Refresh the metadata stamp
before application and require review if the source schema changed. Show potential
data loss and lock implications for destructive operations.

Model multi-step operations explicitly. MariaDB DDL can implicitly commit; SQLite
alterations may require rebuilding a table. Do not promise universal rollback.
Refuse unsupported rebuilds or dependency changes until preservation of data,
constraints, indexes, triggers and foreign keys is verified. Dependency-aware
rename/drop behavior is part of acceptance, not a cosmetic form feature.

## Delivery Phases

### Phase 0 — Contracts And Driver Spike

- [x] Confirm supported SQL Server versions and required authentication modes;
      assess SQL login, Windows integrated authentication and Entra separately.
- [x] Compare candidate drivers on real SQL Server fixtures: TLS, types, multiple
      results/messages, transactions, cancellation and connection recovery.
- [x] Define capability, typed value, session, streaming, edit/conflict and error
      contracts; choose native adapters and ownership boundaries.
- [x] Set measured connection/result/IPC limits, history policy and the native
      Windows/Linux/macOS test matrix. Verify packaging implications, including
      Flatpak credential access and selected-file authority.

Exit: an executable connection/cancellation prototype and written driver/contract
decisions. A successful SELECT alone does not pass this gate.

### Phase 1 — SQL Server Connections And Workspace

- [x] Implement native connection registry, credential integration, TLS settings,
      connect/test/disconnect and profile/session cleanup.
- [x] Add lazy workspace routing, connection sidebar and pinned query-tab context.
- [x] Load databases/schema metadata on demand with permission-aware error states.

Exit: multiple connections/tabs remain isolated across switches and failures;
normal Collab startup does not eagerly load the database feature.

Implementation, fixtures and outstanding native acceptance:
[Database workspace](../desktop/database-workspace.md).

### Phase 2 — Queries And Read-Only Results

- [x] Add SQL editor, batch/selection execution, cancellation and messages/errors.
- [x] Implement bounded multi-result streaming, virtualized results, value inspector,
      table browsing/filtering, explicit truncation and export.
- [x] Add schema-aware completion, saved `.sql` scripts and bounded local history.

Exit: large results remain responsive within budgets; cancellation and connection
loss do not leave an apparently idle session executing work unnoticed.

Implementation and validation boundaries: [SQL queries](../desktop/database-queries.md).
Packaged platform, real WebView/IPC, OS save-picker and reconnect acceptance remain open.

### Phase 3 — SQL Server Data Editing

- [ ] Add eligible-row detection and explicit edit mode, typed cell editors,
      inserts/deletes and pending-change review.
- [ ] Implement transactional Apply, optimistic concurrency, exact affected-row
      checks, generated values, conflict review and unknown-outcome handling.
- [ ] Add visible manual transaction controls with safe tab/session disposal.

Exit: dependable query and row-edit workflows form the first usable release.
Test competing clients, triggers, constraint errors and interrupted commits.

### Phase 4 — SQLite

- [ ] Implement local-file selection/creation and native file-handle ownership.
- [ ] Add schema browsing, query execution, typed results and safe row edits through
      the shared contracts; cover WITHOUT ROWID and keyless tables explicitly.
- [ ] Validate WAL/external-writer contention, busy timeouts, read-only files,
      cancellation, moved files and crash recovery without corrupting databases.

Exit: file-based editing works without leaking database files into text-vault sync.

### Phase 5 — MariaDB

- [ ] Implement connection/authentication/TLS and engine capability discovery.
- [ ] Add metadata, query/results and safe data edits through the shared workspace.
- [ ] Cover SQL modes, quoting, collations, exact numeric types, generated values,
      affected-row semantics and transactional versus non-transactional tables.
      Disable atomic grid Apply where the storage engine cannot guarantee it.

Exit: supported MariaDB versions pass the same edit/conflict contract with their
engine-specific restrictions visible to users.

### Phase 6 — Schema Editing Across Supported Engines

- [ ] Add table/column creation and supported alterations, keys and indexes.
- [ ] Preview generated SQL, refresh stale metadata, check dependencies and describe
      data-loss/locking/implicit-commit behavior before application.
- [ ] Implement and validate bounded SQLite rebuilds only for supported cases;
      preserve dependencies or refuse the operation with an actionable explanation.

Exit: schema changes preserve declared data/dependency guarantees; unsupported
operations cannot silently degrade to destructive approximations.

### Phase 7 — Hardening And Product Acceptance

- [ ] Run driver-backed suites against disposable SQL Server/MariaDB instances and
      temporary SQLite files; never run mutation fixtures against user databases.
- [ ] Cover slow networks, dropped connections, cancellation races, unknown commit
      outcomes, expired credentials, permission changes and profile/tab shutdown.
- [ ] Measure large/wide/multiple results, metadata scale, long values, retained
      memory and IPC backpressure on packaged native builds.
- [ ] Validate keyboard/screen-reader workflows, scaling, Linux/Windows/macOS,
      credential stores, installation and Flatpak file/network integration.
- [ ] Update user documentation, architecture, driver capability/version matrix,
      security advisory rationale where dependencies require it, and main tracker.

Exit: record native acceptance separately from browser/unit evidence. Run suites
at each completed batch's end, rerunning only affected checks after corrections.

## Deferred Expansion

PostgreSQL, browser/mobile execution, a controlled connection gateway, tunnel
management, shared result snapshots, diagramming, schema comparison/migrations,
and richer query-plan analysis can be planned after the supported editor is
stable. They are not prerequisites for the requested SQL Server/SQLite/MariaDB
query, data-editing and ordinary schema-editing workflows.

## References And Investigation Inputs

Current driver capabilities must be rechecked during Phase 0; these references do
not establish compatibility with a particular released dependency or environment.

- [SQLx supported databases](https://github.com/transact-rs/sqlx)
- [Tiberius SQL Server driver](https://github.com/tiberius-rs/tiberius)
- [Microsoft mssql-rs](https://github.com/microsoft/mssql-rs)
- [Microsoft integrated authentication guidance](https://learn.microsoft.com/en-us/sql/connect/odbc/linux-mac/using-integrated-authentication)
- [Desktop architecture](../desktop/codebase.md)
- [Desktop UI guide](../desktop/ui-guide.md)
