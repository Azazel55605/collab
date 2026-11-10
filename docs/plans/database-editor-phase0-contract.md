# Database Editor Phase 0 Contract

Status: **Implemented**, 2026-11-10. Phase 1 has not started. This freezes the
portable contract and records a real Linux driver spike; it does not make database
execution available in the desktop app. The [main tracker](./open-development-work.md)
owns delivery status. [Plan](./database-editor-plan.md).

## Scope And Driver Decision

The agreed first release targets SQL Server **2019, 2022 and 2025**, using **SQL
login**. Windows integrated authentication and Entra are separate investigations.
No server proxy, Android execution or browser execution is introduced.

Choose Microsoft's released **`mssql-tds` 0.4.0** for the Phase 1 native adapter,
subject to packaged-platform qualification below. Keep its concrete types out of
IPC and portable contracts. The comparison uses released **Tiberius 0.13.0**, not
an unreleased branch. Both dependencies remain in an isolated, locked spike
workspace; neither is added to the shipping desktop/server dependency graph.

| Real fixture check                                                                      | Tiberius 0.13.0                                      | mssql-tds 0.4.0                                               |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| Verified TLS, rejected wrong hostname and unknown CA                                    | Passed on all three versions                         | Passed on all three versions                                  |
| Exact bigint/decimal, NULL vs empty text, Unicode, binary, datetime2(7), datetimeoffset | Passed                                               | Passed                                                        |
| Multiple result sets, affected counts, ordinary error then next query                   | Passed                                               | Passed                                                        |
| Structured informational messages                                                       | Not exposed by public QueryItem stream               | Passed; message collection exposed                            |
| Explicit commit/rollback and independent temporary-table sessions                       | Passed                                               | Passed                                                        |
| Cancel WAITFOR before a write; observer proves request stopped and write absent         | Passed; retire connection after dropped query future | Passed; cooperative cancellation drains and preserves session |
| Killed connection detected; reconnect has new temporary-table state                     | Passed                                               | Passed with automatic connection recovery disabled            |
| Bounded prefix of a 2 MB large value without materializing the full cell                | Not qualified by this API path                       | Passed using PLP chunk reader, 64 KiB prefix                  |

Tiberius exposes an Attention/cancel API, but dropping a query future/stream does
not establish that a connection is reusable. The spike retires it. Microsoft's
cooperative cancel handle and chunked large-value reader fit this feature better.
Neither driver's ordinary row API alone proves bounded large-cell allocation.

`EncryptionSetting::Required` is selected explicitly with certificate validation;
Microsoft's default strict/TDS 8 mode would exclude SQL Server 2019. Tiberius uses
its TDS 7.3/native-TLS feature combination. The isolated test process supplies a
generated CA through `SSL_CERT_FILE`; **production must not change process-global
trust for a connection profile**. System roots are the initial production policy.
The released Microsoft API's server-certificate pin is not an additional CA store.
`AdditionalCa` remains unsupported until a per-connection trust implementation is
qualified. Any certificate exception requires an explicit, native-issued,
connection-scoped authorization; never silently disable verification.

One conversion trap was verified against real datetime2(7) and datetimeoffset
values: Microsoft's `SqlTime.time_nanoseconds` field contains **100 ns ticks**.
Multiply correctly when converting; preserve offset and fractional precision.
Driver names and internal field units never define the portable wire format.

## Executable Evidence And Budgets

Run [the fixture harness](../../scripts/database-driver-spike.py) as described in
[the spike README](../../tools/database-driver-spike/README.md). It creates only
owned disposable Developer containers, requires license acceptance, generates
short-lived TLS credentials, binds a random loopback port, and cleans up its own
containers and secrets. Reports contain fixed fixture checks and counters only.
[Recorded evidence](../build/database-phase0-evidence.json) pins image digests,
server builds, driver versions, host and run time.

Each positive case opens eight connections concurrently (initial connection plus
seven additional handshakes), tests cancellation of a 30-second WAITFOR after
300 ms, then consumes a 100,000-row/512-character workload through a deliberately
slow consumer. Polling stops at two outstanding frames. Admission stops at the
8 MiB result budget and the remaining server work is cancelled. This is a debug
host-process benchmark, not native WebView IPC or a release performance promise.

Recorded measurements across the three versions were 11–792 ms for the eight-sample
connection p95 (nearest-rank maximum), 303–308 ms from query start through cancel,
14,464 rows retained before the byte cap, and 148,440 peak outstanding encoded
bytes. Linux process high-water RSS was about 17–21 MiB. The recorded JSON contains
each case's exact values; timings vary with fixture startup and host load.

| Boundary                    | Initial admission policy                        | Evidence / remaining validation                                                                               |
| --------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Native physical connections | 8 across query, metadata and apply sessions     | Eight-connection real fixture burst; later add idle eviction and platform budgets                             |
| SQL / parameter payload     | 1 MiB each, at most 1,024 parameters            | Contract admission bound; native ingress must reject before unbounded parsing                                 |
| Result columns / cell       | 256 / 64 KiB encoded                            | Admission tests; Microsoft streaming prefix tested; unsupported cell formats must stop or truncate explicitly |
| Frame rows / bytes          | 128 / 256 KiB encoded                           | Real slow-consumer path; serialized escaping counts toward bytes                                              |
| Outstanding frames          | 2, at most 512 KiB encoded                      | Credit/ack contract and measured real driver collector                                                        |
| Entire result               | 100,000 rows / 8 MiB encoded across result sets | Real workload hits byte cap; reserve completion space; no hidden unbounded result cache                       |
| Metadata                    | 4 MiB per refresh                               | Policy bound; Phase 1 must paginate/cache within it                                                           |
| Session history             | 100 entries / 1 MiB                             | Policy bound; session-memory only by default                                                                  |

Encoded limits include event envelopes. Cell/frame/result budgets apply before
IPC dispatch; a post-allocation size check alone cannot bound native driver
allocation. Chunked PLP decoding must stop at the cell cap. Driver buffering,
WebView copies, queues, export and rendering need independent Phase 2 measurement.
Messages, metadata and completion events use the same ordered credit window as
rows. No unbounded side channel for PRINT/messages is allowed. A terminal event
must be delivered after truncation, not silently discarded at the result cap.

## Portable Contract And Native Authority

`crates/collab-database` owns contract version 1: engine capabilities, connection
metadata without secrets, typed values, identifiers, schema snapshots, row
locators/mutations, session transitions, safe error codes, result frames and
bounded admission. It depends only on serialization/error libraries. The boundary
policy bans concrete drivers and persistence frameworks from this domain crate.

Phase 1's native adapter owns sockets, driver clients, credentials, certificate
validation, selected-file handles, cancellation and authorization. A native
registry issues unguessable connection/session/query handles and checks active
profile ownership on every command. A deserialized binding or metadata snapshot
is never an authority grant. Frontend wrappers go through `src/lib/tauri.ts`.
Database work stays independent of vault availability and the collaboration server.

Capabilities are dialect baselines intersected with actual server version,
permissions and storage-engine/table properties. Unknown support stays disabled.
MariaDB RETURNING and transactional DDL differ from SQL Server/SQLite; a generic
boolean is not permission to generate unsupported SQL. No follow-on driver is
selected or shipped in Phase 0.

Typed values distinguish NULL, empty text, defaults, exact integer/decimal strings,
floats with width, text, binary, dates/times with precision/offset, UUID, unsupported
values and explicit truncation. Never route bigint/decimal through JavaScript
Number. Portable parameter checks reject malformed exact numbers, nonfinite floats
and truncated/opaque input; adapters still validate temporal/UUID/base64 grammar,
engine ranges and actual target column types. No raw SQL interpolation of values.
Identifiers are validated and quoted per dialect; qualified names are separate
components, and parameters use engine-specific markers.

Errors expose stable safe codes, optional numeric server code and UTF-16 source
range, plus an unknown-outcome flag. Backend strings can contain SQL and secrets:
never forward them wholesale. Server messages are capped display data, redacted
from diagnostic logging; they are not trusted markup or instructions. Debug
formatting redacts query text, parameters, result values and message payloads.

## Sessions, Cancellation And Editing

A tab pins profile, connection, session, database and generation. Each query has
an independent identifier. Switching the sidebar cannot retarget it; stale cancel,
acknowledgement or completion cannot affect another execution. Metadata uses
separate sessions. Raw SQL is always potentially writing, even if it starts with
SELECT. A database-changing statement requires reconciling observed server context
before further execution, never silently retaining an incorrect database badge.

Transitions distinguish connecting, idle, executing, cancelling, failed,
unknown outcome and closed. Transaction state is separate: none/open/failed/unknown.
Cancellation is complete only after protocol drain plus observed transaction
state, or retirement of the physical connection. A timeout while draining retires
it. Disable transparent reconnect/replay: transport loss during arbitrary SQL or
an open transaction means unknown outcome, with no automatic retry. A reconnect
is a new session and loses temporary tables/settings/transactions.

Closing or switching profiles must explicitly resolve active work, pending edits
and open/unknown transactions. Never auto-commit on close. Failed transactions
need a native rollback/resolution path; they cannot become silently executable.
The portable state machine models these restrictions; the app registry and UI are
Phase 1/2 work.

Grid Apply uses a dedicated native-owned session/transaction, never a query tab's
manual transaction. Eligible rows need an identified base table, transactional
storage and a proven unique non-null key, plus a version token or full supported
original-value predicate. Views, joins, keyless/ambiguous rows and truncated original
values remain read-only. Metadata stamps detect schema changes before Apply.
Native code reconstructs locators from its own loaded snapshot. Parameters carry
values; validated identifiers carry names. Inserts distinguish DEFAULT from NULL;
generated columns and duplicate edited columns are rejected. Every update/delete
must affect exactly one row; conflicts or any error roll back the entire batch.
These are contracts and validation only; no mutation executor is shipped here.

## History, Credentials And Selected Files

History starts in bounded session memory, isolated by application profile and
connection. No SQL, literals, results or history sync to vaults/server, telemetry,
crash logs or plaintext persistent storage. Persistent history is deferred until
an explicit protected local storage/retention design. Saved `.sql` text can use
normal vault APIs, but opening a script never connects or executes it.

Credentials remain native, keyed under a distinct database namespace such as
`collab-database-v1` plus application-profile/connection identifiers. Default to
session-only retention; durable storage is an explicit OS credential-store choice.
Linux kernel keyutils is not durable across reboots. Secret Service can prompt or
be unavailable/locked; those states require actionable native errors, no plaintext
fallback and no assumption that login unlocked a keyring. Windows Credential
Manager and macOS Keychain require installed-platform checks.

SQLite uses picker-issued opaque native handles, not frontend filesystem paths or
vault-relative IPC paths. The native registry scopes authority to the selected
file and permitted sidecars/parent directory. WAL/SHM access needs explicit parent
authority or a supported consistent backup/snapshot workflow. Never byte-copy a
live WAL database, upload it as an ordinary live vault file, or leave a decrypted
database in an encrypted vault. Read-only mode, missing/replaced files and revoked
picker grants must fail safely. SQLite adapter details are Phase 4 work.

## Platform Qualification Matrix

| Platform / mode              | Phase 0 evidence                                                                  | Required before support claims                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Linux x86_64 host, SQL login | Real Docker SQL Server 2019/2022/2025, verified TLS and both negative trust cases | Installed desktop adapter, UI/IPC memory, suspend/network loss and OS credential lifecycle          |
| Windows native, SQL login    | Contract/source review only                                                       | Packaged driver/linking, roots, connect/cancel/drain/reconnect, Keyring and app-profile isolation   |
| macOS native, SQL login      | Contract/source review only                                                       | Same native checks, signing/linking and Keychain lifecycle                                          |
| Flatpak                      | Manifest reviewed                                                                 | Packaged OpenSSL/root discovery, networking, Secret Service and selected-file/sidecar proof         |
| Integrated authentication    | Tiberius SSPI/GSSAPI and Microsoft integrated-auth feature assessed               | Disposable domain/Kerberos fixtures per OS; identity, SPN, ticket expiry and packaging dependencies |
| Entra                        | Token-supplied authentication assessed separately                                 | Approved acquisition/refresh/cache flow, tenant policy, token expiry and real endpoint fixtures     |

The isolated Microsoft build disables default platform-specific auth/TLS features;
this host run exercises Linux native TLS/OpenSSL. Windows Schannel and macOS
Network.framework/default feature builds have not been qualified. Linux SQL Server
containers do not qualify Windows-hosted server environments or production networks.

The current Flatpak manifest already grants network and broad home access, but
has no `org.freedesktop.secrets` talk permission. Do not claim durable credentials
work inside it. Phase 1 must justify and test a narrowly scoped Secret Service
permission or expose session-only storage there. Existing broad home access does
not establish picker authority, portal persistence or WAL/SHM behavior. Phase 0
changes no sandbox permissions and adds no file or credential fallback.

## Sources

- [Microsoft mssql-rs](https://github.com/microsoft/mssql-rs), released crate `mssql-tds` 0.4.0 and its public cancellation, TLS and streaming APIs.
- [Tiberius](https://github.com/tiberius-rs/tiberius), released crate 0.13.0 and its cancellation/QueryItem APIs.
- [SQL Server container deployment](https://learn.microsoft.com/en-us/sql/linux/quickstart-install-connect-docker).
- [Integrated authentication on Linux/macOS](https://learn.microsoft.com/en-us/sql/connect/odbc/linux-mac/using-integrated-authentication).

The locked spike and executable assertions establish the tested behavior. Platform
and authentication rows marked pending are acceptance work, not inferred passes.

## Batch Validation

- Real Linux driver matrix: **18/18 cases passed** across three SQL Server versions,
  two released drivers and three TLS cases. Owned containers were removed.
- Workspace Rust tests/checks passed, including 11 database contract regressions;
  the final safe-error additions were rechecked in the crate and workspace check.
  The isolated locked spike build passed.
- Desktop suite: 383 files passed, one skipped, with two ink timing assertions
  failing during concurrent compilation/container work. The affected ink file then
  passed all 10 tests in isolation without changing its budgets or implementation.
- TypeScript, admin tests (81), admin build and mobile tests (258) passed.
- Crate boundaries, version alignment, formatting and lint passed (existing lint
  warnings remain). Python syntax and the pre-Docker license guard passed.
- The spike dependency audit reported no vulnerabilities. The workspace audit
  completed with its existing nine allowed warnings; advisory policy is unchanged.
- Compose configuration passed. Server smoke was attempted twice; the unchanged
  server image build failed on external APT index **Hash Sum mismatch**, so server
  smoke is **not verified** by this batch. No server implementation changed.

This evidence does not close installed Windows/macOS/Linux, Flatpak credential or
selected-file acceptance, actual WebView IPC measurements, integrated auth or Entra.
