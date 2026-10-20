# Desktop Audit Fixes

Started **2026-10-14**. Status: **In progress**. This tracks implementation of
the [desktop audit](../audits/desktop-performance-and-bugs-2026-10-14.md) and
[reported regressions](../audits/reported-regressions-2026-10-14.md). Original
audit counts/IDs remain historical inventories; current checkboxes live in the
audit documents, with implementation evidence here and in [Open Development Work](./open-development-work.md).

## User Retest — 2026-10-19

After merging PR #96 and updating the installed git build, the user reports that
canvas live editing no longer exhibits the recurring save/merge issue. This
closes the reported UR13 live-editing symptom. The user also reports a much
faster, snappier application, particularly from avoiding repeated and stale
loading. These are observations from the installed app, not measured latency,
CPU, heap or GPU results.

**Hosted non-live saves — user-retested, 2026-10-19:** the user subsequently
reported the same conflict without live editing and confirmed the server had
not been updated. After updating the test server, the user reports the issue
appears fixed. Close this reported symptom. The REST/live JSON comparison fix
runs on the server; no additional persistence change was made in this follow-up.

UR12 profiling, large-board/resource soak, explicit navigation/reopen/restart,
offline/conflict/storage-failure cases and the broader native platform matrix
remain open. External-writer and process-death recovery remain separate work.

## Batch 1 — Save And Viewer Correctness

| Finding    | Implemented change                                                                                                                                                                                                                                                                                           | Remaining acceptance                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B01 / UR13 | Tab open/switch/close, page navigation and vault open/close wait for registered dirty document controllers. Write failure/conflict keeps the editor mounted; acknowledged native offline queues permit leaving. A subsequent edit clears the older queue acknowledgement.                                    | Process quit/death and durable draft recovery; broader live/offline, navigation/reopen and storage-failure acceptance.                                                   |
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

Status: **User-retested, 2026-10-19:** the recurring canvas live-edit/save issue
is no longer observed after the merge and installed-app update. The user report
closes that symptom; it does not establish the full navigation/reopen/restart,
offline, failure or platform matrix. See the user-retest record above.

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
The 2026-10-19 user retest confirms the recurring live-editing symptom is no
longer observed. Broader native acceptance remains open; the earlier recovery
patch alone was not considered a resolution of the recurring-merge report.

## Batch 4 — Scoped Indexing, Snippets And Render Errors

Implemented **2026-10-15** while canvas was awaiting user retest (completed for the reported live-editing
symptom on 2026-10-19):

- **R01 / O18:** `useVaultNoteIndex` owns initial loads and file/replica refreshes
  for the active vault/server scope. It clears notes when closing/locking/switching,
  ignores late results, and coalesces events into one active job plus a debounced
  trailing refresh. Vault metadata identity changes do not restart indexing.
- The native note-index slot now carries its vault path and request generation.
  Opening/creating a local vault clears it while changing the active vault;
  superseded scans stop at entry boundaries and cannot publish over newer jobs.
  Backlinks/search select only the requested vault's notes. Scan/search jobs
  capture their encryption key once. Search shares an immutable snapshot without
  copying all note metadata and releases the index lock before disk reads. Native encrypted-vault lifecycle/close-key recovery remains separate
  acceptance work.
- File-tree refreshes reject results from an older vault instance or refresh
  generation instead of replacing the current sidebar tree.
- **R07:** snippet listings and delayed mutations retain scope/epoch ownership;
  old lists cannot undo a completed mutation. App/vault snippets sharing an ID no
  longer replace/delete each other in the visible list.
- **R10:** Markdown render-error text is HTML-escaped before insertion. The
  regression injects markup through a renderer exception and verifies literal
  text with no injected elements. This repairs an unsafe fallback; it is not a
  claim of a demonstrated production exploit.
- PR #96's **nine failing Rust dependency advisories** are fixed by compatible
  `quinn-proto` and `rustls` upgrades. The refreshed audit reports zero
  vulnerabilities. See [Security Advisories](../build/security-advisories.md)
  for IDs/versions and the remaining informational warnings. No new ignores.

Focused evidence: **32 frontend regressions passed**, covering reversed vault
loads, close/lock/unlock, same-ID hosted vaults on different servers, event bursts,
file-list publication, snippet races and render-error escaping. Three native index
policy tests cover cross-vault/same-vault generations, reopening the same path,
and sharing immutable snapshots.
Final frontend verification: **2,312 desktop/script tests passed, one intentional
skip**, using the existing patched-`braces` `NODE_PATH` workaround. Android
**256/256**, admin **81/81**, desktop/Android/admin TypeScript and desktop/admin
production builds passed. Changed-file lint has zero errors and nine existing
Markdown warnings; formatting and diff checks passed. JavaScript audit passed at
the CI high threshold; the accepted patched `braces` remains documented.
Rust workspace tests/check and crate/version guards passed, including all three
native index policy tests. The isolated Compose smoke test was retried and still
stopped before startup because BuildKit lacks its `network.host` entitlement.
The container security check must run in CI; no running user server was altered.

Native UI/resource/crypto acceptance and the wider audit backlog remain open.

## Batch 5 — Grid Lifetimes And Local Save Serialization

Implemented **2026-10-15**. Canvas was awaiting user retest at this batch; see the 2026-10-19 retest above.

- **R02 / B01:** Grid editor subtrees are keyed by vault/server, document type and
  path. Cell replacement/clear, swaps, reorders, workspace creation/switch/deletion,
  layout changes and split activation pass through the save-before-navigation
  gate. Delayed actions cannot mutate a different active workspace. Responsive
  resizing also waits before removing mounted panes and rejects obsolete resize
  completions.
- Same-file grid panes have separate status-registration owners. Navigation
  inspects every controller; cleaning up one pane cannot remove another pane's
  registration. Sessions remain independent; **O15 shared sessions is open**.
- **R03 partial:** Native note writes serialize the full expected-hash check,
  merge and atomic publication per canonical parent/file within this process.
  Weak lock entries are retired as later writes arrive; separate files do not
  share an I/O lock. Concurrent stale writers receive the existing conflict or
  merge result. This does not coordinate another application/process or protect
  other write/delete/rename paths. External-writer acceptance remains open.
- Both audit documents now carry current completion/partial/acceptance status.
  Implemented code is distinguished from outstanding platform/fidelity work.

### Batch 5 Verification

- The end-of-batch full desktop/script run recorded **2,321 passed, three failed,
  one intentional skip**. Failures were the existing ink 8 ms timing ceiling
  (9.3 ms under load), a CLI child-process `EPERM` in the sandbox, and the new
  resize test attempting to redefine a non-configurable harness mock.
- The resize fixture now assigns/restores that writable mock. Review also added
  a regression preventing delayed layout animation from changing a different
  workspace. All **46 affected desktop tests passed** in the final focused run,
  including grid navigation/identity, same-file pane ownership, resize/layout,
  the unchanged ink budget and host-permitted manifest CLI. Unrelated desktop
  suites were not repeated after these fixture/guard corrections.
- Admin **81/81** passed. Android's full run recorded **254 passed/two failures**
  in the calendar screen during native compilation; all **14 calendar tests**
  subsequently passed in isolation, without changing Android code or timeouts.
- Rust workspace tests/check and formatting passed, including eight simultaneous
  stale note writers (one accepted, seven conflicts) and canonical-parent lock
  sharing. Desktop/admin/Android TypeScript, desktop/admin production builds,
  changed-file lint (zero warnings/errors), formatting, crate/version guards and
  Compose configuration passed.
- Both dependency and container security checks passed on PR #96's preceding
  head, confirming the prior dependency fixes. New-head CI must still run.
  No new dependency changes or advisory ignores in this batch.
- Native UI, external-writer coordination, process-death recovery and canvas
  user acceptance remain open. Server smoke retains the previously established
  BuildKit entitlement limitation; it was not rerun for these desktop-only
  changes. No existing server/database was changed.

## Batch 6 — Atomic Preview Records And OCR Ownership

Implemented **2026-10-15**. Canvas was awaiting user retest at this batch; see the 2026-10-19 retest above.

- **R04:** Preview metadata and image bytes are encoded in one integrity-checked
  `.entry` record, published by the existing encrypted/atomic staging helper.
  Readers cannot combine independently published MIME/source data and images.
  Missing, corrupted, truncated, obsolete-renderer and legacy records are cache
  misses and can regenerate. Source metadata and expected render hash checks
  remain. Legacy pairs are retained for older clients; disk retention is O44.
- Native regressions exercise concurrent readers/writers with different image
  MIME/payloads, staged-before-publish reads, corruption/regeneration, encrypted
  records/wrong keys, stale writes and changed source/renderer invalidation.
- **R05 / O47:** One bounded serial queue owns OCR preprocessing, WASM worker
  initialization/recognition, language transitions and native fallback. At most
  eight active/queued jobs retain inputs; additional requests fail visibly.
  Cached results bypass running jobs, and queued duplicates recheck cache after
  earlier jobs finish. Cache failures do not stop otherwise working recognition.
- Progress callbacks belong to the worker's running job; completed/retired
  workers lose their callbacks. Language changes and idle shutdown wait for
  prior work. Only an empty queue schedules the three-minute idle timer, and new
  work waits for any already-started termination. Failure cannot poison later
  jobs; failed workers retire before native fallback. Preprocessing is reused
  for fallback instead of being repeated.
- OCR tests use controlled worker/recognition/termination promises and virtual
  time. Real Tesseract/WASM memory soak, native subprocess cancellation/timeouts,
  preprocessing byte/worker budgets and authorized OCR retention remain open
  under O45/O46/R08/O48. No native preview latency/FPS/memory speedup is claimed.

### Batch 6 Verification

- Full desktop/script suite: **2,335 passed, one intentional skip**, including
  all **10 new OCR ownership regressions**. The installed patched `braces`
  `NODE_PATH` workaround remains; host permissions let CLI tests spawn Node.
- Admin **81/81**, Android **256/256**, desktop/admin/Android TypeScript and
  desktop/admin production builds passed. No suite retries were needed.
- Rust workspace tests/check and formatting passed, including all **five new
  native preview publication/invalidation regressions**. Changed-file lint has
  zero warnings/errors. Formatting, diff checks, crate/version guards and
  Compose configuration passed.
- All four PR #96 checks were green on the preceding batch's head, including
  dependency/container security. This push requires new-head CI. No dependency
  or advisory-ignore changes were made.
- **Rebuild the desktop binary** for native cache publication. Old cached pairs
  regenerate into the new record on demand and remain on disk for older clients;
  no authoritative sidecar/data migration or deletion occurs. Native storage,
  real OCR engine/memory soak and canvas user acceptance remain open.
- Server smoke retains the existing BuildKit entitlement limitation and was not
  rerun for these desktop-only changes. No existing server/database was changed.

## Batch 7 — Formula Lifetime And Queued Work

Implemented **2026-10-15**. Canvas was awaiting user retest at this batch; see the 2026-10-19 retest above.

- **R06 / mobile MR07:** A shared owner controls each mounted formula runtime.
  Closing/removing formulas cancels debounce/trailing requests, waits for an
  already-submitted evaluation to settle, then releases exactly once. Evaluation
  can no longer be submitted by that owner after release. New workbook and
  StrictMode lifetimes receive fresh runtime IDs; late results cannot publish to
  the replacement or unmounted component.
- **O55 partial:** Each owner retains one active and one replaceable latest
  trailing request. Request changes discard obsolete pending inputs; submitted
  native work finishes normally. Prior results remain visible during same-book
  recalculation, while a changed workbook scope hides them immediately. Volatile
  evaluation time is refreshed at actual dispatch, including a midnight boundary.
- Framework-free request construction moved to `formulaRequest.ts`. Desktop,
  Android and deck snapshots share it without importing desktop UI state through
  the desktop hook. `useSheetFormulaSession.ts` shares lifecycle/debounce/result
  handling; adapters retain their typed IPC wrappers and timezone policies.
- Regression cases cover delayed native execution across close, cancellation,
  latest trailing work, failure recovery, midnight, retained same-workbook values,
  workbook replacement, formula removal, StrictMode and mobile close/debounce.
- Native registry lock isolation/global concurrency (O54), running-job
  cancellation and explicit volatile recalculation (remaining O55), incremental
  IPC (O53), and real native/device stress/memory acceptance remain open. This
  changes frontend ownership, not the formula engine or IPC protocol.

### Batch 7 Verification

- Full desktop/script suite: **2,346 passed, one intentional skip**. Admin
  **81/81** and Android **258/258** passed. The new regressions comprise **11
  desktop/shared and two mobile tests**; no suite retries were needed.
- Desktop/admin/Android TypeScript and all **three frontend production builds**
  passed. Android frontend build is not an APK/AAB or physical-device run.
- Rust workspace tests/check, formatting, changed-file lint (zero warnings/errors),
  diff checks, crate/version guards and Compose configuration passed. No native
  source, formula engine or IPC contract was changed. The existing patched
  `braces` `NODE_PATH` workaround and host-permitted CLI tests remain documented.
- The preceding PR head's four checks were green, including dependency/container
  security; this push requires new-head CI. No dependency/ignore changes.
- Native formula close/reopen stress, running-job cancellation/global scheduling,
  explicit volatile recalculation, device memory and canvas user acceptance
  remain open. Server smoke retains the existing BuildKit entitlement limitation
  and was not rerun for these frontend-only changes. Existing servers/databases
  were untouched.

## Batch 8 — Desktop Bug Completion And Math Discoverability (2026-10-19)

- [x] **UR14:** The user confirms the shortcut works again. Rendered-editor
      reproduction also evaluates `2+2` once with Ctrl+Enter. No speculative cause is
      assigned to the earlier transient report. A muted inline hint now advertises
      exact/approximate shortcuts while the caret is inside an editable math block;
      it disappears in ordinary text, selections and read-only notes.
- [x] **Math ownership/read-only bugs:** A variable chooser belongs to one editor
      pane and one immutable document revision. Editing before choosing a variable
      rejects the stale action. Invalid scalar input produces an error notification.
      Math/snippet/formatting/context-menu/imperative edits respect read-only state;
      an asynchronous paste cannot overwrite a changed document. Code-fenced examples
      no longer alter display-math command delimiter pairing.
- [x] **R08 / O48:** Derived OCR text and word boxes are memory-only for the
      current vault/account context, with 64-entry, 8 MiB and 30-minute limits.
      Lifecycle subscriptions clear results on vault close/lock/switch, logout/account
      changes and observed membership loss. Generation-stamped jobs cannot repopulate
      a cleared cache. The legacy plaintext database is deleted on app startup and
      deletion failures/blocked upgrades remain retryable. Settings explains retention;
      language packs and saved annotations remain installed/authoritative.
- [x] **B01 normal quit:** Native window close in quit mode, tray quit and normal
      system quit now request the renderer's save boundary before shutting down
      background work/live transports. Failed/conflicting saves keep the main editor
      open. Repeated requests coalesce; listener readiness checks recover early quit
      requests. Hide-to-tray behavior is unchanged. This does not implement forced
      process-death draft recovery or prove live-session durable acknowledgement.
- [x] **B01 live checkpoints:** `useLiveDocumentStatus` registers a native offline
      checkpoint barrier on each live controller. Navigation and quit await it after
      materializing gestures, even when live ownership suppresses REST writes.
      Checkpoint rejection blocks leaving; ordinary local saves still dispatch
      immediately. Server receipt and physical restart acceptance remain open.
- [x] **R03 additional corrections:** A stale expected revision cannot resurrect
      an externally deleted file. Local writes compare observed bytes again after
      validation/encryption/staging and reject intervening external changes. The
      per-file app mutex remains; unrelated applications can still race the final
      rename and cannot be made atomic participants with an advisory lock.
- [x] **R09 investigation:** Hosted tag/link/word-count parity is a confirmed
      capability gap. The manifest is a lightweight filename/revision index; server
      full-text search is distinct. A shared content-metadata endpoint/cache design
      is follow-on feature work. Do not fetch every hosted note on every tree refresh
      merely to fill these fields, or claim empty fields are full index parity.

Desktop **B01–B08 corrections are implemented**. The remaining work is explicit:
**UR13 recurring live-edit/save symptom is user-retested**; UR12 profiling and
the broader native acceptance matrix remain open. External
writer coordination and forced-death/durable-draft recovery have a separate
follow-up policy below; UR04/UR12 profiling belongs to performance work;
UR05 asset fidelity, R09 hosted indexing and the broader UR06 component inventory
are enhancements. Android UR11 and the web/mobile bug backlogs are outside this
desktop batch. PDF/offline/reconnect/scrollbar/sidebar/platform acceptance still
requires the native matrix; checkboxes do not assert it passed.

Validation (2026-10-19):

- Desktop/scripts: **2,365 passed, one intentional skip** across 332 files after
  targeted correction/rerun. The first sandbox run had 14 timeouts in unchanged
  Deck/Ink/sheet tests and one stale-module failure after the checkpoint addition.
  A fresh host run passed those cases and caught a real local-save dispatch
  regression in the new checkpoint wait. Restricting that wait to live sessions
  fixed it; all 25 navigation/grid/live-status tests passed on rerun. The keyboard
  test's unsupported query option was corrected after TypeScript rejected it;
  its four tests passed again. No timeout or performance budget was relaxed.
- Admin **81/81** and Android **258/258** passed. All three TypeScript checks and
  frontend builds passed; output was directed to `/tmp`, preserving the unrelated
  generated `dist-mobile/index.html` change.
- Rust workspace tests, workspace check and formatting passed, including the
  stale-writer/deleted-file regression. Version/crate-boundary guards, changed-file
  Prettier and diff checks passed. Changed-file lint has zero errors and 14
  warnings; running the same lint rules on HEAD confirmed all 14 already existed.
- Rendered editor: Browser plugin unavailable, so Playwright used installed
  Chrome against the actual MarkdownEditor in a disposable fixture at
  `http://127.0.0.1:14865/__bugs` (title: **Collab math keyboard QA**).
  Verified the hint, exact result once, undo, approximation, variable chooser and
  ordinary-text behavior, with no console errors or error overlay. Screenshot
  `/tmp/collab-math-hint.png` was inspected. Full-editor jsdom coverage additionally
  checks pane ownership, read-only behavior and an asynchronous paste racing edits.
- Compose config passed. Isolated smoke project
  `collab-desktop-bugs-20261019`, port 18789 and a `/tmp` backup directory reached
  the existing BuildKit `--allow=network.host` entitlement block before startup.
  No smoke success or live PostgreSQL coverage is claimed. Existing running
  servers/databases were not changed.
- Native quit/storage, encrypted-profile upgrade/blocked legacy-cache deletion,
  physical input/rendering/offline/reconnect acceptance and the broader canvas
  matrix remain open; the reported live-editing symptom passed user retest above. This batch does not establish measured performance improvements.

## Batch 9 — R03 Local Mutation Coordination (2026-10-19)

- [x] Replaced the note-only mutex registry with one native path-scope coordinator.
      Namespace reservations cover the whole vault operation, including path
      planning, reference read/rewrites, metadata/sidecars and final mutation.
      Ancestor/descendant paths and canonical aliases conflict. Disjoint vaults
      remain independent; pending namespace operations cannot be starved by newer
      overlapping writes. Guards are thread-bound, reentrant for contained helpers,
      released on error/unwind and reject nested scope expansion.
- [x] Coordinated note writes/creation, rename/move/reference updates, folder
      deletion, trash/restore/purge, generated/imported images, annotations and
      preview publication, snapshot restore/history, vault-scoped templates and
      encryption/key transitions. Absolute download/template/sheet/vault export
      destinations participate if they overlap a reserved vault namespace.
- [x] Snapshot restore uses the validating, uniquely staged note writer. Note
      creation uses atomic no-clobber publication. Reference rewrites supply the
      revision read and surface a conflict instead of discarding that result.
- [x] Added regressions for same-base writers, rename/folder-delete versus waiting
      saves, reference rewrites versus edits, competing restores, existing-file
      creation, absolute downloads, aliases, nested scope ordering, independent
      vault progress and guard cleanup after panic.
- [x] R03's app-owned coordination scope is complete. Arbitrary external writers,
      process-death recovery and partial multi-file repair now have a separate
      [explicit contract and recovery policy](./local-file-external-writer-recovery.md).
      The journal described there is planned, not shipped. Existing fingerprint
      checks still have an external check/replace gap. **Canvas live-editing symptom passed user retest; broader acceptance remains open.**

Separate finding from this batch (outside R03's mutation-ordering scope):

- [ ] **Link rewrite follow-up:** Renaming `Notes/Target.md` leaves an
      extensionless `[[Target]]` reference unchanged in the native rewrite path.
      Reference discovery and rewriting need the same unambiguous target resolver,
      including aliases, headings and duplicate basenames. The concurrency
      regression uses an explicit `[Target](Target.md)` target; it does not assert
      shorthand-wikilink rename coverage. Preserve the historical audit IDs/counts.

PR security follow-up: migrated ZIP to 9.0.5, including a manifest-only updater
2.13.1 backport so Windows ZIP updates remain available and Rust/JS versions
stay aligned. Retained upstream files have checksum guards; extraction
regressions cover the newly reported symlink and permission advisories. No Rust
audit ignore was added. See the [advisory record](../build/security-advisories.md).

End-of-batch validation:

- Desktop/scripts: **2,367 passed, one intentional skip**, after the targeted
  Tauri compatibility rerun and two added updater provenance/dependency guards.
  The first full desktop run caught a temporary resolver downgrade of the Rust
  updater; the backport restores 2.13.1 and all five compatibility checks pass.
- Admin **81/81** and Android **258/258** tests pass. All three TypeScript
  surfaces, the admin build, formatting, changed-file lint, version manifests,
  crate boundaries and diff checks pass. No performance budget was relaxed.
- Rust workspace tests, check and formatting pass with ZIP 9, including **247
  native desktop tests** and both malicious extraction regressions. ZIP 9's
  fallible entry-name APIs are handled in XLSX and hosted vault import paths.
  The patched updater also passes `cargo check -p tauri-plugin-updater --target
x86_64-pc-windows-gnu --locked`; this is compilation, not a real signed update.
- Fresh Rust audit: **zero vulnerabilities**, six documented informational
  warnings and no Rust ignores. The JavaScript security gate passes with the
  existing reproducible `braces` patch and its documented registry ignore.
- Compose config passes. Isolated smoke remains blocked before startup by the
  existing BuildKit `network.host` entitlement requirement. No smoke success or
  new live PostgreSQL coverage is claimed.

Native Windows/Wayland concurrent mutation, crypto transition, filesystem failure
and real signed-update acceptance remain open. **Canvas live-editing symptom passed user retest; broader acceptance remains open.**

## Android Compile Follow-Up — 2026-10-19

- [x] Guard the desktop-only `Webview::bounds()` query in the shared native
      `native_drop_viewport` command. Mobile keeps the command registered and returns
      an unsupported error; it does not guess a drop target using window dimensions.
      Desktop bounds and display-scale/zoom conversion are preserved.
- [x] Reconcile completed performance entries: O39 and O47 remain checked as
      implemented; O48 remains checked as superseded by R08's bounded memory cache.
      Open/partial items and their remaining native acceptance stay unchecked. UR13's
      reported live-edit/save symptom passed the user retest recorded above.

End-of-batch validation:

- ARM64 Android native release library builds successfully with the installed NDK,
  API 24 and `tauri/custom-protocol` (`--target aarch64-linux-android --lib
--release --locked`). This directly checks the platform that rejected `bounds()`;
  APK packaging, installation and physical-device behavior were not tested here.
- Rust workspace tests, workspace check and formatting pass, including all **247
  native desktop tests**. Desktop/scripts **2,367 passed, one intentional skip**;
  admin **81/81** and mobile **258/258** pass, including existing desktop native
  drop-coordinate regressions. Suites ran after implementation; timing suites
  waited for native compilation. No test budget was relaxed.
- All three TypeScript surfaces, the admin build, repository formatting,
  version/crate-boundary guards and diff checks pass. The unrelated generated
  `dist-mobile/index.html` change is preserved. No new live PostgreSQL or server
  smoke coverage is claimed for this native UI build fix.

## Performance Batch 1 — Bounded Text Merging (2026-10-20)

Scope: **O64**, with an initial **O70** synthetic measurement fixture. Follow the
audit's largest-bounded-cost tier before long-session and interaction work.

- [x] Replace duplicated desktop/server merge implementations with the portable
      `collab-live::try_auto_merge_text` engine. The server already used that API;
      the native adapter now uses it too, without a new crate or dependency edge.
- [x] Borrow lines and trim unchanged boundaries before diffing. A sparse edit in
      a 10k-line document no longer allocates a whole-document LCS table.
- [x] Bound remaining tables to 1M `u32` cells (4 MiB each, one alive at a time),
      combined input to 8 MiB/128k lines, both diffs to 2M total cells and line
      comparisons to 64 MiB. Equal/unchanged inputs use the linear fast path.
      Oversized or overlapping edits remain explicit conflicts, preserving
      current content. Different insertions at the same position also conflict;
      identical insertions are applied once.
- [x] Add regressions for UTF-8/CRLF/final newlines, repeated-line reconstruction,
      10k sparse merges, resource limits, server reconciliation and a real native
      write that must preserve disk content when the merge exceeds budget.
- [x] Add an opt-in synthetic benchmark with correctness assertions and CSV
      p50/p95 timings, 25 iterations each for 1k/10k sparse/unrelated fixtures:
      `cargo run --release -p collab-live --example text_merge_benchmark`.
- [x] End-of-batch verification and recorded measurements below.

The previous 10k-by-10k table required ~763 MiB analytically on a 64-bit target;
that allocation is now rejected before construction. This is a resource-bound
claim, not a measured process-RSS reduction. Native/encrypted-vault save latency,
cross-platform RSS and the full O70 release gate remain open. No telemetry runs
in normal app sessions, and benchmark inputs contain no user data.

### Performance Batch 1 Measurements And Verification

Synthetic portable-core timings on **2026-10-20**, Linux x86_64, Ryzen 9 7845HX,
Rust 1.99.0. Each fixture ran 25 times sequentially after compilation and test
jobs completed; the host was not otherwise isolated. Inputs were generated in
memory, so disk/cache/WebView state is outside this measurement. Exact-result
assertions passed on every iteration. Do not turn these samples into a native
latency budget or general app speedup claim.

| Fixture                           | Original p50 / p95 | Bounded p50 / p95 | Result                           |
| --------------------------------- | ------------------ | ----------------- | -------------------------------- |
| 1k lines, two sparse edits        | 8.237 / 10.881 ms  | 0.064 / 0.074 ms  | Merged                           |
| 1k lines, unrelated replacements  | 4.118 / 4.245 ms   | 3.029 / 5.244 ms  | Conflict                         |
| 10k lines, two sparse edits       | Not run            | 0.682 / 1.131 ms  | Merged                           |
| 10k lines, unrelated replacements | Not run            | 0.479 / 0.558 ms  | Conflict before table allocation |

The original baseline used `try_auto_merge_text`, its hunk type and diff helpers
extracted unchanged from commit `374ee82`, compiled with `rustc -O --edition=2021`,
and the same example harness restricted to 1k fixtures. The new implementation
used the Cargo release example. The original 10k table was deliberately not
allocated. The unrelated 1k fixture has no consistent tail-latency improvement
in this sample; bounded work and sparse edits are the established benefits.
Raw CSVs are local diagnostics under `/tmp/collab-{original,bounded}-text-merge-benchmark.csv`.

Validation:

- Full desktop/scripts: **2,367 passed, one intentional skip**; admin **81 passed**;
  Android frontend **258 passed**. Desktop/admin/Android TypeScript and the admin
  build passed. The installed patched `braces` was exposed through `NODE_PATH`;
  Vitest ran with two workers and unchanged include roots.
- Full Rust workspace tests/check and formatting passed, including **248 native
  tests** and **24 collab-live tests**, seven of them new merge regressions. The
  initial sandbox run could not bind seven native HTTP fixture listeners; the
  workspace rerun with local socket permissions passed. No disposable PostgreSQL
  URL was configured, so database-backed test bodies were not exercised.
- Version/crate-boundary guards, changed-document formatting, `git diff --check`
  and Compose configuration passed. The isolated server smoke check stopped
  before startup at the existing BuildKit `network.host` entitlement requirement.
  APK packaging, device tests, native latency/RSS and live-server acceptance were
  not performed in this batch.

## Performance Batch 2 — Deferred Views And PDF Runtime (2026-10-20)

Scope: **O01/O04**, with initial **O09/O70** artifact reporting. O02 root-modal
deferral, the remaining O03 shared-window warning and native timing gates remain
separate follow-ups.

- [x] Shell and grid use the same stable lazy registry for all document/page
      families. Root standalone chat and print views use it too, avoiding static
      backdoors into those editors. Existing save/navigation gates and file keys
      remain unchanged.
- [x] Suspense displays a pane-local loading status. Module/render failures show
      an explicit error without reloading or closing other editors. Browser
      testing found Chromium caches a failed module import URL; the recovery text
      asks users to save other work and reopen Collab rather than offering an
      unreliable import-retry button. Tests cover delayed document replacement
      and failure isolation.
- [x] `pdfRuntime.ts` pairs the legacy compatibility API with its matching worker.
      Desktop view, hover/canvas previews, cache and Android rich viewer share it;
      preview/cache paths import it only for actual PDF work. Existing reference
      counts, worker cleanup, annotations and viewer state remain in place.
- [x] Add production-manifest reporting of static JS/gzip and PDF worker bytes,
      with opt-in assertions rejecting eager view/runtime modules or two PDF
      worker assets. Counts describe assets, not live worker instances or RSS.
- [x] End-of-batch suites and final browser/bundle verification recorded below.

Baseline and changed builds use the same installed dependencies and
`node node_modules/vite/bin/vite.js build --manifest --outDir <temporary-dir>`.
Then run `node scripts/report-desktop-bundle.mjs <temporary-dir> --assert-lazy`
(omit the assertion for the original build). No chunk warning threshold or
feature compatibility build is removed to obtain the result. Native cold/warm
startup, evaluated-JS/heap measurements and first use of every editor remain open.

### Performance Batch 2 Measurements And Verification

Production artifact comparison on **2026-10-20**, using the same dependencies and
default Vite configuration. Static imports are followed transitively from the
HTML entry; dynamic imports are excluded until requested. Gzip totals compress
each JS file separately. This measures potential startup assets, not evaluated
JS, HTTP timings, WebView startup or process memory.

| Artifact          | Before              | After                           |
| ----------------- | ------------------- | ------------------------------- |
| Static JS graph   | 7,275,565 bytes     | 2,401,543 bytes (67.0% smaller) |
| Static JS gzip    | 2,160,170 bytes     | 692,526 bytes (67.9% smaller)   |
| Static JS files   | 7                   | 24                              |
| PDF worker assets | 2 / 4,624,027 bytes | 1 / 2,395,538 bytes             |

There are more small shared chunks; do not infer fewer requests or a measured
startup speedup from the byte reduction. Root modal/icon/math costs remain under
O02/O05/O06. One PDF worker asset still permits multiple live worker instances.

Validation:

- Desktop/scripts full run plus affected corrections: **2,372 passed, one
  intentional skip**. Six initially failing shell/grid assertions assumed eager
  mounting; tests now await lazy content and retain first/second-file and
  cross-vault lifetime assertions. The two affected suites pass **11 tests**;
  the final strengthened grid regression passes **9 tests**. Only those suites
  were rerun after their corrections. Optional Graph/Chats prop types were
  preserved explicitly through the lazy registry; final TypeScript passes.
- Admin **81 passed**, Android frontend **258 passed**; desktop/admin/Android
  TypeScript, desktop/admin/Android frontend builds, full Rust workspace
  tests/check, Rust formatting and full repository Prettier checks passed.
  Version/crate-boundary guards, new-file lint and diff checks passed.
  Rust database-backed test bodies were not exercised without a disposable
  PostgreSQL URL. The unchanged server smoke retains Batch 1's BuildKit
  host-network entitlement limitation; it was not rerun for this frontend batch.
- Browser plugin unavailable; used installed Playwright/Chromium on the
  production preview at `http://127.0.0.1:1425/`, **1440×1000**, with a synthetic
  vault and mocked Tauri IPC. Flow: vault picker → vault → note → actual PDF
  viewer/hover rendering → note. No PDF runtime/worker request occurred before
  PDF use. URL/title matched, content was nonblank, no framework/error overlay
  or console errors appeared in the normal flow. A separately aborted PDF chunk
  displayed the recovery message and allowed returning to the note; only the
  deliberately failed fetch/import appeared in that run's console.
  Screenshots inspected: `/tmp/collab-startup-browser.png` and
  `/tmp/collab-startup-browser-failure.png`.
- Production manifest assertions pass: all 16 view entries and the PDF runtime
  remain outside the static startup graph, and exactly one PDF worker asset is
  emitted. These reports and focused regression tests are maintained; no native
  timing budget is asserted. Native offline/chunk resolution, restored
  workspaces, every editor family, PDF annotations/export/OCR and physical
  Android worker startup remain acceptance work. **O01/O04 stay partial** until
  their remaining native checks are recorded.

## Performance Batch 3 — Startup, Bundles And Packaged Assets

Implemented **2026-10-20**, completing **O01–O09** as one category. This
supersedes Batch 2's partial implementation status; native release acceptance
remains separate. See [the maintained startup guide](../desktop/startup-performance.md)
and [budget policy](../desktop/startup-bundle-budgets.json).

- [x] **O01:** shared lazy view registry with local loading/error recovery.
- [x] **O02:** deferred settings, vault, debug and plot overlays; lightweight
      hosts retain pending tab/plot requests and allow cancellation during loading.
- [x] **O03:** remove ineffective imports; route external links through typed IPC.
- [x] **O04:** one shared compatibility PDF API and matching emitted worker.
- [x] **O05:** defer glyph registry; preserve current searches and fix plural aliases.
- [x] **O06:** common preview grammars plus deferred uncommon catalog; escaped
      unknown fences, sanitized/cancelled results and print-readiness integration.
- [x] **O07:** WOFF2-only mono/math distribution retaining all existing subsets,
      faces, preferences and variable interface fonts.
- [x] **O08:** retain bundled offline OCR; skip unchanged preparation and repair
      corruption atomically, with manifest integrity verification.
- [x] **O09:** enforce production asset budgets in desktop builds and CI;
      retain a composition report and regression tests.

Also fixes a stale print-preview window title discovered during the browser
check. Shared editor language metadata and lazy parser loaders remain intact.
The full uncommon Highlight.js catalog is intentionally deferred as a unit to
preserve embedded-language dependencies. Large deferred Mermaid/plot/language
chunks still produce normal size warnings; thresholds have not been raised.

### Measurements

Clean production output, same dependencies, static imports followed transitively
from HTML; per-file gzip. Dynamic imports enter the graph only on demand.

| Artifact                     | Previous slice      | Category complete                 |
| ---------------------------- | ------------------- | --------------------------------- |
| Initial JavaScript           | 2,401,543 bytes     | 1,197,921 bytes (50.1% smaller)   |
| Initial JavaScript gzip      | 692,526 bytes       | 350,015 bytes (49.5% smaller)     |
| Initial JavaScript files     | 24                  | 21                                |
| Packaged fonts               | 2,584,404 bytes     | 1,625,392 bytes (959,012 removed) |
| Legacy WOFF/TTF alternatives | 959,012 bytes       | 0                                 |
| PDF worker                   | 1 / 2,395,538 bytes | 1 / 2,395,538 bytes               |

Against the original audit build, initial JS falls from **7,275,565 to
1,197,921 bytes (83.5%)**; gzip from **2,160,170 to 350,015 (83.8%)**.
Final initial CSS is **274,391 bytes**, total CSS **358,364 bytes** and total
packaged assets **36,795,181 bytes**. OCR contributes **17,786,883 bytes**,
including its integrity manifest; mandatory English/worker/core assets remain.
These are asset measurements, not launch timing, evaluated-JS or memory results.
Always empty a dedicated temporary output directory: stale hashed assets from
an earlier build correctly cause package/font budget failures.

### Verification

Implementation and regression changes preceded suites; only affected checks
were rerun after corrections.

- Full desktop/scripts suite plus affected corrections: **2,383 passed, one
  intentional skip**. The full run initially found one font-audit test using a
  Vite-rewritten URL for filesystem access; the Node-environment regression now
  uses filesystem paths and passes. A further alias regression was added and
  passed. Seven corrected suites passed **15 tests**; final settings, highlighting
  and root-app checks passed **6 tests** after the last changes.
- Admin **81 passed**, Android frontend **258 passed**. Desktop/admin/Android
  types and frontend production builds passed. Full Rust workspace tests/check,
  Rust formatting, version/crate-boundary guards, full repository formatting,
  generated language/font checks and diff checks passed. Changed-file lint has
  **zero errors**; existing warning debt and the mixed event-bus/component
  fast-refresh warning remain visible. No disposable PostgreSQL URL was supplied,
  so database-backed test bodies were not exercised. The unchanged server smoke
  retains Batch 1's BuildKit host-network entitlement limitation.
- The local package-manager launcher attempted a read-only engine-store lock;
  checks used the already installed Node tool entry points, without dependency
  or manifest workarounds. Final clean Vite build and production budget gate pass;
  no ineffective-dynamic-import warnings remain. Remote CI has not been run here.
- Browser plugin unavailable; installed Playwright/Chromium production preview
  at `http://127.0.0.1:1425/`, **1440×1000**, uses synthetic vaults and mocked
  Tauri IPC. Verified deferred startup graph, icon aliases, command/settings
  shortcuts, Profile selection sent during a delayed import, common/Kotlin/unknown
  fences, math controls, print return/title restoration and real PDF rendering.
  Actual bundled WASM OCR recognized **COLLAB OFFLINE 123** (three words,
  confidence 96), with external requests blocked and no OCR requests before use.
  Normal flows had no console/error overlays. Inspected screenshots:
  `/tmp/collab-category-math.png`, `/tmp/collab-category-pdf.png`.
- Linux **WebKitGTK 2.54**, offscreen GTK3, ephemeral context and software rendering:
  all **16 view modules** evaluated successfully; note/PDF fixtures and the
  compatibility worker rendered without application errors. Inspected
  `/tmp/collab-webkit-startup.png`. This uses local HTTP and synthetic IPC;
  successful module evaluation does not establish every editor's interaction flow.

### Remaining Release Acceptance

| Check                                                                                | Status                               |
| ------------------------------------------------------------------------------------ | ------------------------------------ |
| Production asset/graph/integrity budgets                                             | Passed locally; enforced by build/CI |
| Chromium feature smoke and real offline English OCR                                  | Passed with synthetic IPC            |
| Linux WebKitGTK module evaluation and note/PDF rendering                             | Passed over local HTTP               |
| Installed Tauri asset URLs and native cold/warm startup, evaluated JS, RSS           | Open under O70/release QA            |
| Restored workspaces, full editor/PDF interactions and long-session worker/GPU memory | Open                                 |
| Windows WebView2, macOS WebKit and physical Android compatibility                    | Open                                 |

The next implementation category is **React State, Session Ownership And
Navigation (O10–O16)**. Audit checkboxes indicate delivered implementation;
the outstanding native matrix remains explicit.

## Performance Batch 4 — React State, Session Ownership And Navigation

Implemented **2026-10-20**, completing **O10–O16**. See
[session performance](../desktop/session-performance.md) for ownership, retention
and lifecycle policies. Native RSS/layout/reopen timing remains O70 acceptance.

- [x] **O10:** individual field selectors across shell/common/root surfaces;
      GridView subscribes only to its active workspace. A command-bar render-count
      regression stays unchanged across 100 cursor/scroll, sidebar-width and vault
      progress updates.
- [x] **O11:** defer editor-storage JSON encoding and writes for 300 ms, with
      identical-projection deduplication, bounded continuous-interaction staleness,
      page-hide/hidden-document flushes and metadata flush before native exit.
- [x] **O12:** bound each note/sheet/ink/deck map to 128 closed recent entries,
      plus open-file state. Trim hydration/close, promote access, migrate rename/pane
      keys and prune deleted descendants. Two thousand closed files retain 128 plus
      one pinned entry, below 16,000 JSON characters in the synthetic note fixture.
- [x] **O13:** one save-gated bulk-close transaction, preserving all tabs when
      a save fails. Opening publishes tabs/activation together; reorder stays atomic.
      The 100-tab fixture produces one notification and one flushed persistence write.
- [x] **O14:** scoped panes detach serialized controller checkpoints and unmount
      heavy views. Clean retained state has a 64-entry/16 MiB conservative UTF-16
      content/metadata budget, accounted without encoding the cache during navigation.
      Exceptional dirty/conflicted recoveries are pinned, not silently evicted. Active
      checkpoints leave the idle cache; initial reads preserve drafts and cannot replay
      an old REST baseline over a live owner. Explicit history reload remains forceful.
      Vault/lock/account/authorization boundaries purge retained plaintext and reject
      late detach callbacks; same-path vault switches replace the controller. Hosted
      restored editor metadata includes server identity. These are in-memory sessions,
      not a new crash-recovery guarantee.
- [x] **O15:** simultaneous reads coalesce by vault/path/operation/access context;
      settled/failing reads are removed. Live providers/Y.Doc/offline writers are leased
      by target, with final-release destruction and retirement of pending opens on
      logout. Lookup invalidation retires existing leases without destroying a
      provider under mounted panes; final release still destroys it. Structured origins deliver sibling edits without echoing the originator.
      REST drafts remain independent and optimistic stale writers retain their conflict
      and local content. Grid geometry uses pane keys, and global note insert/tag
      commands target the focused pane.
- [x] **O16:** local, frame-coalesced sidebar CSS geometry and one durable release
      commit; grid responsive geometry coalesces frames and keeps save-before-removal.
      Cleanup restores prior cursor/selection styles; navigation buttons have names
      and active-page semantics for accessible UI interaction.

### Verification

Suites ran after implementation; affected checks alone were rerun after fixes.
After merging #98/#100, one final integrated frontend run against the new
dependencies passed **2,401 desktop/script tests, one intentional skip**,
**81 admin tests** and **258 Android frontend tests**, with all three type/build
checks passing. The initial full run found selector-unaware App mocks, a resize
fixture assuming synchronous geometry, and a storage spy targeting the prototype
rather than the repository's storage mock; these fixtures were corrected without
weakening their assertions. Five Deck test timeouts occurred during overlapping
native compilation and passed the focused rerun without changing timing budgets.
The existing locally installed patched `braces` needed its directory exposed with
`NODE_PATH`; its security regression then passed without dependency changes.

Admin **81 passed**, Android frontend **258 passed**. The combined O10–O16
source and #100 updates also pass TypeScript and **84 focused regressions**.
Desktop/admin/Android types, production frontend builds and startup asset gate pass. Paired Dependabot #98's
full Rust workspace tests/check cover the unchanged native code under the updated
Rust dependency set. No disposable PostgreSQL URL was supplied, so DB-backed test
bodies were not exercised. Version/boundary guards, Rust formatting, generated
assets, repository formatting and changed-file lint/diff checks are recorded;
lint warnings remain visible debt. The unchanged server smoke retains Batch 1's
BuildKit host-network limitation.

Production browser flow: synthetic vault → edit → save-gated PDF navigation →
reopen note → 100-move sidebar resize → two same-file grid panes → focused insert
→ return to files → Close all tabs. Browser plugin unavailable; used installed
Playwright/Chromium at `http://127.0.0.1:1425/`, **1440×1000**, synthetic IPC and
external requests blocked. Verified saved content after teardown, zero intermediate
sidebar settings writes/one final commit, one read for two panes, independently
persisted selections, focused-only insertion and successful close-all. Page title
and URL match, content is nonblank and normal flow has no console/error overlays.
Inspected `/tmp/collab-session-grid.png`.

Linux WebKitGTK **2.54** offscreen GTK3 smoke evaluated all 16 view modules and
rendered note/PDF fixtures with the worker over local HTTP/synthetic IPC. This
checks module/worker compatibility, not the installed Tauri asset protocol or all
editor interactions. The production asset report remains inside existing budgets;
no warning threshold or performance budget was raised. Final integrated
assets: **1,235,419 bytes initial JS / 361,524 gzip**, **36,875,157 packaged
bytes**, **1,625,392 font bytes**, and one **2,418,244-byte PDF worker**.
These include the merged dependency updates; comparing them with the prior
version's artifacts alone does not isolate a native runtime improvement.

### Dependency PR Review

- **#98:** fixed Rust/JavaScript filesystem-plugin alignment; compatibility test,
  full Rust workspace tests/check, clean frontend asset build/gate, CI and both
  security scans passed. **Merged**.
- **#100:** paired the Cargo updates, held JavaScript updater at **2.13.1** to match
  vendored Rust, regenerated KaTeX CSS and corrected two TypeScript 5.9 typed-array
  annotations. Desktop **2,383 passed/one skip** after affected corrections; admin
  **81**, Android **258**, all types/builds and existing asset budgets pass.
  Browser exercised settings/icons/highlighting/math/PDF and real bundled offline
  English OCR. All fresh CI, architecture and dependency/container security checks passed;
  **merged**. The final typed-array change is annotation-only; Android types pass.
- **#97:** **not mergeable safely** despite green frontend CI. Actual native check
  fails at `src-tauri/src/lib.rs:150`: GTK 0.18's `GestureZoom` does not implement
  GLib 0.22's `FromGlibPtrNone`. JNI 0.22 also changes `JNIEnv` into `EnvUnowned`,
  requiring an Android helper migration; host/frontend checks do not cover it.
  Leave the major-update PR open for coordinated GTK/JNI/formula-engine work.

### Remaining Acceptance

Installed native cold/warm reopen, latency/RSS and layout/reflow profiles,
long-session renderer/worker retention, tray/suspend and real-server offline/live
reconnect across target platforms remain open. Browser checks use synthetic local
IPC; live sibling/provider behavior and REST conflicts use controlled unit
transports. Source-byte budgets and notification counts do not prove native
speedups. The next implementation category is **Vault Listing, Indexing And
Search (O17–O28)**.

## Performance Batch 5 — Vault Listing, Indexing And Search

Implemented **2026-10-20**, completing **O17–O28**. See
[architecture, tradeoffs and acceptance](../desktop/vault-listing-performance.md).

- [x] **O17/O18:** coalesced path deltas, old/new rename/removal reconciliation,
      unknown-scope forced fallback, generation ownership and two native worker slots.
- [x] **O19/O20:** disposable encryption-aware search records, query-time source I/O
      elimination, paged results/excerpts and stable score/path ordering.
- [x] **O21/O22/O23:** incremental reverse links, UTF-8 slice wikilink scanning,
      shared native note records and changed-metadata IPC delivery.
- [x] **O24/O25:** visible-row windowing, keyboard focus/selection/drop attributes,
      immutable-revision file/asset/manifest maps and ancestor-only tree patches.
- [x] **O26/O27/O28:** revision-cached bounded attachment readers, generated watcher
      suppression/pruning, cancellable blocking native work and indexing progress.

### Validation

The full desktop/scripts run completed: **2,401 passed, seven timing-budget
failures, one intentional skip**. The unchanged Ink/Sheet timing files and Sheet
shape fixtures passed affected reruns after native compilation/parallel load
settled; no budgets were raised. Final delta/tree/UI regressions and types pass;
two additional regressions added during review pass in focused runs. Admin **81**
and Android frontend **258** pass, all three types/builds pass, and production
asset budgets pass unchanged. Rust workspace tests/check pass; the final native
library run is **253 passed/one opt-in measurement ignored**, with that
measurement also run explicitly. PostgreSQL integration is not claimed without
a disposable database. Version/crate guards, formatting and changed-source lint
pass (zero errors; existing hook warnings remain).

The first native run exposed stale updater permission metadata pointing into a
removed temporary dependency-review checkout. Rebuilding that package's generated
artifacts corrected the environment; no dependency versions changed.

The explicit optimized-debug **10,000-note** fixture measured: cold index **462ms**,
one-note edit **5ms / one source read**, warm query **2ms / 50 results / 10,000 total**.
The changed metadata delta was **246 bytes**, versus **1,988,880 bytes** for full
metadata. Retained source/folded text totaled **757,768 bytes**; shared snapshot
lock acquisition measured **211ns** in this uncontended fixture. These values
exclude allocator/map overhead, process RSS and installed IPC round trips.
Repeated warm queries read zero source files; persisted-cache startup also avoids
source reads in the regression fixture. Slice wikilink parsing eliminates the
former whole-note four-byte-per-character vector; it retains only target strings.

Regular Playwright/Chromium was used because the Browser plugin is unavailable.
Rendered checks mounted **36–44 rows** for 10,000 files, exercised keyboard
navigation, result paging, internal file-to-folder dragging, and confirmed
**zero additional board reads** after an unrelated file change. **10,000 asset
lookups among 10,000 files took 34.2ms**, including first index construction.
A Linux notify integration test verified external atomic saves/renames with
ignored-directory pruning enabled. Timing values are synthetic local observations,
not release promises.

Hosted search retains its existing 50-result server API boundary. The local
in-memory content index trades retained text memory for zero query-time source
reads; lower total RSS is not claimed. Installed latency/RSS, screen-reader
behavior, real OS drops and native Windows/Linux/macOS/Android acceptance remain
open under O70. The following **Markdown, Math And Graph (O29–O36)** category is recorded in Performance Batch 6 below.

## UI Flicker Follow-Up — UR15

Implemented **2026-10-20** after the O10–O16 report. Routine tree/sidebar/view and
settings-category content no longer fades from transparent or stacks entrance
animations. Document refresh pulses cannot restart a document entrance when they
clear. Menu and hover/selection motion remain; document/vault/pane keys and save
boundaries are preserved.

Modal follow-up **2026-10-20**: the user confirmed most routine flicker is gone
but settings and editor builders still flash. Shared dialogs/backdrops no longer
fade/scale, and Settings no longer adds its own entrance. Cold Settings loads
previously animated both the temporary loading dialog and the replacement.

- [x] Remove shared dialog/backdrop entrance/exit fades and Settings’ extra fade.
- [x] Verify cold/repeated Settings and math/table builders in Chromium and
      offscreen Linux WebKitGTK **2.54.1**: opacity stays at **1**, no modal
      entrance animations. Escape (Chromium) and close buttons (WebKit) dismiss
      all three. Synthetic IPC/software rendering; native acceptance remains open.
- [x] Modal batch checks pass: desktop/scripts **2,411 passed / one intentional
      skip**, admin **81 passed**, Android frontend **258 passed**, Rust workspace
      **712 passed / one ignored benchmark**; workspace check, desktop/admin
      builds, all three frontend type checks, changed-source lint, formatting,
      crate/version guards and production asset budgets pass. No live PostgreSQL
      integration or installed native compositor acceptance is claimed.
- [ ] Installed native confirmation of modal opening/compositor behavior.

- [x] Remove routine whole-content/list entrances and unused keyframes.
- [x] Add stable-editor DOM/provider coverage for sidebar and appearance changes.
- [x] Reproduce and verify folder/view/settings interactions with regular
      Playwright because the Browser plugin is unavailable: effective opacity
      **0 before / 1 after**, no runtime errors. Synthetic local IPC is used.
- [x] Repeat the same interactions in offscreen Linux WebKitGTK **2.54.1**:
      30 frame samples per action remain at effective opacity **1**. The test
      uses software rendering and synthetic IPC; it is not installed-app/GPU
      certification.
- [ ] Installed native/user confirmation, including platform compositor behavior.

Validation on the merged O17–O28 base: desktop/scripts **2,411 passed / one
intentional skip** (bulk suite plus the 45 timing/shape checks run separately
without concurrent native compilation); admin **81 passed**, Android frontend
**258 passed** after an isolated rerun of one calendar timeout from the concurrent
build run. All three frontend types/builds, Rust workspace tests/check/fmt,
crate/version guards, formatting and production asset budgets pass. Changed-source
lint has zero errors and existing hook warnings. Both rendered interaction
checks use current integrated sources; Chromium records no runtime errors.
No PostgreSQL integration or installed GPU/compositor certification is claimed.

## Markdown Layout And File Link Previews — UR16–UR18

Requested **2026-10-20**; implementation and repository/rendered checks complete.
Installed native acceptance remains open.

- [x] UR16: bound math/merge dialog height and width, keep header/footer actions
      reachable, scroll content and wrap long merge text without changing
      reconciliation semantics.
- [x] UR17: share file-tree document/PDF/image previews across Markdown edit and
      read modes, including wikilinks and encoded filenames. Preserve embedded
      images and website-fetching controls; reuse the existing cache/queue paths.
      Keep hover anchors stable and discard obsolete results.
- [x] UR18: remove source-line-derived code widget minimum heights and preserve
      blank code lines. Mermaid keeps its separate diagram sizing.
- [x] Chromium: math/merge bounds, reachable controls and math Apply at
      **1440×900, 800×600, 390×700 and 640×360**. Merge Escape protection remains.
      Code blocks grow/shrink through **1/13/60/13/1 lines** at **14/20/28 px**
      without accumulated space. Reading/editing link hovers use the shared
      document/PDF/image loaders, including with website fetching off.
- [x] Offscreen Linux WebKitGTK **2.54.1**: math/merge bounds, body scrolling and
      reachable footer controls at **1250×850 and 640×360**; naturally sized code
      blocks; reading/editing file-link hovers with working resize dismissal.
      Rendered checks use synthetic IPC; WebKit uses software rendering.
- [x] End-of-batch checks: desktop/scripts **2,433 passed / one intentional skip**
      (full suite plus affected reruns, with ink timing isolated at its unchanged
      budget); admin **81 passed**; Android frontend **258 passed**; Rust workspace
      **712 passed / one ignored benchmark**, workspace check. All frontend
      types/builds, asset budgets, formatting, changed-source lint (zero errors,
      existing warnings) and crate/version guards pass. No live PostgreSQL
      integration run.
- [ ] Installed native testing: math/merge at small window sizes and display
      scaling; long code blocks with user fonts/zoom; local/hosted/offline file
      link hovers. Existing O40 image thumbnail/O41 native cancellation work stays
      open.

## Verification Boundary

Finish the batch before running the repository suites and regression checks.
Run them at the end, with targeted reruns only for failures or later corrections. Keep timing
tests separate from first-time native compilation. Tests that bind localhost or
spawn child CLIs require a host environment allowing those operations; an EPERM
is not product failure. Browser/jsdom success does not establish native drag,
GPU, memory, scrollbar, Windows or Wayland acceptance.

Server smoke checks must use a disposable Compose project/port. The first attempt
here was stopped by the existing BuildKit `network.host` entitlement requirement
before starting the server; smoke success is not claimed. Do not tear down a
user's running project to work around that gate.

## Performance Batch 6 — Markdown, Math And Graph

Implemented **2026-10-20**, completing **O29–O36**. See
[implementation, resource budgets and rendered evidence](../desktop/markdown-math-graph-performance.md).

- [x] O29: immutable editor transactions with bounded string checkpoints,
      immediate dirty state and save/remote/merge/retention flushes. Keep external
      adoption separate from local acknowledgements and preserve live ownership.
- [x] O30: retain sanitized preview blocks, diagrams, highlighted code, asset jobs
      and stable plot keys across unrelated edits; revalidate changed asset revisions.
- [x] O31: bounded cancellable workers for math solving/sampling, stale-result
      guards, timeout/errors, reusable workers and bounded sample cache.
- [x] O32/O33: invalidation-only WebGL, visibility suspension, three-renderer /
      six-million-pixel aggregate budget, activation recovery and retained camera.
- [x] O34/O35: worker graph layout, incremental adjacency, stable node/link joins,
      preserved camera/selection, functioning search and keyboard node activation;
      500-node/5,000-edge visualization limit.
- [x] O36: background-sliced posting index, ranked top-k search and bounded LRU.
- [x] Regression coverage for transaction/undo/stale async boundaries, resource
      retention, renderer budgets, graph identity and icon ranking/cache size.
- [x] Integrated Chromium/software-WebGL and Linux WebKitGTK 2.54.1 checks with
      real workers and synthetic IPC. Resource identities survive text edits;
      500 graph nodes retain layout/camera; 12 plots stay within three canvases
      with zero idle redraws in the sampled interval.
- [ ] Installed platform/IME, native GPU/context recovery, and representative
      CPU/RSS/latency acceptance remain under O70. Browser/jsdom evidence does not
      certify those boundaries.

End-of-batch validation: the desktop/scripts suite and affected correction
reruns pass; the two ink timing-budget failures in the concurrent run pass in an
isolated rerun. Admin **81 passed**, Android frontend **258 passed** after fixing
one unrelated assertion that mistook a random cell ID containing `2400` for a
persisted computed value. Rust workspace **712 passed / one ignored benchmark**;
workspace check/fmt, frontend types/builds, asset budgets, lint (zero errors),
formatting and crate/version guards pass. One intentional desktop test remains
skipped. No live PostgreSQL integration or installed/native GPU certification is
claimed. Existing generated `dist-mobile/index.html` changes remain unstaged;
the Android frontend build used a temporary output directory.

Next:
**Previews, PDF, Images And OCR (O37–O41)**, with O39 already implemented.
