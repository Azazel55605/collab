# Desktop Audit Fixes

Started **2026-10-14**. Status: **In progress**. This tracks implementation of
the [desktop audit](../audits/desktop-performance-and-bugs-2026-10-14.md) and
[reported regressions](../audits/reported-regressions-2026-10-14.md). Original
audit counts/IDs remain historical inventories; implementation evidence belongs
here and in [Open Development Work](./open-development-work.md).

## Batch 1 — Save And Viewer Correctness

| Finding    | Implemented change                                                                                                                                                                                                                                                        | Remaining acceptance                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B01 / UR13 | Tab open/switch/close, page navigation and vault open/close wait for registered dirty document controllers. Write failure/conflict keeps the editor mounted; acknowledged native offline queues permit leaving. A subsequent edit clears the older queue acknowledgement. | Process quit/death and durable draft recovery; live-save lifetime; remaining intermittent canvas failures beyond navigation.                                             |
| B02        | Search excerpts map lowercase byte positions back to original Unicode character indices and clip by characters.                                                                                                                                                           | Native UI search across representative scripts; Rust regression tests cover CJK, emoji and expanding lowercase.                                                          |
| B03        | SearchPanel invalidates old asynchronous results on query/vault change and unmount.                                                                                                                                                                                       | Native search interaction QA; regression covers reversed responses and cleared input.                                                                                    |
| B04        | PdfView retains/destroys loading tasks on errors and unmount; canvas PDF preview enters cleanup before awaiting load.                                                                                                                                                     | Repeated native open/close resource soak and corrupt/slow PDF fixtures.                                                                                                  |
| B05        | Race-safe native subscription helper used by filesystem collaboration transport, shell file events, PDF watcher and collaboration lifecycle/chat events.                                                                                                                  | Native lifecycle soak; delayed registration regression verifies late cleanup and ignored callbacks.                                                                      |
| B06        | Local document/sidecar writes use unique sibling staging files, flush their data and persist atomically.                                                                                                                                                                  | Windows/Wayland storage/rename-failure QA; Rust test preserves a pre-existing same-stem `.tmp` while concurrent writes use different extensions.                         |
| B07        | Local PDF preview writes carry SHA-256 of the bytes rendered; native revision check rejects writes for changed sources.                                                                                                                                                   | Slow-render replacement test on native storage; broader sidecar publish/cache-retention investigation remains.                                                           |
| B08        | Canvas scale can drop below 0.5; rounded backing dimensions also obey the pixel ceiling.                                                                                                                                                                                  | Large-display/GPU QA; unit tests include oversized surfaces and ceil-rounded dimensions.                                                                                 |
| UR01       | Bounded client-local PDF page/zoom/layout/rotation/bookmark settings survive viewer remounts, including hosted files; persistence is debounced and storage failures are tolerated.                                                                                        | Scroll/pan restoration, avoiding unnecessary source/worker reload, local/hosted/Android native interaction matrix.                                                       |
| UR07       | One native drag coordinate source with window fallback; duplicate path events are collapsed. File tree resolves visible row geometry, including a file's parent folder, instead of portal-sensitive DOM hit testing.                                                      | Reported on **Windows and Linux/Wayland, with and without scaling**. Native coordinate/monitor matrix and target highlighting remain required before closing the report. |
| UR08       | Collaboration panel replaces its legacy Chat tab with an action opening the current Chats workspace. Persisted old tab selection falls back to Peers. Existing stored chat data is preserved.                                                                             | Navigation and notification compatibility QA.                                                                                                                            |
| UR10       | Kanban columns are constrained to available height; nested flex children can shrink and the cards area scrolls with stable scrollbar space.                                                                                                                               | Native scrollbar/drag auto-scroll and touch matrix.                                                                                                                      |

This batch does **not** close the complete desktop backlog or every reported
symptom. Tests establish specific behavior, not proof that every intermittent
save or platform issue is solved.

## Next Batches

1. Cache-first file/annotation/preview reads and automatic offline-copy freshness
   (UR02/UR03), including pending-edit precedence, partial failures and revision
   publication to mounted views. Existing cache-first/reconciliation code needs
   end-to-end regression scenarios before replacement.
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
