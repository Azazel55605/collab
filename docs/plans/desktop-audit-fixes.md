# Desktop Audit Fixes

Started **2026-10-14**. Status: **In progress**. This tracks implementation of
the [desktop audit](../audits/desktop-performance-and-bugs-2026-10-14.md) and
[reported regressions](../audits/reported-regressions-2026-10-14.md). Original
audit counts/IDs remain historical inventories; implementation evidence belongs
here and in [Open Development Work](./open-development-work.md).

## Batch 1 — Save And Viewer Correctness

| Finding    | Implemented change                                                                                                                                                                                                                                                                                           | Remaining acceptance                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B01 / UR13 | Tab open/switch/close, page navigation and vault open/close wait for registered dirty document controllers. Write failure/conflict keeps the editor mounted; acknowledged native offline queues permit leaving. A subsequent edit clears the older queue acknowledgement.                                    | Process quit/death and durable draft recovery; live-save lifetime; remaining intermittent canvas failures beyond navigation.                                             |
| B02        | Search excerpts map lowercase byte positions back to original Unicode character indices and clip by characters.                                                                                                                                                                                              | Native UI search across representative scripts; Rust regression tests cover CJK, emoji and expanding lowercase.                                                          |
| B03        | SearchPanel invalidates old asynchronous results on query/vault change and unmount.                                                                                                                                                                                                                          | Native search interaction QA; regression covers reversed responses and cleared input.                                                                                    |
| B04        | PdfView retains/destroys loading tasks on errors and unmount; canvas PDF preview enters cleanup before awaiting load.                                                                                                                                                                                        | Repeated native open/close resource soak and corrupt/slow PDF fixtures.                                                                                                  |
| B05        | Race-safe native subscription helper used by filesystem collaboration transport, shell file events, PDF watcher and collaboration lifecycle/chat events.                                                                                                                                                     | Native lifecycle soak; delayed registration regression verifies late cleanup and ignored callbacks.                                                                      |
| B06        | Local document/sidecar writes use unique sibling staging files, flush their data and persist atomically.                                                                                                                                                                                                     | Windows/Wayland storage/rename-failure QA; Rust test preserves a pre-existing same-stem `.tmp` while concurrent writes use different extensions.                         |
| B07        | Local PDF preview writes carry SHA-256 of the bytes rendered; native revision check rejects writes for changed sources.                                                                                                                                                                                      | Slow-render replacement test on native storage; broader sidecar publish/cache-retention investigation remains.                                                           |
| B08        | Canvas scale can drop below 0.5; rounded backing dimensions also obey the pixel ceiling.                                                                                                                                                                                                                     | Large-display/GPU QA; unit tests include oversized surfaces and ceil-rounded dimensions.                                                                                 |
| UR01       | Bounded client-local PDF page/zoom/layout/rotation/bookmark settings survive viewer remounts, including hosted files; persistence is debounced and storage failures are tolerated.                                                                                                                           | Scroll/pan restoration, avoiding unnecessary source/worker reload, local/hosted/Android native interaction matrix.                                                       |
| UR07       | One native drag coordinate source with window fallback; duplicate path events are collapsed. External OS drops now map platform-native viewport units to CSS coordinates including app zoom, shared by file-tree hover/drop and Markdown insertion. Visible row geometry selects folder/file-parent targets. | Reported on **Windows and Linux/Wayland, with and without scaling**. Native coordinate/monitor matrix and target highlighting remain required before closing the report. |
| UR08       | Collaboration panel replaces its legacy Chat tab with an action opening the current Chats workspace. Persisted old tab selection falls back to Peers. Existing stored chat data is preserved.                                                                                                                | Navigation and notification compatibility QA.                                                                                                                            |
| UR10       | Kanban columns are constrained to available height; nested flex children can shrink and the cards area scrolls with stable scrollbar space.                                                                                                                                                                  | Native scrollbar/drag auto-scroll and touch matrix.                                                                                                                      |

This batch does **not** close the complete desktop backlog or every reported
symptom. Tests establish specific behavior, not proof that every intermittent
save or platform issue is solved.

## Batch 2 — Cache Reads And Offline Freshness

Implemented the next UR02/UR03 corrections:

- Reopening an existing hosted replica reconciles/replays it instead of blindly
  replacing its manifest. Seeding and optimistic edits preserve its offline-copy
  marker. Native and frontend syncs now publish changes on the manifest channel
  that document controllers and file lists actually subscribe to; autonomous
  native downloads bridge through `background:vault-synced` for the open vault.
- Concurrent requests share one synchronization per server/vault. Matching cached
  asset bytes return before a background sync; matching document bytes already
  use cache-first reads. Cached PDF/image annotation sidecars now also return
  before their network request, then publish newer sidecars through the existing
  dirty/conflict policy.
- Background document reads skip optimistic drafts and discard responses if an
  offline edit arrived or a newer revision is cached. Annotation refreshes leave
  queued changes intact. Native publication checks the queue after network waits
  and defers new local edits to replay; frontend bulk downloads check too.
- Partial offline downloads fail visibly instead of being labelled ready. The
  frontend adapter retains the previous download checkpoint until bodies refresh,
  so an interrupted update remains retryable.

The user confirmed the external-drop target fix **working on 2026-10-14**.
Broader platform/monitor coverage remains native release QA, rather than an open
reproduction of that user's original symptom.

Remaining UR02/UR03 acceptance: native downloaded-vault/reconnect scenarios,
cache-first preview scheduling, absent sidecars, safe source-byte refresh for
mounted PDF/image viewers, and broader cross-process replica concurrency. These
publication checks do not make the replica store transactional. A copy whose
offline marker was already erased by an older build needs **Make available
offline** once to restore that intent; the new code preserves it thereafter.

## Batch 3 — Canvas, Previews And Desktop UI

Implemented **2026-10-15**:

- **UR12/UR13:** Canvas load failures block editing/autosave instead of replacing
  unreadable content with an empty document. Initial sanitization stays in memory;
  opening a document alone does not rewrite it. Late loads cannot replace a newer
  canvas, and changing collaboration callbacks does not reload a dirty graph.
- Canvas gestures mark transient changes without repeatedly serializing the graph.
  Manual save/navigation materialize the latest graph, including an unfinished
  gesture. Navigation waits for both an active save and its coalesced trailing
  write. Live canvas edits flush before teardown and before applying remote
  changes; base-aware merging preserves independent remote fields/nodes.
  Native CRDT checkpoints are serialized/coalesced; explicit flush failures block
  navigation instead of reporting a durable save prematurely.
- **UR04:** Preview queues bound canvas/PDF work to two jobs each and document/web
  work to four each. Canvas hydration considers nearby visible cards, skips
  cancelled queued work, limits retained Markdown, and invalidates stale results
  when source revisions change. PDF cards reuse the common thumbnail pipeline.
  Web previews retain at most 128 completed entries, with ten-minute success and
  thirty-second error expiry.
- **UR02/UR03/UR04:** Hosted internal previews use cached manifest/body data before
  server requests when available. The in-memory SVG cache is scoped by account,
  content hash and renderer version, with 64-entry/16 MiB limits. Mounted hosted
  PDF/image views refresh changed source bytes after local edits are safe.
- **UR01:** PDF views retain scroll/pan alongside page/zoom/layout settings. A
  reference-counted PDF resource cache reuses unchanged sources across tab
  switches, with a two-entry/64 MiB source-byte budget; active documents are never
  evicted. This bounds retained sources, not total PDF worker/GPU memory.
- **UR05:** Shared renderer version 2 adds spatial canvas/logic diagrams, Kanban
  columns/cards, and first-slide deck layout, shape, theme and inherited text
  styles. Server/native thumbnail keys invalidate older renders. Rendering stays
  bounded and excludes private notes/external resource fetching. Deck images,
  charts and tables still use placeholders; this is not editor-fidelity output.
- **UR06/UR09:** Sidebar uses shared Tabs and resets file-tree state per vault.
  Newly active documents reveal their ancestors and leave stale trash/filter
  contexts. Visible legacy controls in canvas, Kanban, deck, drawing, image/PDF,
  spreadsheet and logic panels now use shared UI primitives. Hidden file chooser
  inputs remain adapters. Canvas edges no longer leak React Flow props onto DOM
  elements.

Browser acceptance uses actual React components with a disposable, in-memory
Tauri adapter at **1280 × 720**. Editing, saving and authoritative fixture reopen,
plus Files/Search sidebar navigation, are checked separately from native storage.
The generated SVG gallery is checked for bounds, readable labels and deck theme
contrast. These checks do not establish Windows/Wayland behavior or real-server
reconnect durability.

## Remaining Desktop Work

1. Native downloaded-vault/reconnect, dirty-overlay refresh, corrupt/large PDF and
   repeated open/close resource tests. A copy whose offline marker an older build
   erased still needs **Make available offline** once to restore its intent.
2. Canvas multi-client conflict/reconnect and actual-disk reopen acceptance,
   process quit/death recovery, and native CPU/heap/GPU profiling. Checkpoints and
   queue guards do not make cross-process replica publication transactional.
3. Full-fidelity internal thumbnails, including deck assets/charts, plus measured
   native preview latency/memory and broader shared-control/accessibility QA.
4. Remaining desktop audit investigations/optimization opportunities, ranked by
   measured workload impact. The original 70 opportunities are not all closed by
   these batches. Android drawing modes and the web/mobile audit backlogs remain
   separate work.

## Batch 1 Verification

- Full desktop/script run: **2,240 passed, one intentional skip**, after fixing
  React teardown in the test setup. Latest navigation/drop changes have additional
  focused reruns; the complete CI suite should run on the PR head.
- Admin **81/81** and Android **256/256** tests passed; desktop/admin/mobile
  TypeScript checks passed. Desktop and admin production frontend builds passed.
- `cargo test --workspace` passed with localhost binding permitted; workspace
  `cargo check`, crate boundaries and version alignment passed.
- Changed-file lint has zero errors; existing hook/Fast Refresh warnings remain.
  Formatting and diff checks passed.
- Compose configuration passed. Isolated server smoke did not start because
  BuildKit requires the existing `network.host` entitlement. Native UI/resource
  acceptance remains open, so this is not a blanket release/merge sign-off.

## External OS Drop Follow-up

The reported drop-area offset remained after the first batch because both native
handlers divided positions by devicePixelRatio. Inspection of the installed Wry
0.57.0 backend shows GTK/Wayland and WKWebView emit logical view coordinates,
whereas WebView2 emits physical client coordinates. A shared conversion now maps
the native view dimensions to the CSS viewport, including app zoom. The native
`native_drop_viewport` command preserves the backend bounds' units.

Enter and committed drops request fresh dimensions; hover events briefly reuse
geometry. Stale hover responses, disposed handlers and vault changes cannot
commit old targets. Geometry errors are visible and prevent importing into a
guessed folder. Regression fixtures cover Windows/Wayland coordinate spaces,
display scaling and app zoom, matching hover/drop targets, late responses, and
vault changes. The focused set has **27 passing tests**.

Follow-up validation: the full desktop/script suite has **2,255 passing tests,
one skipped test**, and one suite-loading failure: `security-dependency.test.ts`
requires a top-level `braces` module absent from this local pnpm layout (the
patched transitive package is installed). This is not a green full-suite run.
Admin **81/81**, Android **256/256**, desktop/admin TypeScript and frontend
builds, Rust workspace tests/check, boundaries, versions and Compose config
passed. Changed-file lint has zero errors and six existing FileTree warnings;
formatting and diff checks passed. Server smoke retains the first-batch limit.

**Rebuild the desktop binary** before testing this follow-up; frontend hot reload
alone cannot install the new native command. Physical Windows and Wayland drops,
including monitor transitions and app zoom, remain acceptance checks.

## Batch 2 Verification

- **177 focused desktop/shared regressions passed**, covering replica reopening,
  queue protection, sidecar refresh, native notifications, coalesced sync, and
  document-controller policy.
- Admin **81/81**, Android **256/256**, desktop/admin/Android TypeScript,
  desktop/admin frontend builds, Rust workspace tests/check and version/crate
  boundaries passed. Changed-file lint has no errors and two existing AppShell
  dependency warnings. Native UI and reconnect acceptance remain open.
- Full desktop/script run: **2,269 passed, one intentional skip**. The existing
  dependency test needs its already-installed patched `braces` package exposed
  via `NODE_PATH` in this local pnpm layout; this is a validation environment
  workaround, not a dependency-manifest change.
- Compose config passed previously; server smoke retains the Batch 1 BuildKit
  entitlement limitation. No real database/Compose project was altered.

## Batch 3 Verification

- Full desktop/script suite: **2,292 passed, one intentional skip**. The existing
  dependency test still requires the installed patched `braces` package exposed
  through `NODE_PATH`; dependency manifests were not changed. A test-only array
  lookup was subsequently made compatible with the configured TypeScript target,
  with all **17 live-session tests** rerun successfully.
- Canvas regression drives **100 drag updates without flow-to-document
  conversions during the gesture**, then saves and reopens the authoritative
  final position. This demonstrates eliminated conversion work, not a measured
  native FPS improvement. Navigation/checkpoint regressions cover trailing-save
  completion and independent concurrent JSON edits.
- An initial full run under concurrent builds exceeded the unchanged ink
  hit-test timing budget (11.2 ms versus 8 ms). All ten isolated ink tests and
  the final complete desktop run passed without increasing that budget.
- Android **256/256**, admin **81/81**, Rust workspace tests/check, crate
  boundaries and version alignment passed. Browser fixture save/reopen and
  sidebar interactions passed; the generated Rust thumbnail gallery was visually
  checked. The clean fixture has no console errors; an existing React Flow
  attribution warning remains.
- Desktop/admin/Android TypeScript and desktop/admin production frontend builds
  passed. Compose configuration passed without starting services.
- Changed/new-file lint has **zero errors and 66 warnings** (hook/Fast Refresh
  and existing component debt). Formatting and diff checks passed. Native
  acceptance and server smoke retain the boundaries below.

## Hosted Canvas Revision Regression — 2026-10-15

A hosted revision rejection could leave canvas status cycling from unsaved to
saving and back, with navigation blocked by the server's supplied-revision
error. The hosted adapter previously threw that rejection as a generic failure;
no actionable conflict reached the document controller. A cache-first conflict
reread could also return the stale revision again.

The adapter now fetches the conflicting document directly from the server and
returns its exact revision alongside its content. Shared document editors use
that supplied revision for conflict resolution. The canvas acknowledges content
already saved remotely, or retries **once** when the authoritative canvas still
matches its original saved base after normal editor normalization. Different
remote edits remain visible conflicts; retrying never silently rebases over them.
Server-merged write responses now supply the authoritative content to the
controller and offline body cache; canvas content is canonicalized before
establishing the new baseline. If additional edits arrive during a merged save,
the controller preserves those edits and the server result for explicit review
instead of replacing the newer local content.

Regression coverage includes stale-base save plus successful navigation,
already-persisted content, real remote edits, bounded repeated rejection, fresh
server conflict reads and returned server-merged bytes. Native/server acceptance
still requires a rebuilt client against the hosted server; these tests use the
adapter and controller harnesses.

Validation: full desktop/script suite **2,300 passed, one intentional skip**
(using the installed patched `braces` via `NODE_PATH` as above).
**170 focused document/navigation tests passed**; Android **256/256**,
admin **81/81**, desktop/Android/admin TypeScript and desktop/admin frontend
builds passed. Rust workspace tests/check, version/crate guards and Compose
configuration passed. Changed-file lint has zero errors and seven existing
warnings; formatting/diff checks passed. Server smoke retains the existing
BuildKit entitlement limitation described above.

## Hosted Canvas Source-Cause Correction — 2026-10-15

The previous revision-recovery change did not stop recurring merge prompts.
Tracing both writers identified server comparisons between compact live JSON and
formatted REST JSON, plus a client connection path that abandoned live ownership
when an edit arrived during connection. Callback/vault-object identity changes
could also restart that ownership or repeatedly mark the canvas dirty.

- Shared `collab-live` content comparison now treats structured JSON formatting,
  object-key order and equivalent integer/float forms as equal. Text remains
  byte-sensitive; array order, changed fields and distinct large integers remain
  significant. REST/live reconciliation uses that policy before declaring a
  structured conflict.
- Live materialization checks the current structured document when digests differ
  and skips formatting-only revisions. Optimistic revision-marker validation
  still happens first, preserving rejection of genuinely stale room writes.
- Canvas live ownership follows vault/path/permission scope rather than renderer
  callback or vault-object identity. Edits made during connection are merged from
  their REST base into the live document, preserving independent remote cards.
  An in-flight REST request finishes before live takeover. Dirty-state tracking
  likewise follows document scope rather than vault-object identity.

The new client regression covers a delayed connection, local edits, a remote
card, unstable callback/vault identities and the absence of competing REST saves.
A new **real PostgreSQL** regression performs three successive canvas edits and
checks exactly four revisions (initial plus three edits), including background
materialization. All **19 WebSocket/server tests** passed against an isolated,
disposable PostgreSQL container, including offline reconnect, permissions and
stale materialization protection. No existing database was used.

Final validation: **2,301 desktop/script tests passed, one intentional skip**
(with the same installed patched `braces`/`NODE_PATH` workaround noted above).
Android **256/256**, admin **81/81**, desktop/Android/admin TypeScript,
desktop/admin production builds, Rust workspace tests/check and version/crate
guards passed. Changed canvas files have zero lint warnings/errors; formatting
and diff checks passed. The disposable PostgreSQL container was stopped after
its tests; existing databases and running services were untouched.

**Both the desktop client and server must be rebuilt/deployed** for this fix.
An older server retains the raw-text comparison even with the newer desktop.
Native user acceptance remains open; the earlier recovery patch alone is not
considered a resolution of the recurring-merge report.

## Verification Boundary

Run the repository checks and focused regressions for each batch. Keep timing
tests separate from first-time native compilation. Tests that bind localhost or
spawn child CLIs require a host environment allowing those operations; an EPERM
is not product failure. Browser/jsdom success does not establish native drag,
GPU, memory, scrollbar, Windows or Wayland acceptance.

Server smoke checks must use a disposable Compose project/port. The first attempt
here was stopped by the existing BuildKit `network.host` entitlement requirement
before starting the server; smoke success is not claimed. Do not tear down a
user's running project to work around that gate.
