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

## Next Batches

1. Cache-first file/annotation/preview reads and automatic offline-copy freshness
   (UR02/UR03), including pending-edit precedence, partial failures and revision
   publication to mounted views. Batch 2 repairs read/notification/checkpoint gaps; finish the remaining
   native acceptance and source-byte/preview paths above.
2. Canvas save/conflict/live recovery and measured rendering/serialization work
   (UR12/UR13, O52/O59/O60); reproduce remaining failures with authoritative reopen
   checks. Preview scheduling/latency (UR04) belongs with that workload.
3. Rich rendered internal thumbnails (UR05), shared component consistency
   (UR06), dynamic sidebar context (UR09), and remaining native drop/scroll/viewer
   acceptance. Mobile drawing-mode reconciliation (UR11) belongs to the Android
   batch; `.ink` already uses the shared tool model.
4. Remaining desktop investigations/optimization opportunities, ranked by native
   measurements. Web and Android audits retain their separate implementation
   backlog rather than being marked complete by shared helper changes.

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
