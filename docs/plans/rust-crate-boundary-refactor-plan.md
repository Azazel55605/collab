# Rust Crate Boundary Refactor Plan

## Summary

Refactor Collab's Rust workspace into narrower, testable domain crates without
changing product behavior, storage formats, REST routes, Tauri command
signatures, or supported document schemas.

The existing `collab-calendar`, `collab-circuit`, `collab-protocol`, and
`collab-replica` crates demonstrate the intended direction: reusable domain
logic lives outside platform adapters, while `collab-server` and `src-tauri`
retain PostgreSQL, Axum, Tauri, operating-system, and process-lifecycle code.

This plan adds four primary shared boundaries:

- `collab-net-policy`: outbound URL, target, redirect, and response-limit policy.
- `collab-documents`: portable structured-document parsing, validation,
  reference analysis, and rewrite rules.
- `collab-vault-domain`: canonical vault/file/revision/manifest mutation rules.
- `collab-live`: transport-independent Yrs document state, update, compaction,
  and materialization rules.

It also adds `collab-archive` as a focused archive-planning boundary shared by
hosted ZIP/backup workflows and native vault exports.

## Motivation

The current workspace has good initial domain boundaries, but several adapter
modules have become broad ownership buckets:

- `crates/collab-server/src/api.rs` contains authentication, users, vaults,
  memberships, files, revisions, snapshots, search, import/export, backups, and
  administration.
- `crates/collab-server/src/ws.rs` combines transport, room lifecycle, Yrs
  manipulation, persistence coordination, and recovery behavior.
- `src-tauri/src/commands/files.rs` combines file operations, trash, PDF
  sidecars, reference rewrites, imports, downloads, and local tree building.
- `src-tauri/src/commands/web.rs` and
  `crates/collab-server/src/calendar_feeds.rs` implement closely related
  outbound-network hardening.
- `collab-core` mixes true low-level primitives with document-specific Kanban,
  PDF, and reference behavior.

Moving files without first separating these responsibilities would produce
crates with unstable APIs and hidden adapter dependencies. The refactor must
therefore begin with characterization and internal module boundaries.

## Goals

- Make ownership boundaries obvious from crate dependencies.
- Share security-sensitive and format-sensitive rules between server and native
  clients.
- Keep Tauri, Axum, SQLx, PostgreSQL, filesystem watchers, and OS integration at
  adapter edges.
- Reduce the size and responsibility of the largest server and Tauri modules.
- Allow domain crates to run fast unit and property tests without application
  runtimes.
- Prevent `collab-core` from becoming an unrestricted shared-code bucket.
- Preserve all existing external contracts during extraction.

## Non-Goals

- No product features or UI redesigns are part of this work.
- No REST route, WebSocket wire, Tauri IPC, database, replica, or document-schema
  migration should be required solely by this refactor.
- The frontend TypeScript workspace is not being split into packages here.
- Authentication, credential storage, OCR, templates, and updater code are not
  new shared crates unless later evidence shows multiple real consumers.
- This plan does not publish internal crates independently to crates.io.
- This plan does not require one crate per server module.

## Extraction Criteria

Create or expand a shared crate only when all of these are true:

1. At least two adapters or applications need the same behavior.
2. The behavior has a coherent domain contract and independent tests.
3. The crate can avoid Tauri, Axum, SQLx, PostgreSQL, and concrete storage
   backends.
4. Its dependency direction does not create a cycle.
5. Moving it removes meaningful duplication or adapter-owned domain logic.

Otherwise, use an internal module inside the owning application crate.

## Target Workspace

```text
collab-core
  low-level paths, names, hashing, and content-encryption primitives

collab-protocol
  REST/WebSocket envelopes and stable wire DTOs

collab-net-policy
  outbound target and bounded-response policy

collab-documents
  document parsing, validation, references, and rewrites

collab-vault-domain
  file tree, revision, manifest, tombstone, and mutation planning

collab-archive
  bounded archive validation and materialization planning

collab-live
  transport-independent Yrs state, updates, compaction, and materialization

collab-replica
  native offline persistence and pending-operation storage

collab-calendar
  calendar model, local store, recurrence, and iCalendar

collab-circuit
  circuit model, compiler, and simulation

collab-server
  Axum, PostgreSQL, blob storage, jobs, and server lifecycle adapters

src-tauri
  Tauri IPC, local filesystem, OS services, and native transport adapters
```

Target dependency direction:

```text
collab-core         -> no application crates
collab-protocol     -> no application crates
collab-net-policy   -> low-level third-party libraries only
collab-documents    -> collab-core
collab-vault-domain -> collab-core + collab-documents
collab-archive      -> collab-core + collab-vault-domain
collab-live         -> collab-documents + collab-protocol
collab-replica      -> collab-core + collab-protocol
                       + collab-vault-domain when its mutation rules migrate
collab-calendar     -> independent domain sibling
collab-circuit      -> independent domain sibling
collab-server       -> shared crates as needed
src-tauri           -> shared crates as needed
```

Each arrow means “depends on.” Shared crates must never depend on
`collab-server` or `src-tauri`.

The exact edge between `collab-documents` and `collab-vault-domain` must be
validated during Phase 0. Document parsing should not need vault persistence;
vault mutation planning may call document reference rules through explicit
inputs.

## Boundary Definitions

### `collab-net-policy`

Own:

- URL scheme and credential rules.
- Host and port normalization.
- Private, loopback, link-local, multicast, documentation, and reserved address
  classification.
- DNS-result validation and rebinding-safe target selection.
- Redirect count and cross-origin sensitive-header policy.
- Response byte, line, and timeout policy types.
- Deterministic policy errors suitable for adapter translation.

Do not own:

- `reqwest::Client` lifecycle or actual requests.
- Tauri/server session credentials.
- HTML parsing or iCalendar parsing.
- Application-specific error envelopes.

Initial consumers:

- Native link previews and calendar subscriptions.
- Server-hosted calendar subscription feeds.
- Future location/map and webhook adapters where applicable.

### `collab-documents`

Own:

- Note, Kanban, canvas, logic, SVG, and PDF-sidecar document-kind
  classification where Rust needs it.
- Portable structured-document validation and normalization.
- Reference discovery and rewrite planning.
- Kanban semantic capability analysis and calendar projection inputs.
- PDF annotation semantic-diff rules that are independent of persistence.
- Bounded parser limits and source-mapped format errors.

Initial moves from `collab-core`:

- `references.rs`
- `kanban.rs`
- `pdf.rs`

Keep in `collab-core`:

- path and portable-name normalization
- hashing
- byte-level encryption primitives

Do not own:

- Filesystem traversal.
- PostgreSQL queries.
- Tauri commands.
- UI-oriented TypeScript rendering models.

### `collab-vault-domain`

Own:

- Canonical file/folder identity and parent-child invariants.
- Revision preconditions and optimistic mutation decisions.
- Manifest sequence and delta semantics.
- Trash/tombstone state transitions.
- Move, rename, restore, purge, and reference-rewrite plans.
- Mutation idempotency keys and conflict classification.
- Capability requirements expressed as domain requirements, not database
  queries.
- Storage/quota delta calculations over supplied metadata.

Do not own:

- PostgreSQL transactions.
- Local filesystem operations.
- Blob reads/writes.
- Authentication sessions.
- HTTP or Tauri response types.

Adapters execute a validated plan transactionally and translate persistence
rows into domain inputs.

### `collab-archive`

Own:

- Safe archive-entry path normalization.
- Duplicate/path-conflict detection.
- Expanded-size and entry-count budgeting.
- Import tree construction.
- Export materialization plans.
- Portable archive manifest validation.

Keep concrete ZIP streaming and storage IO in adapters unless both server and
Tauri genuinely share it.

### `collab-live`

Own:

- Stable live-document message/state DTOs not already in `collab-protocol`.
- Yrs document seeding for supported text and structured documents.
- State-vector/update application and duplicate handling.
- Compaction and recovery decisions.
- Structured JSON-to-Yrs and Yrs-to-JSON conversion.
- Materialization guards that compare supplied revision markers.
- Bounded update/message validation.

Do not own:

- Axum WebSocket upgrades.
- Native WebSocket clients.
- Authentication or vault authorization.
- PostgreSQL/blob persistence.
- Room scheduling and process-global registries.

The server room and native transport adapters remain responsible for
authorization, connection lifecycle, persistence calls, and user-facing events.

## Adapter Modularization

Before extracting shared crates, split oversized adapter files without changing
their public routes or command registration.

Target server modules:

```text
collab-server/src/
  auth_api.rs
  user_api.rs
  vault_api.rs
  membership_api.rs
  document_api.rs
  transfer_api.rs
  admin_api.rs
  backup_api.rs
  live_api.rs
```

Target Tauri command modules:

```text
src-tauri/src/commands/
  files/
    mod.rs
    trash.rs
    sidecars.rs
    imports.rs
    downloads.rs
    references.rs
    tree.rs
```

Shared private helpers should move into named internal modules rather than
remaining in one API file or being prematurely made public.

## Progress Tracker

| Phase | Status | Goal |
| --- | --- | --- |
| 0. Baseline and dependency design | Complete | Baselines, consumer maps, draft contracts, dependency enforcement, characterization tests, and initial internal adapter ownership modules are in place. |
| 1. Outbound network policy | Complete | `collab-net-policy` now owns shared URL, resolved-target, redirect, sensitive-header, response-budget, and timeout policy used by native and server adapters. |
| 2. Document domain | Complete | `collab-documents` owns bounded document classification/validation, references, Kanban semantics, PDF semantics, and shared canvas inspection across native and server adapters. |
| 3. Vault mutation domain | Complete | `collab-vault-domain` owns portable file/revision/manifest/trash mutation planning behind stable inputs and is consumed by hosted, local, and replica adapters. |
| 4. Archive boundary | Complete | `collab-archive` owns portable entry validation, budgets, import-tree construction, export materialization, and manifest checks for server and native adapters. |
| 5. Live document domain | Complete | `collab-live` owns bounded Yrs updates/replay, state exchange, compaction, document conversion, recovery, merge, and materialization decisions. |
| 6. Enforcement and cleanup | Not started | Remove compatibility re-exports, enforce dependency rules, update docs, and complete cross-platform regression validation. |

## Phase 0: Baseline And Dependency Design

Estimated effort: 1-2 weeks.

Tasks:

- [x] Capture module-size, dependency, and compile-time baselines.
- [x] Inventory duplicated behavior and every current consumer.
- [x] Add characterization tests around security, references, archive validation,
  revision transitions, and live recovery.
- [x] Define domain input/output types before moving implementations.
- [x] Split `collab-server/src/api.rs`, `ws.rs`, and Tauri file commands into
  internal modules while preserving exported handlers.
- [x] Add an architecture dependency check script based on `cargo metadata`.
- [x] Record allowed crate edges and prohibited framework dependencies.

Acceptance criteria:

- Existing REST routes, WebSocket messages, Tauri commands, migrations, and file
  formats are unchanged.
- The largest adapter files have coherent internal ownership modules.
- Each proposed crate has a documented consumer map and draft public API.
- Characterization tests pass before extraction begins.

Implementation:

- Recorded clean/incremental compile timings, module sizes, the current workspace
  graph, duplicate behavior, consumers, and draft APIs in the
  [Phase 0 Baseline](./rust-crate-boundary-phase0-baseline.md).
- Added `pnpm rust:boundaries` and a focused CI workflow. The check rejects
  undeclared workspace edges, unregistered crates, adapter frameworks in domain
  crates, and persistence frameworks outside the documented calendar-store
  exception.
- Moved hosted vault archive validation/planning into private
  `api/archive.rs`, live text merge and structured-Yrs behavior into private
  `ws/domain.rs`, and native image/PDF/preview sidecars into private
  `commands/files/sidecars.rs`.
- Added focused characterization tests for archive normalization/conflicts/
  budgets, independent versus overlapping live text edits, JSON/Yrs round trips,
  invalid update rejection, sidecar path privacy, and sidecar compatibility.
  Existing integration suites continue to cover references, revision
  transitions, security boundaries, and live recovery.
- No REST route, WebSocket message, Tauri command name, migration, persisted
  file, or document schema changed. Phase 1 can now extract outbound policy
  against an enforced dependency direction.

## Phase 1: Outbound Network Policy

Estimated effort: 1 week.

Tasks:

- [x] Create `crates/collab-net-policy`.
- [x] Move IP classification, URL validation, redirect decisions, target
  revalidation, and response budgets into pure policy functions.
- [x] Keep request execution in native and server adapters.
- [x] Add IPv4/IPv6, DNS rebinding, redirect-origin, credential, malformed URL,
  response-size, and timeout fixtures.
- [x] Replace duplicated policy code in native link/calendar fetching and server
  calendar feeds.

Acceptance criteria:

- Native and server requests make identical allow/deny decisions for the same
  policy profile.
- No request target is used before its resolved addresses pass policy.
- Cross-origin redirects cannot forward sensitive conditional or credential
  headers.
- Existing link preview and calendar subscription behavior remains green.

Implementation:

- Added the IO-free `collab-net-policy` crate with named web-preview and
  HTTPS-calendar-feed profiles, deterministic policy errors, URL/host
  validation, comprehensive reserved-address classification, all-address DNS
  validation, bounded redirect resolution, cross-origin conditional-header
  stripping, and streaming response budgets.
- Native link previews and calendar subscriptions plus hosted calendar feed
  refresh now use those profiles. Each adapter still owns DNS lookup,
  `reqwest::Client` construction, pinned-address request execution, response
  streaming, and application-specific error text.
- Target syntax is validated before DNS, every returned address must pass the
  shared classifier before a pinned request client is built, and each redirect
  repeats the same process. Mixed public/private DNS answers are rejected.
- The architecture check now rejects HTTP/WebSocket execution frameworks in
  domain crates in addition to Tauri, Axum, and persistence frameworks.
- Shared fixtures cover IPv4, IPv6, IPv4-mapped IPv6, malformed and local URLs,
  credentials, mixed DNS answers, redirect revalidation and bounds, origin
  changes, advertised/streamed response sizes, integer overflow, and the exact
  timeout/size profiles.

## Phase 2: Document Domain

Estimated effort: 2-3 weeks.

Tasks:

- [x] Create `crates/collab-documents`.
- [x] Move `references`, `kanban`, and `pdf` modules out of `collab-core`.
- [x] Introduce explicit document-kind and parser-limit types.
- [x] Move portable semantic validation currently embedded in server/Tauri handlers.
- [x] Keep temporary re-exports from `collab-core` for one migration phase.
- [x] Migrate server, Tauri, replica, and tests to direct imports.
- [x] Remove re-exports after all consumers move.

Acceptance criteria:

- `collab-core` contains only cross-domain primitives.
- Server and Tauri use one reference/rewriting implementation.
- Document logic has no Axum, Tauri, SQLx, filesystem, or network dependency.
- Existing note, Kanban, canvas, PDF, and hosted-reference tests remain green.

Implementation:

- Added framework-free `collab-documents`, depending only on `collab-core` plus
  parser/serialization libraries. It owns `DocumentKind`, `ParserLimits`,
  bounded JSON/XML/UTF-8 validation, generic reference query/rewrite contracts,
  canvas node inspection, Kanban capability classification, and PDF annotation
  capability classification.
- Moved all 1,627 lines of reference, Kanban, and PDF behavior and their
  characterization tests out of `collab-core`. Native and server consumers now
  import `collab-documents` directly; compatibility exports were removed after
  the migration compiled. The replica had no imports from these modules and
  correctly retains no document-domain dependency.
- Local durable document writes validate classified note, Kanban, canvas,
  logic, and SVG content before disk persistence. Hosted document creation,
  REST revisions, PDF annotation state, and live note/Kanban/canvas
  materialization validate through the same bounded API before persistence.
- Hosted ZIP classification and local allowed-document extension checks use the
  shared path classifier. Live canvas integrity checks use the shared canvas
  inspection helper rather than a server-private JSON parser.
- No REST route, WebSocket message, Tauri command, protocol enum, migration, or
  persisted document schema changed.

## Phase 3: Vault Mutation Domain

Estimated effort: 3-4 weeks.

Tasks:

- Create `crates/collab-vault-domain`.
- Define canonical metadata snapshots and mutation request/plan/result types.
- Extract revision, manifest, tombstone, rename/move, restore, purge, quota,
  reference-impact, and idempotency decisions.
- Adapt PostgreSQL and local-filesystem paths to execute domain plans.
- Reuse the same conflict classes in `collab-protocol` responses and replica
  recovery where appropriate.
- Keep authorization lookup in adapters; pass resolved capabilities into the
  domain.

Acceptance criteria:

- Equivalent local and hosted mutations share invariant tests.
- Domain plans are deterministic and contain no persistence handles.
- Server mutations still commit revisions, manifests, activity, and rewrites in
  one PostgreSQL transaction.
- Local vault behavior, trash semantics, optimistic writes, and hosted replica
  replay remain unchanged.

Completion notes:

- `crates/collab-vault-domain` now defines canonical entry/vault snapshots,
  capability-resolved mutation requests, deterministic plans, metadata and
  reference intents, path-change classification, state transitions, optimistic
  sequence checks, content-addressed quota deltas, and typed conflict codes.
- Hosted structural validation, manifest/revision preconditions, and storage
  quota enforcement consume the shared decisions while preserving the existing
  PostgreSQL transaction that commits metadata, revisions, activity, and
  reference rewrites atomically.
- Local rename/move preview and execution plus trash/restore/purge state
  transitions use the same portable path and state rules; filesystem and
  sidecar operations remain in the Tauri adapter.
- Replica recovery maps persisted machine-readable failure codes to
  `VaultDomainError` without parsing server message text. Existing replica
  storage and frontend wire shapes remain compatible.
- Domain invariant tests cover rename/move, descendant and path conflicts,
  state transitions, manifest/revision/idempotency conflicts, quota
  deduplication, and deterministic descendant remapping.

## Phase 4: Archive Boundary

Estimated effort: 1-2 weeks.

Tasks:

- [x] Compare server ZIP import/export, backup archives, local vault exports, folder
  downloads, and drag/download materialization.
- [x] Extract only common validation and planning behavior.
- [x] Preserve streaming and backend-specific storage behavior.
- [x] Decide, with recorded evidence, between a dedicated `collab-archive` crate and
  a `collab-vault-domain::archive` module.
- [x] Add traversal, separator, duplicate, zip-bomb, entry-count, total-size,
  symlink, and malformed-manifest fixtures.

Acceptance criteria:

- All archive entry paths pass one portable validator.
- Expanded-size and entry-count budgets are applied before commit.
- Server and native archive workflows retain their existing limits and output.
- No new crate is created if the resulting boundary has only one real consumer.

Completion notes:

- A dedicated `collab-archive` crate is justified by four independent adapter
  paths: hosted vault ZIP import, hosted vault/folder ZIP export, server backup
  TAR validation, and native local-vault ZIP export. Drag/download
  materialization does not construct archives and remains outside this boundary.
- The crate consumes entry metadata and returns deterministic import/export
  plans. It owns portable path and separator rules, case-insensitive duplicate
  and file/folder conflict detection, implicit import folders, symlink and
  unsupported-entry rejection, entry/per-file/expanded-size budgets,
  single-root backup validation, and manifest-version checks.
- ZIP/TAR decoding, decompression, streaming, blob reads, filesystem traversal,
  PostgreSQL transactions, and output writing remain in server and Tauri
  adapters. Hosted ZIP imports additionally verify actual decompressed byte
  counts before committing.
- Hosted ZIP imports retain the 1,000-entry, per-file, and expanded-size limits;
  backup imports now apply the configured expanded-size limit before extraction.
  Native exports retain `.collab` metadata while excluding runtime presence
  files.
- Fixtures cover traversal and absolute paths, Windows separator policy,
  normalized duplicates, file/folder conflicts, symlinks, unsupported entry
  kinds, per-entry/entry-count/expanded-size bounds, deterministic folder
  rebasing, single backup roots, and missing/unsupported manifest versions.

## Phase 5: Live Document Domain

Estimated effort: 3-4 weeks.

Tasks:

- [x] Stabilize live message DTOs in `collab-protocol`.
- [x] Create `crates/collab-live`.
- [x] Extract Yrs seed/update/state-vector/compaction and structured JSON conversion.
- [x] Extract recovery and materialization-decision logic behind persistence-neutral
  inputs.
- [x] Keep server room registries and native WebSocket transport in their adapters.
- [x] Add convergence, duplicate update, compaction, stale materialization,
  structured-document, cancellation, and bounded-message fixtures.

Acceptance criteria:

- `collab-live` can be tested without a socket, database, Tauri runtime, or
  server process.
- Server and native code do not fork Yrs conversion or diagnostic semantics.
- Existing live REST/WS integration, offline replay, viewer authorization, and
  recovery tests remain green.
- No transport credential enters the shared live crate.

Completion notes:

- Added framework-free `collab-live`, depending only on `collab-documents`,
  `collab-protocol`, serialization libraries, and `yrs`. It owns the stable
  `content`/`doc` root names, document-kind mapping, bounded update validation
  and replay, state vectors and diffs, compact state encoding, note and
  structured JSON seeding/replacement/materialization, text merge, revision
  comparison, and recovery/materialization decisions.
- The server room adapter now uses `collab-live` for all production Yrs
  manipulation. Axum sockets, authorization, room locks, awareness lifecycle,
  SQL sequence allocation, update-log transactions, blob persistence,
  debouncing, and broadcasts remain in `collab-server`.
- The native replica IPC validates encoded CRDT states through the same bounded
  update contract before encrypted cache persistence. The TypeScript Yjs
  provider still owns browser document bindings and network orchestration; the
  native WebSocket command remains an opaque authenticated transport proxy.
- Existing `collab-protocol` control DTOs, protocol version, binary tags, and
  serialization tests remain the wire source of truth; no REST, WebSocket,
  Tauri IPC, database, replica, or document format changed.
- Shared fixtures cover convergence, duplicate idempotency, nested structured
  JSON, invalid and oversized updates, replay count/byte bounds, cancellation,
  note/canvas recovery, node-loss prevention, stale markers, deterministic text
  merge, and compaction. The server live integration suite continues to cover
  offline replay, authorization, awareness, materialization, compaction,
  recovery, protocol mismatch, and REST/live concurrency.

## Phase 6: Enforcement And Cleanup

Estimated effort: 1 week.

Tasks:

- Remove temporary compatibility modules and obsolete helpers.
- Add CI checks for prohibited crate dependencies.
- Run unused-dependency and duplicate-dependency reviews.
- Document every final crate in the codebase and server workspace references.
- Update `AGENTS.md` and `CLAUDE.md` with final ownership rules.
- Record compile-time and module-size changes against the Phase 0 baseline.

Acceptance criteria:

- `cargo metadata` matches the documented dependency graph.
- Shared crates contain no adapter framework dependencies.
- No duplicated security, reference, vault-invariant, archive-policy, or Yrs
  conversion implementation remains in server and Tauri adapters.
- Full desktop, Android, server, Compose, migration, and live-collaboration
  verification passes.

## Migration Rules

- Extract one boundary at a time; do not combine a crate move with a product
  feature.
- Add characterization coverage before moving behavior.
- Prefer mechanical moves followed by focused cleanup in separate commits.
- Preserve public function behavior through temporary re-exports where needed.
- Do not change serialized enum tags, field names, error codes, route paths,
  command names, migration checksums, or document schema versions during moves.
- Keep database transaction boundaries in the server adapter.
- Keep filesystem mutation ordering and watcher suppression in the Tauri
  adapter.
- Translate shared domain errors explicitly at adapter boundaries.
- Delete the old implementation in the same phase that migrates the final
  consumer.

## Verification

Every phase:

```bash
cargo test --workspace
cargo check --workspace
pnpm exec tsc --noEmit
git diff --check
```

Affected phases also require:

- Focused unit/property tests for the extracted crate.
- Existing Tauri backend tests for local-vault behavior.
- Authenticated PostgreSQL integration tests for hosted behavior.
- REST and WebSocket protocol tests where wire boundaries are touched.
- `docker compose up --build --wait` and `./scripts/server-smoke.sh` for server
  adapter changes.
- Android frontend/native checks when shared native commands or replica behavior
  changes.
- Migration checksum and upgrade tests when code reads persisted state, even
  though this refactor should not create schema migrations.

## Risks And Mitigations

### Accidental behavior changes during moves

Mitigation: characterization tests, mechanical extraction commits, compatibility
re-exports, and no feature work in extraction changes.

### Circular dependencies

Mitigation: shared crates exchange plain data; adapters own orchestration.
`collab-protocol` contains wire contracts, while domain crates contain behavior.

### A new dumping-ground crate

Mitigation: enforce the extraction criteria and keep `collab-core` limited to
low-level primitives. A module with one consumer does not qualify as a crate.

### Leaking adapter concerns into shared code

Mitigation: prohibit Tauri, Axum, SQLx, concrete blob stores, and platform APIs
from shared domain manifests through CI dependency checks.

### Compile-time growth

Mitigation: keep heavy dependencies at adapter edges, avoid broad default
features, measure clean and incremental builds in Phase 0 and Phase 6, and do
not duplicate dependency stacks across crates.

## Completion Definition

This plan is complete when the target boundaries are implemented or explicitly
rejected with recorded evidence, oversized adapters have coherent ownership,
the dependency graph is enforced, all compatibility shims are removed, and the
full cross-platform verification matrix passes without external contract or
storage-format regressions.
