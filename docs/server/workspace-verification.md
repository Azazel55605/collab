# Server Workspace and Verification

## Rust Workspace

The repository root is the Cargo workspace root:

```text
Cargo.toml
apps/
  admin-web/         Focused browser administration interface; no Tauri dependencies
crates/
  collab-calendar/   Shared calendar model, recurrence, iCalendar, and native store
  collab-circuit/    Shared circuit model, compiler, and simulation numerics
  collab-core/       Shared paths, names, hashing, and encryption primitives
  collab-documents/  Bounded document parsing, references, and semantic classifiers
  collab-net-policy/ Shared outbound URL, address, redirect, and response policy
  collab-protocol/   Shared API/WebSocket DTOs, error codes, and protocol versions
  collab-replica/    Shared native hosted-vault offline replica store
  collab-server/     HTTP/WebSocket server, database, storage, auth, and migrations
src-tauri/           Tauri application adapter and native-only commands
```

Dependency direction:

```text
collab-core      -> no application crates
collab-protocol  -> no application crates
collab-documents -> collab-core
collab-net-policy -> no application crates
collab-calendar  -> standalone shared domain/store
collab-circuit   -> standalone shared domain
collab-replica   -> collab-core + collab-protocol
collab-server    -> collab-calendar + collab-core + collab-protocol
src-tauri        -> collab-calendar + collab-circuit + collab-core
                    + collab-protocol + collab-replica
```

`collab-core` must not depend on Tauri, Axum, SQLx, PostgreSQL, or a concrete blob backend. Server authorization and persistence remain in `collab-server`.

The phased target dependency graph is documented in the
[Rust Crate Boundary Refactor Plan](../plans/rust-crate-boundary-refactor-plan.md).
The inventory above remains authoritative until each extraction phase lands;
planned crate names must not be imported or described as implemented early.

The Phase 2 admin web application may reuse extracted design tokens and browser-safe
UI primitives from the desktop frontend, but it must not import Tauri APIs or
become a general-purpose hosted-vault editor.

## Extraction Policy

- Start with a named internal module when only one adapter owns the behavior.
- Extract a crate only when at least two consumers need a coherent, independently
  testable domain contract.
- Preserve existing Tauri command signatures until a frontend migration explicitly changes them.
- Keep framework, transport, persistence, process-lifecycle, and operating-system
  dependencies in `collab-server` or `src-tauri`.
- Add characterization tests and define domain inputs/outputs before moving
  security-sensitive or persistence-sensitive behavior.
- Do not move local-only dialogs, recent-vault persistence, watchers, updater logic, or encryption-session state into shared crates.
- Follow the extraction order and compatibility-re-export limits in the crate
  refactor plan.

## Required Verification

Existing checks remain required:

```bash
pnpm test
pnpm exec tsc --noEmit
cd src-tauri && cargo test
cd src-tauri && cargo check
```

Phase 1 adds:

```bash
cargo test --workspace
cargo check --workspace
docker compose config
docker compose up --build --wait
./scripts/server-smoke.sh
./scripts/server-backup-restore-smoke.sh
```

`Dockerfile.server` uses `cargo-chef` to cache compiled dependencies separately
from application source. The first image build warms the cache. Later source-only
changes reuse the dependency layer; Cargo manifest and lockfile changes rebuild it.

The server crate must add:

- Unit tests for domain and authorization rules.
- PostgreSQL integration tests using isolated databases.
- REST and WebSocket protocol tests.
- Blob-storage contract tests.
- Migration tests from every supported schema fixture.
- Compose smoke tests from an empty environment.

Phase 2 admin web changes must add:

- Frontend component and state tests.
- Browser-level bootstrap, authentication, and user-management tests.
- Accessibility checks for core administration flows.
- Server integration tests for admin authorization, browser sessions, CSRF
  protection, audit redaction, and session revocation.

## Change Acceptance

A server phase task is complete only when:

- Its behavior is implemented and tested.
- Existing local-vault behavior remains green.
- Relevant architecture and protocol documents are updated.
- The canonical implementation plan and
  [Open Development Work](../plans/open-development-work.md) are updated.
