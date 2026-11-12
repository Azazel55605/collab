# Database Queries And Read-Only Results

Phase 2 extends the [database workspace](./database-workspace.md). The
[main tracker](../plans/open-development-work.md) owns current acceptance status.
Raw SQL runs with the connected account's permissions; it can write or administer
the server. Query result grids are read-only. Eligible SQL Server base tables have a separate edit mode.

## Run SQL

Open a database session from an active connection. The SQL editor stays pinned to
that session and database. **Run batch** executes the document; **Run selection**
executes the selection, falling back to the document when empty. Ctrl/Cmd+Enter
uses the same selection rule. The source is read-only while results are arriving
so errors cannot point into a different draft.

A standalone `GO` line separates sequential server batches. The lexer respects
strings, quoted/bracketed identifiers, line comments and nested block comments.
`GO -- comment` and `GO--comment` work. SQLCMD directives and GO repeat counts are
rejected before any batch runs. Selections and error locations use UTF-16 offsets,
including text containing emoji; an error offers **Show source** and the numeric
SQL Server error code. Raw backend error strings are not forwarded.

**Cancel query** requests cooperative cancellation and waits for bounded protocol
settlement. Cancellation does not undo already committed statements. Each new
physical connection establishes `IMPLICIT_TRANSACTIONS OFF`; user SQL can still
open/change transactions. A post-execution probe checks database context,
`XACT_STATE()` and `@@TRANCOUNT`. The latter distinguishes a retained user
transaction from the probe's own autocommit read transaction. Open/failed states
remain visible. **Begin transaction**, **Commit transaction**, and **Roll back
transaction** send fixed commands on the pinned session. Commit requires
confirmation. SQL Server commits nested transactions one level at a time, so the
badge stays open until the outermost transaction is committed. Rollback resolves
the whole transaction, including a failed transaction.

Connection loss, failed cancellation settlement, worker failure or unverified
context never becomes an apparently idle, reusable connection. The physical
session is retired and an unknown outcome is explicit. Nothing reconnects or
replays a statement automatically. `USE` or another context change retires the
session rather than silently changing its pinned database badge.

## Results, Browsing And Export

Result-set tabs preserve each set's column metadata and exact typed values.
Messages and affected-row counts are separate from rows. The grid virtualizes
rows and columns; click or press Enter/Space on a cell for the read-only inspector.
NULL, empty text, exact bigint/decimal strings, binary Base64, temporal offsets and
explicit unsupported/truncated values remain distinct. Numerics never pass through
JavaScript Number. Unsupported native types remain read-only and identified.

**Browse metadata** shows schemas/objects/columns/indexes in a separate native
session. An object's **Browse rows** action or the schema/table fields opens a
bounded preview in the current pinned query session. Identifiers are quoted
natively; a contains-text filter is a bound parameter with literal LIKE escaping.
The preview stops at 500 rows and does not imply a stable sort or pagination key.
Use SQL for an explicit order, projection or more specific query.

**Load completion schema** loads visible schema/table/column names on demand in
100-column pages, up to 1,000 columns. Completion never opens another connection
profile or executes user text. Metadata permissions can hide objects.

**Export loaded CSV** and **Export typed JSON** export only the current retained
result set. They never rerun SQL. Truncation markers remain visible; JSON retains
the typed NULL/empty/precision distinctions. CSV quotes fields and protects text
cells and headers from spreadsheet formula interpretation; use JSON for lossless
exchange. A native save picker grants destination authority, and an atomic staged
write saves the bounded payload. No filesystem path crosses back from the picker
to the renderer. Results are not written into vaults or synced automatically.

## Edit Table Rows

Choose a schema and table in the browse controls, then select **Edit table
rows**. The optional contains filter also applies to this view. Collab loads up
to 100 rows ordered by the selected key. Filter to reach rows beyond this
window. Queries, views, and ineligible tables remain available through the
read-only workspace.

Eligibility requires a SQL Server base table with a primary key or an
unfiltered, enabled unique index over non-null, non-computed columns. The login
needs SELECT, VIEW DEFINITION, and the appropriate permissions for the requested
writes. Phase 3 supports up to 32 columns with bounded exact integers, decimals,
bits, text, binary, GUIDs, dates, and modern time types. Unicode text is
supported in nchar/nvarchar. Writes to char/varchar accept ASCII to avoid
code-page loss. Unsupported types and enabled INSTEAD OF triggers make a table
ineligible. Identity, computed, and rowversion columns are read-only. Existing
key values are read-only.

Select a cell to stage an edit or delete its row. **Insert row** opens a form for
writable columns. Value, NULL, and database default are distinct choices where
allowed. Review the pending changes and select **Apply** to commit them
together. A successful Apply shows values returned by SQL Server, including
generated identities, defaults, and changes made by AFTER triggers, then
reloads the window. A refresh failure keeps the commit receipt visible.

The native adapter keeps the metadata and original values in memory and
accepts only snapshot and row handles for that tab. Apply opens a separate
connection with the same login. It holds a table lock while rechecking
metadata, uses parameterized statements, and verifies exactly one affected row
per change. The predicates compare the key and rowversion when present, or
compare the exact bytes and length of each original value. Changes roll back
together on a conflict or a rejected statement. A conflict keeps the staged
values available for review. Reloading discards them explicitly.

Apply allows at most 128 changes with a 1 MiB request and result limit. The
server lock wait is capped at three seconds, and the mutation work has a
20-second deadline. An unconfirmed commit is marked **Apply outcome unknown**.
Verify the data in a new session before making further edits. Close the
affected session explicitly to resolve the local warning.

### Phase 3 verification

Disposable native fixtures passed on SQL Server 2019, 2022, and 2025. They cover
key eligibility, forged row and snapshot handles, generated values, AFTER
triggers, all-or-nothing constraint rollback, competing updates with rowversion
and original values, schema changes, and manual transaction disposal. The
fixture simulates losing the acknowledgement after a real commit and verifies
that one write remains and the snapshot cannot be applied again.

Chromium preview checks used simulated IPC for staging, conflict review,
reloading, generated values, and manual transaction controls. Installed
Windows, Linux, macOS, and Flatpak verification remains open.

## Scripts, History And Disposal

**Open .sql** and **Save .sql** use relative paths in the current unlocked vault
through `vaultClient`, including its encryption, hosted/offline and revision
boundaries. New local scripts start empty, without a Markdown heading. Scripts
use the existing UTF-8 note transport; Markdown reference discovery/rewrites skip
SQL source so string literals cannot be changed by note renames. A generic file
view does not connect or execute SQL. The query workspace loads script text only
on an explicit Open action; receiving/opening text never grants execution authority.

Saved script references retain vault identity, version and base text across tab
and workspace switches. Changing vaults requires a new destination; saves never
silently follow a vault switch. Conflicts preserve the draft and require reload
or Save As. An asynchronous Open cannot overwrite edits made while its read was
pending. SQL text can contain sensitive literals: only explicit script saves use
normal file sync. Passwords, result sets and query history remain separate.

History is native session memory only, capped at 100 entries / 1 MiB. Selecting
history loads text without executing it, and refuses to replace dirty SQL. Clear
history is explicit; closing a session or a successful profile teardown removes
it. Browser stores contain no persistent history or results. Frontend SQL/result
caches follow native registry snapshots and are discarded when their sessions
close; switching views preserves active caches and result pulling.

Ctrl/Cmd+Tab cycles database sessions and Ctrl/Cmd+W opens a discard confirmation,
without closing hidden document tabs. Ctrl/Cmd+S in the editor opens script Save.
A session close explicitly discards its SQL draft/results/history, stops running
work and closes the physical socket. It never commits a transaction; committed
changes cannot be undone by closing. Disconnect/edit/remove refuse unresolved
sessions and dirty drafts until the tabs are resolved or explicitly closed.
Quit and profile changes are blocked by dirty drafts, staged row edits, or unresolved native work;
a rejected profile change restores the previous local profile.

## Bounded Native Stream

`database/query.rs` owns one worker per active query and a two-credit result
queue. `database_query_poll` acknowledges only the exact previous sequence; it
replays an unacknowledged frame and rejects stale IDs, forged bindings and invalid
acknowledgements. Metadata, rows, messages, counts and completion share the same
window. The worker reserves credit before another row/native value read; renderer
failure cannot keep server work running indefinitely.

| Boundary                            | Limit / behavior                                                            |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Physical connections                | 8 globally, including metadata and pending handshakes                       |
| SQL / batch count                   | 1 MiB UTF-8 / 128 GO batches                                                |
| Query / command deadline            | 300 seconds overall / 120 seconds per server batch                          |
| Slow consumer                       | 5-second credit deadline, then cancel or retire                             |
| Cancel settlement / state probe     | 3 seconds each; failure retires the socket                                  |
| Frame                               | At most 128 rows / 256 KiB encoded                                          |
| Outstanding frames                  | 2, at most 512 KiB encoded, including pending acknowledgement               |
| Whole result across all sets/events | 100,000 rows / 8 MiB encoded, with completion reserve                       |
| Cell / row admission                | 64 KiB encoded cell / conservative 64 KiB row                               |
| Large PLP values                    | Read at most 16 KiB wire prefix; show a bounded preview and stop explicitly |
| Legacy text/ntext/image LOBs        | Refuse before row materialization; use an explicit bounded cast/projection  |
| Result sets / messages / counts     | 256 / 256 / 1,024 per execution                                             |
| Driver diagnostics                  | INFO and ERROR each bounded to 256 entries / 64 KiB per command             |
| Export request                      | 16 MiB; only already loaded results                                         |

Native frame bounds exclude fixed status-poll envelopes, OS socket buffers and
renderer object overhead. Queue credits bound native retained frames, while the
frontend retains only the admitted 8 MiB result representation per live session.
They are not a claim that the entire process uses 8 MiB. Decoder, IPC, allocator
and rendering costs need installed-platform qualification separately.

Microsoft `mssql-tds` 0.4.0 buffers diagnostics before application drains. The
[local vendor patch](../../vendor/mssql-tds/COLLAB-PATCH.md) adds opt-in INFO/ERROR
bounds and removes SQL text from the two used execution tracing spans. Exhausted
diagnostics cause explicit truncation/failure and settlement or retirement. No
advisory is suppressed. The isolated Phase 0 comparison still uses the published
release, while production registry fixtures exercise the patched native adapter.

## Validation

Run the normal repository suites and the real disposable fixture harness:

```sh
cargo test -p collab database:: -- --test-threads=1
COLLAB_DB_SPIKE_ACCEPT_EULA=yes python scripts/database-driver-spike.py \
  --versions 2019 2022 2025 --skip-build --native-adapter \
  --output /tmp/database-phase2-evidence.json
```

Use `--native-only` with `--native-adapter` for focused production adapter runs.
Prebuild native tests first. The harness records only public image digests,
versions, assertions and numeric/boolean metrics; raw subprocess diagnostics and
credentials are withheld. Its Developer instances and credentials are disposable.

Automated/browser evidence and installed native acceptance remain separate.
Outstanding: packaged Windows/macOS/Linux/Flatpak, real keyring lifecycle,
suspend/reconnect networks, actual WebView IPC memory and responsiveness, and OS
save-picker acceptance. Integrated auth, Entra and per-connection CA import retain
their existing gates. Browser validation uses synthetic IPC, never a database proxy.

### Phase 2 implementation batch — 2026-11-10

- Full desktop/script suite: 2,542 passed, one skipped; two presentation tests
  timed out under concurrent Rust/container load. The affected presentation file
  then passed all 50 tests in isolation. The final saved-script regression file
  passed four tests, including copied-vault version isolation.
- TypeScript, admin tests (81), admin build, Android tests (258), desktop
  production bundle/budgets, lint (zero errors; 183 existing warnings), formatting,
  crate boundaries and version manifests passed.
- Rust workspace tests/checks passed. The final diagnostic-limit correction is
  also covered by production-adapter fixtures and a final workspace rerun.
- Chromium with synthetic IPC loaded 100,000 rows in 7,572 ms while mounting
  only 18 cells, with no page errors or body overflow. Exact decimal inspection,
  cancellation, schema completion and compact layout passed. See
  [browser evidence](../build/database-phase2-browser-evidence.json).
- CI-equivalent JavaScript security gate passed (three low and six moderate
  findings remain); Rust audit passed with the existing nine allowed warnings.
  No audit exception was added.
- Compose configuration passed. Server smoke remains unverified because the
  unchanged server image build failed on upstream Debian APT **Hash Sum mismatch**.

The browser run uses simulated IPC; it does not certify native WebView memory,
installed interaction, keyring behavior or save-picker integration.

The [21-report disposable SQL Server matrix](../build/database-phase2-evidence.json)
passed for 2019, 2022 and 2025. Each version ran both published driver comparisons
with verified, wrong-hostname and untrusted-CA TLS cases, plus the patched native
registry fixture. Native checks cover exact values, multi-batch session state,
source errors, transaction guards/rollback, cancellation with a server-side
observer, large-cell and 8 MiB result limits, bound table filters, INFO/ERROR
floods, killed sessions without replay, and retirement of stalled consumers.
These are real native driver tests against disposable servers, separate from the
Chromium synthetic-IPC responsiveness test.
