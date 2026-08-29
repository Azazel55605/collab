# Rust Crate Boundary Phase 0 Baseline

Captured on 2026-07-26 from the repository root. This is the comparison point
for Phases 1-6 of the
[Rust Crate Boundary Refactor Plan](./rust-crate-boundary-refactor-plan.md).
The refactor must preserve external behavior while reducing adapter-owned
domain logic.

## Build Baseline

Commands:

```bash
CARGO_TARGET_DIR=/tmp/collab-phase0-target cargo check --workspace
cargo check --workspace
```

Observed on the development machine:

| Check                       |  Elapsed |  User CPU | System CPU |
| --------------------------- | -------: | --------: | ---------: |
| Isolated clean target       | 64.526 s | 528.877 s |   92.669 s |
| Existing incremental target |  0.312 s |   0.214 s |    0.088 s |

These are directional local measurements, not CI performance budgets. Phase 6
must repeat the same commands on the same machine or record why the environment
changed.

## Module Baseline

| Module                                       |   Lines |   Bytes | Current responsibilities                                                       |
| -------------------------------------------- | ------: | ------: | ------------------------------------------------------------------------------ |
| `crates/collab-server/src/api.rs`            | 15,000+ | 550,963 | Auth, users, vaults, files, revisions, transfer, admin, backup, settings       |
| `crates/collab-server/src/ws.rs`             |  1,900+ | 104,585 | WebSocket transport, room lifecycle, Yrs conversion, recovery, materialization |
| `src-tauri/src/commands/files.rs`            |  3,000+ | 102,146 | Tree IO, note writes, trash, sidecars, imports, downloads, references          |
| `src-tauri/src/commands/web.rs`              |    900+ |  35,823 | Native outbound URL and response hardening plus link metadata                  |
| `crates/collab-server/src/calendar_feeds.rs` |    200+ |   9,010 | Server outbound URL and response hardening for calendar feeds                  |
| `crates/collab-core/src/references.rs`       |     900 |       - | Note, Kanban, and canvas reference analysis and rewrites                       |
| `crates/collab-core/src/kanban.rs`           |     544 |       - | Kanban parsing and capability classification                                   |
| `crates/collab-core/src/pdf.rs`              |     183 |       - | PDF-sidecar capability classification                                          |

Exact current values can be regenerated with:

```bash
find crates/collab-server/src src-tauri/src/commands crates/collab-core/src \
  -name '*.rs' -print -exec wc -lc {} \;
```

## Current Workspace Graph

```text
collab-core: none
collab-protocol: none
collab-calendar: none
collab-circuit: none
collab-replica: collab-core, collab-protocol
collab-server: collab-calendar, collab-core, collab-protocol
collab (Tauri): collab-calendar, collab-circuit, collab-core,
                collab-protocol, collab-replica
```

Run `pnpm rust:boundaries` to validate current and future workspace edges. The
check fails when a new workspace crate has no policy entry, an undeclared edge
appears, or a domain crate takes an adapter-framework dependency. The existing
`collab-calendar -> sqlx/sqlite` edge is a documented exception because that
crate deliberately owns the profile SQLite store; planned domain crates do not
inherit that exception.

## Consumer And Duplication Map

### Outbound Network Policy

Current owners:

- `src-tauri/src/commands/web.rs`: link-preview URL parsing, DNS/IP rejection,
  redirect handling, content-type and response-size bounds.
- `crates/collab-server/src/calendar_feeds.rs`: calendar-feed URL parsing,
  DNS/IP rejection, redirect handling, conditional requests, and response
  bounds.

Consumers after extraction:

- Tauri link previews and future native calendar/location clients.
- Hosted calendar subscription refresh.

Duplicated concepts include public-target classification, credential rejection,
redirect revalidation, and bounded response reads. Request execution and
application-specific parsing remain in adapters.

### Document Domain

Current owners and consumers:

- `collab-core::references`: server hosted rename/move/trash and Tauri local
  rename/move/trash/reference inspection.
- `collab-core::kanban`: hosted capability enforcement and generated-calendar
  projection input.
- `collab-core::pdf`: hosted PDF-sidecar capability enforcement.
- Structured document classification is repeated in server API branches,
  Tauri extension branches, and live-document materialization.

`collab-documents` should initially expose:

```rust
pub enum DocumentKind { Note, Kanban, Canvas, Logic, Svg, PdfSidecar }
pub struct ParserLimits { pub max_bytes: usize, pub max_entries: usize, pub max_depth: usize }
pub struct DocumentInput<'a> { pub kind: DocumentKind, pub path: &'a str, pub content: &'a [u8] }
pub struct ValidationReport { pub normalized: Option<Vec<u8>>, pub warnings: Vec<DocumentWarning> }
pub struct ReferenceQuery<'a> { pub source_path: &'a str, pub target_path: &'a str }
pub struct ReferenceRewrite<'a> { pub old_path: &'a str, pub new_path: Option<&'a str> }

pub fn classify_path(path: &str) -> Option<DocumentKind>;
pub fn validate(input: DocumentInput<'_>, limits: ParserLimits) -> Result<ValidationReport, DocumentError>;
pub fn references(input: DocumentInput<'_>, query: ReferenceQuery<'_>) -> Result<Vec<FileReference>, DocumentError>;
pub fn rewrite_references(input: DocumentInput<'_>, rewrite: ReferenceRewrite<'_>) -> Result<Vec<u8>, DocumentError>;
```

Document parsing does not receive vault/database handles. The vault domain may
request reference analysis by passing explicit documents and paths.

### Vault Mutation Domain

Current owners and consumers:

- Hosted invariants and transaction orchestration live primarily in server
  `api.rs`.
- Local file ordering, trash state, optimistic note writes, and reference
  rewrites live in Tauri `commands/files.rs`.
- Replica replay contains pending-operation/idempotency behavior but should
  consume domain decisions instead of owning canonical mutation rules.

Draft contract:

```rust
pub struct VaultSnapshot { pub manifest_sequence: i64, pub entries: Vec<EntrySnapshot> }
pub struct MutationContext { pub capabilities: CapabilitySet, pub operation_id: String }
pub enum MutationRequest { Create(...), Move(...), Trash(...), Restore(...), Purge(...) }
pub struct MutationPlan {
    pub preconditions: Vec<Precondition>,
    pub metadata_changes: Vec<MetadataChange>,
    pub reference_rewrites: Vec<ReferenceRewritePlan>,
    pub storage_delta_bytes: i64,
    pub next_manifest_sequence: i64,
}

pub fn plan_mutation(
    snapshot: &VaultSnapshot,
    context: &MutationContext,
    request: MutationRequest,
) -> Result<MutationPlan, VaultDomainError>;
```

Authorization lookup, SQL/filesystem execution, blob IO, watcher suppression,
and transaction boundaries remain adapter responsibilities.

### Archive Boundary

Current owners:

- Hosted vault ZIP import/export and folder download in server `api.rs`.
- Backup archive import/export in server admin helpers.
- Local vault export and file/folder materialization in Tauri commands.

Draft shared planning types:

```rust
pub struct ArchiveLimits { pub entries: usize, pub expanded_bytes: u64, pub entry_bytes: u64 }
pub struct ArchiveEntryInput<'a> { pub raw_path: &'a str, pub kind: EntryKind, pub size: u64 }
pub struct ArchivePlan { pub entries: Vec<PlannedArchiveEntry>, pub expanded_bytes: u64 }

pub fn plan_import(
    entries: impl IntoIterator<Item = ArchiveEntryInput<'_>>,
    limits: ArchiveLimits,
) -> Result<ArchivePlan, ArchiveError>;
```

Phase 4 must measure whether backup archives and vault archives share enough
semantics for a crate. Compression/streaming and concrete storage remain local.

### Live Document Domain

Current owners and consumers:

- Server `ws.rs` owns transport plus text auto-merge, Yrs JSON conversion,
  update validation, compaction, and stale-materialization guards.
- Native `live_ws.rs` owns transport; frontend Yjs modules currently own the
  client conversion path.
- `collab-protocol` owns stable WebSocket control DTOs.

Draft contract:

```rust
pub enum LiveDocumentKind { Text, StructuredJson, Canvas }
pub struct MaterializationMarker { pub revision_sequence: i64, pub digest: String }
pub enum MaterializationDecision { Persist, Unchanged, RejectStale, RejectDegenerate }

pub fn seed(kind: LiveDocumentKind, content: &[u8]) -> Result<LiveState, LiveError>;
pub fn apply_update(state: &mut LiveState, update: &[u8], limits: UpdateLimits) -> Result<ApplyOutcome, LiveError>;
pub fn compact(state: &LiveState) -> CompactedState;
pub fn decide_materialization(
    expected: Option<&MaterializationMarker>,
    current: Option<&MaterializationMarker>,
    content: &[u8],
) -> MaterializationDecision;
```

Sockets, room registries, authentication, persistence, and scheduling remain in
server/native adapters.

## Characterization Matrix

The extraction baseline is protected by existing and Phase 0 tests:

| Area          | Characterized behavior                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Security      | Hosted/native path rejection, outbound private target rejection, archive traversal rejection, rate/auth boundaries |
| References    | Note wikilinks/markdown links, Kanban attachments, canvas file nodes, rename/delete rewrites                       |
| Archive       | Backslash normalization, traversal rejection, expanded-size limits, backup manifest/checksum validation            |
| Revisions     | Optimistic writes, non-overlapping text auto-merge, stale materialization refusal, snapshot restore                |
| Live recovery | Empty/degenerate room recovery, duplicate update convergence, compaction, external revision merge                  |

Phase 0 adds adapter-local ownership modules around these characterized rules.
Later phases move only the pure contracts and implementations, keeping the
adapters and serialized boundaries stable.

## Phase 0 Post-Split Measurements

| Adapter parent            |        Before |         After | Extracted private module                    |
| ------------------------- | ------------: | ------------: | ------------------------------------------- |
| Server `api.rs`           | 550,963 bytes | 545,241 bytes | `api/archive.rs` (7,597 bytes)              |
| Server `ws.rs`            | 104,585 bytes |  97,405 bytes | `ws/domain.rs` (8,131 bytes)                |
| Tauri `commands/files.rs` | 102,146 bytes |  93,514 bytes | `commands/files/sidecars.rs` (10,411 bytes) |

The purpose of this split is ownership, characterization, and a stable
extraction point, not maximum line-count reduction. Larger route and command
families remain adapter code and can be subdivided mechanically as their domain
phases land.

## Phase 6 Comparison

Captured on 2026-07-27 on the same development machine with:

```bash
CARGO_TARGET_DIR=/tmp/collab-phase6-target cargo check --workspace
cargo check --workspace
```

| Check                       | Phase 0 elapsed | Phase 6 elapsed |   Change |
| --------------------------- | --------------: | --------------: | -------: |
| Isolated clean target       |        64.526 s |        51.166 s |   -20.7% |
| Existing incremental target |         0.312 s |         0.439 s | +0.127 s |

The clean check used 374.453 seconds of user CPU and 70.598 seconds of system
CPU, down from 528.877 and 92.669 seconds respectively. The existing-target
incremental check remains sub-second. An immediate rerun against the isolated
Phase 6 target took 1.394 seconds because the Tauri package's build check ran
again. These remain directional workstation measurements rather than CI
budgets.

| Adapter parent             | Phase 0 bytes | Phase 6 bytes | Change |
| -------------------------- | ------------: | ------------: | -----: |
| Server `api.rs`            |       550,963 |       552,818 | +0.34% |
| Server `ws.rs`             |       104,585 |        95,225 | -8.95% |
| Tauri `commands/files.rs`  |       102,146 |        94,611 | -7.38% |
| Tauri `commands/web.rs`    |        35,823 |        36,367 | +1.52% |
| Server `calendar_feeds.rs` |         9,010 |         8,335 | -7.49% |

`api.rs` and `web.rs` received product work during the refactor program, so
their small growth is not extraction overhead alone. The extracted final shared
domains contain:

| Crate                 | Rust lines | Rust bytes |
| --------------------- | ---------: | ---------: |
| `collab-core`         |        320 |      9,930 |
| `collab-documents`    |      2,103 |     69,674 |
| `collab-vault-domain` |        758 |     24,569 |
| `collab-archive`      |        701 |     22,609 |
| `collab-live`         |        634 |     20,368 |
| `collab-net-policy`   |        472 |     14,631 |

The final dependency graph is enforced by `pnpm rust:boundaries`. The Tauri
adapter imports `collab-replica` directly; its temporary blanket re-export was
removed. A direct-dependency review also removed unused Tauri dependencies on
`anyhow`, `aes-gcm`, and `regex`.

`cargo tree --workspace --duplicates --depth 1` found only transitive ecosystem
version splits, chiefly Tauri/build tooling, HTML parsing, the WebSocket HTTP
client, development HTTP mocks, and platform keyring stacks. None were
introduced as duplicate direct dependencies by the extracted domain crates;
forcing them to one version would require upstream adapter changes and is
therefore outside this behavior-preserving refactor.
