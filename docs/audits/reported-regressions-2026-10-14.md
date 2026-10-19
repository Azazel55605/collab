# Reported Regressions And Audit Reconciliation

Reported and checked against source: **2026-10-14**. Baseline: `4231413`
(application code matches `c9fbdb7`; the later commit adds the mobile audit).
This supplement reconciles **14 user reports** (13 initially reported on
2026-10-14, plus the math-shortcut report on 2026-10-15) with the
[desktop](./desktop-performance-and-bugs-2026-10-14.md),
[web](./web-interface-performance-and-bugs-2026-10-14.md) and
[Android](./mobile-performance-and-bugs-2026-10-14.md) audits.

These are reported regressions and requested behavior, not newly reproduced
platform bugs. The source checks below describe the historical baseline; the implementation
checklist records subsequent fixes separately from native/platform sign-off. Existing audit IDs and counts
remain unchanged to avoid counting overlapping findings twice. UR01–UR14 are
the follow-up tracker, including reports missing from the original inventories.
Platform scope below is provisional where the report did not name one.

## Current Implementation Checklist

Updated **2026-10-15** through desktop batches 1–7. `[x]` marks the listed
**desktop implementation**, not all-platform acceptance. Preserve the remaining
acceptance below and update this checklist alongside future fixes. Detailed
changes and automated verification live in
[Desktop Audit Fixes](../plans/desktop-audit-fixes.md).

- [x] **UR01 desktop:** PDF page/zoom/layout/rotation/bookmark/scroll state survives
      remounts; bounded resources reuse unchanged sources. Native large/corrupt-file
      soak, renamed/replaced files and Android behavior remain acceptance/work.
- [x] **UR02 desktop:** Cache-first documents/assets/annotations/previews with
      revision-aware background refresh and pending-edit protection. Native
      connected-but-unreachable/offline authorization and Android acceptance remain.
- [x] **UR03 desktop:** Replica reopening preserves offline intent/checkpoints;
      native sync publishes view refreshes; concurrent sync coalesces and partial
      downloads fail visibly. Native reconnect/cross-process and Android work remain.
- [ ] **UR04 partial:** Bounded preview queues, cache-first hosted rendering,
      scoped bounded SVG cache, shared PDF pipeline and atomic local preview records
      implemented; corrupt/legacy records regenerate. Measured native
      cold/warm latency, image thumbnails and remaining cancellation work are open.
- [ ] **UR05 partial:** Spatial canvas/logic, Kanban columns/cards and themed deck
      layout rendered. Deck images/charts/tables remain placeholders; full-fidelity
      per-format rendering is open.
- [ ] **UR06 partial:** Visible legacy controls in desktop editors migrated to
      shared primitives; full component/accessibility inventory and mobile remain.
- [x] **UR07 desktop:** External OS drop coordinates and target-area mapping
      corrected. **User confirmed working**; broader monitor/platform release QA
      remains.
- [x] **UR08 desktop:** Legacy Collaboration Chat tab now opens the Chats
      workspace; persisted old selection falls back to Peers. Existing data retained;
      mobile equivalents still need inspection.
- [ ] **UR09 partial:** Shared sidebar Tabs, per-vault file-tree state and active
      document ancestor/filter/trash context corrected. Broader view-dependent
      sidebar behavior still needs native acceptance.
- [x] **UR10 desktop:** Kanban flex height constraints and scrolling card region
      implemented. Native scrollbar/drag auto-scroll/touch acceptance remains.
- [ ] **UR11 open:** Android stale drawing modes remain mobile work.
- [ ] **UR12 — needs final testing:** Canvas gesture serialization, bounded
      hydration and pixel limits implemented. Native CPU/heap/GPU profiling and
      large-board interactions remain; do not close the performance report yet.
- [ ] **UR13 — needs final testing:** Load/save/navigation guards, coalesced live
      checkpoints, semantic REST/live JSON comparison and connection ownership fixes
      implemented. Repeated edits/save/navigation/reopen must be confirmed with
      **both rebuilt desktop and server**. Process quit/death recovery remains open.

- [x] **UR14:** User retest on 2026-10-19 confirms evaluation works again;
      no original cause is claimed. Added a muted inline shortcut hint in active
      editable math blocks, real-editor keyboard/undo coverage, pane-owned variable
      choices and read-only/stale-result guards. Native keyboard-layout acceptance
      remains a release check.

Android counterparts of UR01–UR06/UR08–UR10 and web-specific consistency work
are not closed by desktop checkboxes. The original source inventory follows.

## Coverage And Priority

| ID        | Report / likely scope                                                                                | Previous coverage                                                                                                                                                      | Added tracking                                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UR01 / P2 | PDFs reload/reset zoom and state on switching; desktop and mobile                                    | Desktop B04 covers worker lifetime; O11/O12 cover other viewer state; Android MR08/MO11–14 cover PDF resources. None explicitly tracks this PDF navigation regression. | Preserve per-document viewer state independently of remounted renderers; investigate hosted/local differences and reload costs.                                           |
| UR02 / P1 | Files ignore downloaded/offline copies; cached-first loading requested; desktop/mobile               | Desktop O37 and Android MO14/MO23/MO28–30 touch asset/cache costs. Cache failure policy is Android MR02.                                                               | Explicit cache-first, revision-aware revalidation and pending-edit precedence across every file format.                                                                   |
| UR03 / P1 | Downloaded vault caches do not update automatically; desktop/mobile                                  | Desktop O68 and Android MO24–28 cover synchronization cost; Android MR01 covers partial availability.                                                                  | Treat failed automatic freshness as a regression, with completion/failure visibility and a reconnect/background test matrix.                                              |
| UR04 / P1 | Previews take too long; desktop/mobile where implemented                                             | Desktop O38–44/O59 and Android MO03/MO14/MO30 cover scheduling, reads and memory.                                                                                      | Add measured cold/warm preview latency and responsiveness acceptance; trace cache hits, server generation and bridge/renderer stages.                                     |
| UR05 / P2 | Internal previews show basic content; proper rendering requested; shared renderer/server/clients     | Existing audits recognize internal previews but do not specify richer fidelity. This was previously deferred expansion work.                                           | Add a requested visual-rendering enhancement with per-format fidelity, bounded rendering and versioned cache acceptance.                                                  |
| UR06 / P2 | Stale/native-looking controls; use shadcn/shared styled components; all UIs                          | Web WO42 and Android MO47 address primitive/accessibility debt. Neither is a complete consistency inventory.                                                           | Explicit cross-surface component migration, including desktop dialogs/toolbars/menus and mobile controls.                                                                 |
| UR07 / P1 | External drag/drop targets random folders across systems; desktop                                    | Existing tree/drag optimization entries do not track positional misrouting.                                                                                            | Native coordinate/scale/hit-test regression with platform and monitor matrix and truthful target highlighting.                                                            |
| UR08 / P2 | Old chat remains in Collaboration menu; desktop, mobile equivalents to inspect                       | Audits cover chat costs and new Teams navigation, not removal/reconciliation of the legacy entry.                                                                      | Explicit navigation cleanup and migration decision; preserve any deliberate vault-specific channel functionality.                                                         |
| UR09 / P2 | Sidebar does not update with the current view; desktop primarily                                     | Desktop O10 covers subscriptions, not navigation correctness.                                                                                                          | Track page/tab/document-aware sidebar selection and capability refresh, including switching from Chats.                                                                   |
| UR10 / P2 | Long Kanban columns lack a scrollbar; desktop/mobile                                                 | General list/rendering bounds do not cover column overflow.                                                                                                            | Track bounded column height, usable vertical scroll and drag auto-scroll across pointer/touch platforms.                                                                  |
| UR11 / P2 | Mobile drawing exposes stale drawing modes; Android                                                  | Android MO20/MO47 cover rendering/input; current `.ink` already uses the shared tool model.                                                                            | Inventory exact drawing/annotation surfaces and reconcile obsolete modes with the current shared model.                                                                   |
| UR12 / P1 | Canvas has severe performance problems; desktop, Android viewer separately                           | Desktop O52/O59/O60 and Android MO17 already cover major related costs.                                                                                                | Upgrade from a tuning opportunity to an observed regression requiring representative-scene profiling and budgets.                                                         |
| UR13 / P1 | Canvas frequently fails to save; desktop editable canvas primarily                                   | Desktop B01 covers pending-edit loss broadly; O52 covers serialization; Android MR03 covers durability generally. No explicit canvas save-failure entry exists.        | Dedicated persistence/recovery investigation; highest-priority follow-up with UR02/03 and data-loss findings.                                                             |
| UR14 / P2 | Formula evaluation via keyboard shortcut in math blocks fails; desktop Markdown editor provisionally | Desktop O31 concerns math solver cost, not shortcut dispatch. Direct command tests do not establish keyboard-event behavior.                                           | Reproduce with focus/caret in a math block; trace shortcut registration, precedence and event handling, then verify the result and undo behavior through the real editor. |

## Source Checks And Acceptance Targets

### UR01 — PDF View State And Switching

[AppShell](../../src/components/layout/AppShell.tsx) mounts the active document
with a key based on tab type/path and switches the rendered view. PDF objects
and renderers therefore reload when their component remounts.
[PdfView](../../src/views/PdfView.tsx) initializes zoom/page/layout locally and
resets them during load. It already restores local sidecar viewer state;
however, hosted serialization explicitly omits `viewerState`, and its separate
viewer-state persistence is gated by native filesystem support. Do not describe
this as all desktop PDF persistence being absent.

The [Android PDF viewer](../../apps/mobile-android/src/screens/RichFileViewerScreen.tsx)
also owns page/zoom/layout in component state and resets page on load; mobile tab
switches unmount screens. Keep viewport state in a bounded identity-scoped client
store, distinct from shared annotations and heavy PDF worker/cache lifetime.

Acceptance: PDF A → another document/view → A retains page, zoom mode/value,
rotation, layout and scroll/pan as appropriate. Test local/hosted/offline files,
rapid switching before a delayed state write, renamed/replaced files and
Android orientation. Preserve annotations and verify worker/memory bounds; a
faster switch must not retain every PDF indefinitely.

### UR02 — Cache First, Revalidate On Change

[HostedVaultClient](../../src/lib/vaultClient.ts) already returns cached text
documents and refreshes their cache in the background. Asset reads also check
cached bytes, but first resolve manifest/current content; PDF annotation reads
and internal preview reads have additional online paths. A cached return alone
does not prove a mounted view receives a refreshed revision. Android
[asset](../../apps/mobile-android/src/lib/assets.ts) and
[note](../../apps/mobile-android/src/lib/notes.ts) helpers attempt network reads
first while connected, then fall back to cache.

Trace the entire open pipeline, including metadata/annotations, instead of
simply adding another cache to a path that already has one. Acceptance: a
downloaded file opens promptly without waiting for a slow server; unchanged
revision causes no body download/reparse; changed revision updates safely in the
background. Preserve pending edits, annotations and reader position, disclose
staleness/failures and enforce the existing authorization/offline policy. Test
every supported format with airplane mode and a connected-but-unreachable host.

### UR03 — Automatic Offline-Copy Freshness

Desktop [auto reconnect](../../src/lib/useServerAutoReconnect.ts) already
reconciles connected-server inventories at a nominal five-minute cadence;
[serverStore](../../src/store/serverStore.ts) invokes offline-copy refresh after
loading that inventory. Android [store](../../apps/mobile-android/src/state/store.ts)
has sequence/cooldown/in-flight checks and refresh-on-inventory/background-event
paths. This report therefore requires following scheduling, manifest freshness,
cache-body completion and publication, not claiming automatic refresh is absent.

Acceptance: change an already downloaded vault from a second client while the
first stays connected, then while it is backgrounded/offline. Verify additions,
updates, moves, deletions and assets converge after the next allowed sync/resume
without manual reopening. Surface partial failures and last successful refresh;
do not advance a completeness claim when bodies failed. Protect unsynced edits
and respect metered/battery/permission policies.

### UR04–UR05 — Preview Latency And Visual Fidelity

[documentPreview](../../src/lib/documentPreview.ts) deduplicates concurrent
requests, and native/server caches exist. The shared
[renderer](../../crates/collab-documents/src/preview.rs) deliberately produces
bounded basic SVG/content summaries without running editors, formulas, network
assets or scripts. Richer thumbnails are a newly requested extension, not proof
that the original account/preview plan was never implemented.

Profile hover/list/canvas previews separately: cache lookup, manifest lookup,
source transfer, generation, IPC encoding, decode and display. Define measured
cold/warm latency targets on representative hardware; compare against current
results before assigning numerical budgets. Share prioritized/cancellable work
and versioned results across consumers; a warm preview should not reread the
whole source or regenerate an unchanged revision.

For richer rendering specify fixtures for Markdown layout, sheet cell
formatting/value display, deck slide composition, ink geometry, canvas nodes,
Kanban layout and circuit geometry. Reuse portable rendering/model contracts
where feasible, with server generation for hosted files and cache keys including
source revision, renderer version and size variant. Bound time/pixels/memory and
handle unsupported/malformed content honestly. Verify visual fidelity, asset
policy, pending local edits and invalidation after renderer upgrades.

### UR06–UR09 — Components, Navigation And Drop Targets

Raw controls still exist in [CollabPanel](../../src/components/collaboration/CollabPanel.tsx),
[Sidebar](../../src/components/layout/Sidebar.tsx) and mobile
[UI](../../apps/mobile-android/src/components/ui.tsx)/screen implementations.
Being a raw element is not automatically a bug: generated/shared primitives
ultimately render such elements too. Audit application-level controls against
the [UI guide](../desktop/ui-guide.md), migrating bespoke chrome to
`src/components/ui` or deliberately shared custom controls with the same visual
and accessibility contract. Keep mobile touch sizes/IME behavior and test
dialogs, selection controls, focus, errors, dark/light themes and density.

The desktop [native-drop hook](../../src/components/vault/useNativeFileDrop.ts)
divides coordinates by devicePixelRatio, listens to both window/webview events,
and deduplicates near-identical drops.
[FileTree](../../src/components/vault/FileTree.tsx) selects the destination using
`elementFromPoint` and the nearest folder attribute; missing hits fall back to
root. Coordinate conversion exists already. Reproduce mismatches under mixed
monitor scaling, compositor/platform coordinate origins, WebView zoom, scrolled
trees, overlays and duplicate native events. Log source coordinates, effective
scale, CSS hit target and chosen folder without exposing file contents.
Acceptance: highlight and committed folder agree, exactly one import occurs,
and dropping on a file/blank area follows a documented destination rule.

CollabPanel still renders a **Chat** tab through the legacy ChatPanel, while the
new Chats workspace exists. Reconcile that entry explicitly: remove or redirect
obsolete navigation, or label intentional vault chat distinctly. Preserve
history/permissions and notification routes; hiding a tab is not a data migration.

Sidebar selects content from `sidebarPanel`; AppShell separately routes
`activeView` plus editor tab type and hides the normal sidebar for Chats. Test
transitions across all views and active documents rather than mapping only one
store. Acceptance: correct context, selected item, available actions and folder
reveal update immediately after view/tab/vault/permission changes without an
unrelated click or refresh. Avoid resetting deliberate user panel choices on
every render.

### UR10–UR11 — Kanban Scrolling And Mobile Drawing

[KanbanColumn](../../src/components/kanban/KanbanColumn.tsx) already declares
`overflow-y-auto`; [KanbanBoard](../../src/components/kanban/KanbanBoard.tsx)
uses nested flex layouts, an overflow-hidden vertical viewport and start-aligned
columns. Check actual height/min-height constraints and computed overflow,
including overlay scrollbar settings, rather than adding a redundant overflow
class. Test hundreds of cards, touch/wheel/keyboard scroll, visible/reachable last
card, independent columns, add-card controls and drag auto-scroll. Inspect
[mobile Kanban](../../apps/mobile-android/src/screens/KanbanScreen.tsx) separately.

[InkScreen](../../apps/mobile-android/src/screens/InkScreen.tsx) and
[InkTouchCanvas](../../apps/mobile-android/src/components/InkTouchCanvas.tsx)
already use the shared ink tool/capture/render model. The report does not yet
identify which old modes or drawing/annotation surface remain exposed. Record
the exact labels/routes during device reproduction; reconcile them with the
shared supported-tool matrix. Verify finger pan/draw, pen buttons, eraser,
pinch/selection, old drawing documents and annotations without removing intended
input settings merely because they look old.

### UR12–UR13 — Canvas Performance And Save Reliability

[CanvasPage](../../src/views/CanvasPage.tsx) combines ReactFlow nodes, previews,
viewport and collaboration state. Existing audit O59/O60 tracks expensive
previews and repeated conversions; these now have a reported user-visible
performance symptom. Profile drag/pan/selection/editing, preview fan-out,
serialization, subscription commits and live document reconciliation using
representative scenes. Record scene/asset sizes, frame latency, peak memory and
save latency on affected systems; Android's canvas viewer has a separate scope.

[useCanvasDocumentSession](../../src/components/canvas/useCanvasDocumentSession.ts)
already uses the document session controller, expected versions, dirty-state
tracking and interaction-paused autosave. A save failure is not evidence that
there is no autosave. Follow interaction pause/resume, local-change marking,
write/conflict responses, pending writes on switching/closing, live/offline
reconciliation and error presentation. This extends desktop B01 with an explicit
canvas persistence investigation.

Acceptance: make node, edge, text, position and viewport changes; save and verify
the authoritative document after reopen and application restart. Repeat during
drag-end, rapid tab switching, live collaboration, offline replay, write denial,
conflict, storage full and process interruption. No falsely clean/saved state;
retain recoverable content and explain blocked saves. Compare serialized content,
not just a toast or tab dirty marker. Do correctness work before tuning away
serialization or retaining more renderer state.

### UR14 — Math-Block Evaluation Keyboard Shortcut

Reported **2026-10-15**: evaluating a formula through the keyboard shortcut in a
math block does not work. **Retest 2026-10-19:** the user confirms it works again;
rendered-editor Ctrl+Enter also works. No root cause for the transient report is
claimed. The requested follow-up is an inline, muted shortcut hint while editing
a math block, now implemented with keyboard/undo and read-only regression coverage.
This concerns Markdown math blocks, separately from spreadsheet runtime fixes.

[mathBlockCommands](../../src/components/editor/mathBlockCommands.ts) registers
`Mod-Enter` for evaluation and `Mod-Alt-Enter` for approximate evaluation
(Ctrl on Windows/Linux, Cmd on macOS). Existing direct-command tests establish
solver behavior, not successful keyboard dispatch in the running editor.
Investigate focus/caret and math-block detection, keymap precedence, competing
handlers and event propagation before assigning a cause.

Acceptance: focus an editable math block and trigger evaluation with the
configured shortcut; verify the expected result appears once and can be undone.
Cover exact/approximate commands, rendered versus source-editing focus, selection
and non-math context, and read-only behavior. Add keyboard-event integration
coverage and reproduce on the affected desktop platform; preserve normal Enter
handling outside math blocks. No implementation or platform sign-off yet.

## Follow-Up Order And Validation Boundary

Start with UR13/UR02/UR03 and existing data-loss findings, then UR07 targeting,
UR01 state retention and UR12/UR04 measured performance. UR05 rich previews,
UR06 component consistency, UR08/UR09 navigation and UR10/UR11 input/overflow
follow as scoped work with regressions covered. Track UR14 math-keyboard
evaluation as an additional editor correctness fix. This ordering is triage, not a
replacement feature plan or a claim that fixes have begun.

The initial reconciliation checked source and audit coverage for 13 reports;
the 2026-10-15 update adds UR14 without changing the original audit IDs/counts.
Documentation checks cover
links, finding IDs and formatting. No app code changed; existing suites were not
rerun for this documentation-only reconciliation. Runtime reproduction on the
affected platform remains required, particularly for coordinates, scrollbar
behavior, drawing modes, cache freshness and canvas saves.
