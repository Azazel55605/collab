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

It also evaluates `collab-archive` as a focused archive-planning boundary after
the vault domain has stabilized.

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
  optional bounded archive validation and materialization planning

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
collab-archive      -> collab-core + collab-vault-domain, if extracted
collab-live         -> collab-core + collab-documents + collab-protocol
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

Evaluate as a separate crate after `collab-vault-domain` exists.

Own when extraction proves useful:

- Safe archive-entry path normalization.
- Duplicate/path-conflict detection.
- Expanded-size and entry-count budgeting.
- Import tree construction.
- Export materialization plans.
- Portable archive manifest validation.

Keep concrete ZIP streaming and storage IO in adapters unless both server and
Tauri genuinely share it.

If the resulting API is small or used only by vault code, retain it as a
`collab-vault-domain::archive` module instead of creating another crate.

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
| 1. Outbound network policy | Not started | Add `collab-net-policy` and migrate native/server URL, target, redirect, and response-limit rules. |
| 2. Document domain | Not started | Add `collab-documents`, move document-specific logic out of `collab-core`, and migrate both adapters. |
| 3. Vault mutation domain | Not started | Add `collab-vault-domain` and move portable file/revision/manifest/trash mutation planning behind stable inputs. |
| 4. Archive boundary | Not started | Consolidate bounded import/export planning in `collab-archive` or a vault-domain module based on measured reuse. |
| 5. Live document domain | Not started | Add `collab-live` for Yrs conversion, updates, compaction, recovery, and materialization guards. |
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

- Create `crates/collab-net-policy`.
- Move IP classification, URL validation, redirect decisions, target
  revalidation, and response budgets into pure policy functions.
- Keep request execution in native and server adapters.
- Add IPv4/IPv6, DNS rebinding, redirect-origin, credential, malformed URL,
  response-size, and timeout fixtures.
- Replace duplicated policy code in native link/calendar fetching and server
  calendar feeds.

Acceptance criteria:

- Native and server requests make identical allow/deny decisions for the same
  policy profile.
- No request target is used before its resolved addresses pass policy.
- Cross-origin redirects cannot forward sensitive conditional or credential
  headers.
- Existing link preview and calendar subscription behavior remains green.

## Phase 2: Document Domain

Estimated effort: 2-3 weeks.

Tasks:

- Create `crates/collab-documents`.
- Move `references`, `kanban`, and `pdf` modules out of `collab-core`.
- Introduce explicit document-kind and parser-limit types.
- Move portable semantic validation currently embedded in server/Tauri handlers.
- Keep temporary re-exports from `collab-core` for one migration phase.
- Migrate server, Tauri, replica, and tests to direct imports.
- Remove re-exports after all consumers move.

Acceptance criteria:

- `collab-core` contains only cross-domain primitives.
- Server and Tauri use one reference/rewriting implementation.
- Document logic has no Axum, Tauri, SQLx, filesystem, or network dependency.
- Existing note, Kanban, canvas, PDF, and hosted-reference tests remain green.

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

## Phase 4: Archive Boundary

Estimated effort: 1-2 weeks.

Tasks:

- Compare server ZIP import/export, backup archives, local vault exports, folder
  downloads, and drag/download materialization.
- Extract only common validation and planning behavior.
- Preserve streaming and backend-specific storage behavior.
- Decide, with recorded evidence, between a dedicated `collab-archive` crate and
  a `collab-vault-domain::archive` module.
- Add traversal, separator, duplicate, zip-bomb, entry-count, total-size,
  symlink, and malformed-manifest fixtures.

Acceptance criteria:

- All archive entry paths pass one portable validator.
- Expanded-size and entry-count budgets are applied before commit.
- Server and native archive workflows retain their existing limits and output.
- No new crate is created if the resulting boundary has only one real consumer.

## Phase 5: Live Document Domain

Estimated effort: 3-4 weeks.

Tasks:

- Stabilize live message DTOs in `collab-protocol`.
- Create `crates/collab-live`.
- Extract Yrs seed/update/state-vector/compaction and structured JSON conversion.
- Extract recovery and materialization-decision logic behind persistence-neutral
  inputs.
- Keep server room registries and native WebSocket transport in their adapters.
- Add convergence, duplicate update, compaction, stale materialization,
  structured-document, cancellation, and bounded-message fixtures.

Acceptance criteria:

- `collab-live` can be tested without a socket, database, Tauri runtime, or
  server process.
- Server and native code do not fork Yrs conversion or diagnostic semantics.
- Existing live REST/WS integration, offline replay, viewer authorization, and
  recovery tests remain green.
- No transport credential enters the shared live crate.

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
