# Native Storage, Collaboration, Calendar And Background Performance

Implemented **2026-10-21**, desktop audit **O64–O70**, Performance Batch 9.
O64's bounded merge was already implemented; this batch preserves its conflict
behavior. The [audit](../audits/desktop-performance-and-bugs-2026-10-14.md),
[tracker](../plans/desktop-audit-fixes.md) and
[open development work](../plans/open-development-work.md) distinguish shipped
implementation from outstanding native release acceptance.

## Socket Backpressure And Recovery

`commands/live_queue.rs` replaces the unbounded native outbound channel. Each
connection retains at most 128 queued frames and roughly 32 MiB including its
in-flight send. A frame may contain the existing 16 MiB protocol payload plus
its document header. Native connections are capped at sixteen. Awareness for
one client/document coalesces; multi-client batches remain ordered. Ephemeral
awareness may be omitted under pressure. The frontend separately admits at most
32 in-flight IPC sends/64 MiB estimated materialized bytes, preventing an
unbounded bridge backlog before native admission. Durable CRDT/control frames never
silently disappear: rejection closes the frontend transport with code 1013,
then the provider reconnects and reconciles the retained Y.Doc through state
vectors. The offline checkpoint/journal provides restart durability independently.

A stalled send times out after fifteen seconds and reports closure; native
cleanup and frontend reconnection release the old owner. A closure received
before connect resolves cannot reopen a dead socket. This is bounded ownership,
not a claim that overloaded sockets deliver every frame without reconnecting.

## Incremental Offline CRDT Persistence

Periodic persistence encodes updates relative to the last acknowledged Yjs state
vector. A checkpoint compacts after 64 deltas or about one MiB of accumulated
updates. Explicit durable leave/save barriers also compact. Failed appends fall
back to an atomic full checkpoint, and failed writes never advance the vector.
Serialization runs inside the existing exclusive save runner, after preceding
writes settle, so in-flight edits remain included in the trailing flush.

`ReplicaStore` stores a full checkpoint separately from a length-framed delta
journal. Every encrypted delta has independent authenticated encryption, and
append acknowledgement requires fsync. Per-document locks serialize coherent
checkpoint/journal reads, append, compaction and clear without a global storage
compute lock. Publishing the checkpoint precedes journal retirement; a crash in
between merely replays idempotent updates. Interrupted final records are ignored
on read and truncated before another append. Complete corrupt records fail;
unreadable generations are preserved before replacement. Account/vault layout,
replica keys and existing authorization-aware cache policy remain authoritative.

Checkpoint plaintext is limited to sixteen MiB; checkpoint reads are bounded
before allocation. Journals are limited to sixteen MiB and 4,096 records. The
new read command returns one coherent checkpoint-plus-deltas generation. Legacy
snapshot commands remain available. No-op tracked JSON writes avoid rewriting
both data and integrity records; existing pending-operation status rewrites and
quarantine rules remain unchanged. This is not a pending-queue schema migration.

## Calendar Reconciliation

Local projection uses the mounted vault's immutable tree index and per-board
content revision, size and mtime. Only changed boards are read; deletions remove
their generated items. Source caches retain up to four MiB per scope and eight
scopes. An unreadable established board keeps its previous projection while a
retry remains possible. Failed publication never becomes a successful cache
baseline. Profile changes cannot publish old results into the active calendar.

A per-scope single-flight owner runs one trailing reconciliation when changes
arrive during work. Watcher events invalidate sources even if timestamps match;
changes during a read prevent publishing a stale cache generation. Hosted sync
also shares flights by profile/server/account origin, including overlapping
origin sets. Mirrors, assignments, operation acknowledgements and reminder
reconciliation retain their existing algorithms.

## Polling And Reminder Deadlines

`backgroundPolls.ts` owns one nearest-deadline timer and one set of focus,
visibility and connection listeners. Chat, inbox, team/member, hosted presence,
PDF sidecar and calendar consumers subscribe instead of allocating independent
intervals. Hidden/offline subscribers stop polling, resume once on wake and never
overlap their own active callback. Rejected callbacks back off exponentially up
to five minutes. Domain handlers that consume their own errors retain that
behavior. Conversation mutations invalidate visible polls; scope disposal
removes subscriptions and the final timer/listeners.

Native background scheduling uses the next reminder deadline or a sixty-second
inventory bound, with explicit settings, job-status and notification-schedule
wakeups. Disabled notification permission does not spin on an overdue reminder.
Tray status follows background events. Reminder delivery remains independent of
renderer visibility, and existing inventory/reconnect throttling stays in place.

## Completed Results And Drag Staging

Completed circuit jobs charge waveform vector capacities plus a conservative
metadata estimate: sixteen MiB per job, sixty-four MiB total. Over-budget results
fail visibly and retire their arrays. Chunk reads/status refresh the two-minute
idle lifetime; explicit discard releases ownership. Native housekeeping and new
job admission expire terminal results, preserving active workers. Solver work
limits remain separate from completed-result retention.

Native drag payloads use private randomized temporary directories and locked
leases, with a 256 MiB/32-directory process budget. The drag wrapper releases
owned staging leases after the OS drag call; ordinary local paths are ignored.
Released paths have a grace period for delayed OS readers. Under pressure,
released leases older than sixty seconds can retire; otherwise they expire after
twenty-four hours. Periodic/restart scavenging only visits matching directories,
skips symlink entries and cannot acquire an active process's lease lock. Traversal
is bounded to 4,096 temp entries. Unlocked crashed leases older than a day can be
removed; active transfers are preserved. OS crash leftovers from earlier
processes are scavenged separately from the current process byte budget.

## Opt-in Diagnostics And Release Gate

Production diagnostics are disabled by default. For a diagnostic build, set both:

```bash
COLLAB_PERFORMANCE_DIAGNOSTICS=1 VITE_COLLAB_PERFORMANCE_DIAGNOSTICS=1 pnpm tauri dev
```

For packaged testing, set the Vite flag when building and the native flag when
launching the resulting application. Development startup includes dev-server
cost; do not submit it as packaged release evidence.

The manual Build workflow has a `performance_diagnostics` checkbox for packaged
candidates. Launch such a candidate with the native environment flag enabled,
then open **Settings → General → Diagnostics → Performance capture**. Select a
scenario, start capture, close Settings and perform it, then return to finish and
save the report through the native save dialog. These controls are absent from
normal builds. Diagnostic manual runs omit the separate Flatpak job; use the
native matrix artifacts for capture.

The same API is available in a webview inspector when accessible:

```js
await window.collabPerformance.start('interaction');
// Perform at least 100 representative actions in the actual native app.
await window.collabPerformance.finish();
await window.collabPerformance.export();
```

The export command uses the shared native save dialog. Other scenarios are
`cold-start`, `warm-start`, `idle`, and `open-close-soak`. Startup is measured from
Tauri entry to the first webview paint, not OS loader entry or completion of an
arbitrary document load. Capture five fresh processes per startup kind; native
run IDs prevent reusing one launch as five samples. Document cold/warm cache
preparation alongside the reports. Idle captures need at least sixty seconds;
soak captures need at least two minutes and should repeat the same twenty open/
close actions. Capture visible and tray idle cases separately.

Frontend reports retain at most 2,048 records and 32 scenarios, recording IPC
operation duration, shallow byte estimates, interactions through the next paint,
long tasks where supported and shared-poll wakeups. Native reports retain 2,048
operation timings and expose process RSS/high-water counters through Linux
procfs, Windows process counters or macOS task info. Inputs, document content,
paths and tokens are not logged. Native timing spans cover formula work, CRDT
storage, socket admission, mutation-lock wait/hold time and background wakeups. Instrumentation runs only when
explicitly enabled and introduces measurement overhead.

```bash
pnpm desktop:performance:check --platform linux-webkitgtk /path/to/reports/*.json
# All supported desktop platforms are required when --platform is omitted:
pnpm desktop:performance:check /path/to/linux/*.json /path/to/windows/*.json /path/to/macos/*.json
```

Desktop builds and publication do not depend on native performance reports.
Version-manifest validation remains required for desktop tags. Collect real reports
under `docs/build/performance-evidence/desktop-v<version>/`, then run the separate
**Native Performance Qualification** workflow manually with `desktop-v<version>`
on a branch containing those reports, or use the CLI above. Missing evidence,
mismatched versions or failed budgets fails that explicit qualification check.
Manual diagnostic builds remain available for collecting evidence. Packaging
success does not establish native performance acceptance.

The checked-in budget file gates startup p95, interaction p95, native peak RSS,
idle IPC/wake rates and soak retention. Missing scenarios, missing memory,
insufficient fresh launches/interactions and truncated frontend telemetry fail.
The initial limits are explicit regression guardrails, not measured speedup
claims. Fixture tests exercise success and failure; synthetic fixture JSON must
never be submitted as installed acceptance evidence.

These native counters describe the main process, not aggregate webview/worker/
GPU memory. Attach platform inspector and process-tree/GPU traces for the
[audit measurement matrix](../audits/desktop-performance-and-bugs-2026-10-14.md#required-native-measurement-matrix).
Cache/disk growth, compositor behavior, native drag acceptance and full hosted/
encrypted/multi-client recovery also require real fixtures. The command is a
maintained release qualification gate; this PR's unit/build checks do not certify
all platforms. Windows/macOS counters still need platform compilation/runtime
acceptance, and physical Android remains separate.

## Validation

Synthetic scheduling retains all 92 callbacks across seven 3/5-second subscribers
while consolidating their independent interval firings into 28 clock wakeups per
minute. A one-character edit to a 100 KB Yjs document uses a delta under 200
base64 characters after seeding. These are deterministic fixture observations,
not installed power or whole-process memory benchmarks.

Chromium and Linux WebKitGTK each capture 100 browser interaction samples through
the real collector/export API with a synthetic native adapter. Sentinel document
content/paths are absent from exported reports. No browser connector was available;
installed Playwright and an offscreen WebKitGTK harness provided the fallback.
These checks validate capture and payload privacy, not installed native timing.

Suites run at the end of the batch. Coverage includes bounded socket admission,
awareness coalescing, backpressure reconnect and early closure; encrypted journal
replay, torn append repair, compaction, clear, byte limits and edits during a
pending leave checkpoint; indexed calendar
reads, deletion/rename, failed publication and events during a read; shared polling,
hidden/offline wake and backoff; circuit expiry/byte release and oversized-result
rejection; locked drag lease preservation/scavenging; diagnostics disabled mode
and report-gate failure cases. Validation results are recorded with the batch in
the implementation tracker. No live PostgreSQL or installed cross-platform soak
is inferred from these tests. The unrelated generated mobile index stays outside
the commit; Android frontend builds use a temporary output directory.
