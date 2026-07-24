# Document Session And Collaboration Stability Plan

## Summary

Working on one file should never be interrupted by an untimely reload, stale
cache read, or background metadata refresh. This plan improves document editing
in two layers:

1. Make all document sessions reload-safe, conflict-aware, and consistent.
2. Expand live collaboration toward an Office Online-like model where the file
   type supports operation-based merging.

The first layer is the priority. It protects local edits for every document type
even before full live co-editing exists.

## Progress Tracker

| Phase | Status | Goal |
| --- | --- | --- |
| 0. Audit and invariants | Done | Map every reload/save path and define the non-negotiable safety rules. |
| 1. Shared document session core | Done | Centralize version, dirty, save, remote-change, and conflict state. |
| 2. Safe reload policy rollout | Done | Replace destructive per-view reloads with guarded remote-change handling. |
| 3. Merge and conflict UX | Done | Add graceful remote-update banners, merge outcomes, and recovery actions. |
| 4. Hosted cache and replica hardening | Done | Prevent stale hosted cache reads from replacing newer in-memory/editor state. |
| 5. Live structured documents | Done | Move suitable hosted JSON documents onto the existing Yjs live path. |
| 6. Collaboration polish | Done | Add presence/status/reconnect UX and operational hardening. |
| 7. Advanced Office-like behavior | Done | Define the per-type path for richer concurrent editing without overclaiming support. |

## Current System Snapshot

Current document behavior is split across views:

- Notes use `NoteView` with REST optimistic saves and hosted live Yjs text when
  available.
- Canvas uses `useCanvasDocumentSession`, REST fallback, hosted live JSON, and
  several defensive guards.
- Kanban already uses hosted live JSON for board state, plus REST fallback.
- Logic diagrams use hosted live JSON for graph state, plus REST fallback.
- SVG, image overlays, PDF sidecars, grid, and other structured views each have
  their own save/reload assumptions.
- App-level file and replica events refresh file trees and indexes, and some
  views separately reload content when matching paths change.
- Hosted offline cache reads can return quickly while network refreshes update
  replica state later, which is useful but dangerous if a view treats cache
  content as always authoritative.

This split is the root cause: every view decides independently whether a remote
or cache event can replace active editor state.

## Safety Invariants

These rules should become shared infrastructure and test expectations:

- Never replace editor state while the user has unsaved local changes.
- Never replace editor state with a version older than the current in-memory
  session version.
- Never reload from hosted cache if a newer local save is in flight or has
  already advanced the session version.
- Serialize writes per document; coalesce trailing saves to the latest content.
- Treat selection, viewport, measurements, hover state, and transient live data
  as non-persistent unless the document type explicitly stores them.
- Distinguish file-tree/index refresh from active-document content reload.
- When clean, remote changes may auto-apply with a subtle status pulse.
- When dirty, remote changes must become pending state: merge if safe, otherwise
  show a review/reload choice.
- A failed save or unresolved conflict must stop autosave for that document until
  the user or session controller resolves it.
- Hosted live sessions must disable competing REST autosave for that document.

## Phase 0: Audit And Invariants

Tasks:

- Inventory all document/session paths:
  - `NoteView`
  - `CanvasPage` / `useCanvasDocumentSession`
  - `KanbanPage`
  - `LogicDiagramView`
  - `GridView`
  - `SvgVectorView` / SVG session helpers
  - `ImageView` overlay sessions
  - `PdfView` annotation sidecars
- List every content reload trigger:
  - Tauri `vault:file-*` events
  - `onReplicaMutated`
  - hosted vault metadata polling
  - explicit history/snapshot restore
  - tab switch/open
  - live session seed/reconnect
  - offline cache refresh
- List every save trigger:
  - autosave
  - manual save
  - toolbar actions
  - live CRDT persistence
  - rename/title-derived moves
  - sidecar writes
- Add a small written matrix to this doc with each view's current behavior.

Acceptance criteria:

- Every active document type has an owner row in the audit matrix.
- Every known reload trigger has a policy: auto-apply, queue pending, ignore,
  or force explicit reload.
- No implementation starts until the shared invariants above are accepted.

## Phase 1: Shared Document Session Core

Create a shared controller/hook, tentatively:

```ts
useDocumentSessionController<TDocument>({
  relativePath,
  client,
  read,
  write,
  serialize,
  deserialize,
  getVersion,
  applyDocument,
  mergeRemote?,
  isStructurallyEqual?,
  canLiveEdit?,
})
```

The controller owns:

- `loadedVersion`
- `lastSavedContent`
- `dirty`
- `saving`
- `saveQueued`
- `conflicted`
- `pendingRemote`
- `lastLocalWriteStartedAt`
- `lastAppliedRemoteVersion`
- `source`: `rest`, `cache`, `live`, or `local`
- `status`: `idle`, `dirty`, `saving`, `saved`, `remote-pending`,
  `conflict`, `offline-queued`, `live-connected`, `live-reconnecting`

Core methods:

- `markLocalChange()`
- `requestSave(reason)`
- `handleRemoteCandidate(document, source)`
- `handleExternalMutation(event)`
- `applyRemoteNow()`
- `discardRemoteCandidate()`
- `resolveConflict(choice)`
- `pauseAutosave(reason)`
- `resumeAutosave(reason)`

Acceptance criteria:

- Unit tests cover save serialization, trailing save coalescing, stale remote
  rejection, dirty remote queuing, clean remote auto-apply, and conflict latch.
- The controller can be used without React Flow, CodeMirror, or a specific
  document format.
- Existing `useDocumentSessionState` is either wrapped by or migrated into this
  controller.

### Phase 1 Outcome (Completed 2026-07-06)

Landed as `src/lib/documentSessionController.ts`:

- **`DocumentSessionController<TDocument>`** — a framework-agnostic class (no
  React / React Flow / CodeMirror / format knowledge; content is opaque strings,
  documents an opaque `TDocument`, all IO injected via `write` / `read` /
  `applyDocument`). Owns every field the plan listed (`loadedVersion`,
  `lastSavedContent`, `dirty`, `saving`, `saveQueued`, `conflicted`,
  `pendingRemote`, `lastLocalWriteStartedAt`, `lastAppliedRemoteVersion`,
  `source`, plus `offlineQueued`/`liveState`) and derives the full `status`
  vocabulary (`idle`/`dirty`/`saving`/`saved`/`remote-pending`/`conflict`/
  `offline-queued`/`live-connected`/`live-reconnecting`).
- **Methods** implement the plan's API: `load` (force explicit reload / baseline),
  `markLocalChange`, `requestSave`, `handleRemoteCandidate`,
  `handleExternalMutation` (re-reads via injected `read`), `applyRemoteNow`,
  `discardRemoteCandidate`, `resolveConflict('load-remote'|'keep-local'|'save-as-new')`,
  `pauseAutosave`/`resumeAutosave`, plus `setLiveState`.
- **Invariants enforced in code**: stale/older candidates rejected (opaque-token
  default, injectable `compareVersions` for Phase 4 manifest sequences); dirty
  remote candidates queued (with an optional `mergeRemote` hook reserved for
  Phase 3); candidates ignored while a save is in flight or a live session owns
  the doc; autosave stopped on conflict until explicit resolution; REST autosave
  disabled while live.
- **Exclusive-save primitive migrated**: `createExclusiveSaveRunner` (serialize +
  trailing-coalesce) now lives in the controller module, and the legacy
  `useDocumentSessionState.runExclusiveSave` wraps it — one implementation shared
  by old and new paths (satisfies "wrapped by or migrated into").
- **React binding**: `useDocumentSessionController` builds one controller whose
  injected callbacks delegate to the latest options (stable identity across
  renders) and subscribes via `useSyncExternalStore`.
- **Tests**: `documentSessionController.test.ts` (17 cases) covers the acceptance
  list — first-autosave skip, save serialization, trailing coalescing to latest
  content, stale rejection (opaque + comparator), clean auto-apply, dirty
  queuing, save-in-flight queuing, conflict pause + resume-only-on-resolution,
  offline-queued surfacing, live disable/ignore, external-mutation re-read, and
  dirty merge. Existing `documentSession.test.tsx` still green.

Phase 2 was completed one document surface at a time; the migration record
below is retained as implementation history.

## Phase 2: Safe Reload Policy Rollout

Migrate views one at a time. Recommended order:

1. Logic diagrams: newest and smallest surface.
2. Notes REST fallback: highest user impact.
3. Canvas REST fallback: already has many concepts to preserve.
4. Kanban REST fallback.
5. SVG vector editor.
6. Grid view.
7. PDF/image sidecars.

Per-view migration steps:

- Move version/dirty/save queue state into the shared controller.
- Replace direct reload-on-event code with `handleRemoteCandidate`.
- Ensure local view state is not replaced while dirty.
- Ensure remote candidates older than current session version are ignored.
- Keep view-specific serialization and structural-signature logic local.
- Add focused tests for clean reload, dirty pending remote, stale remote ignore,
  and save-in-flight behavior.

Acceptance criteria:

- A local unsaved edit survives file watcher and replica mutation events.
- A clean document still updates automatically when another source changes it.
- A recently saved hosted document cannot be replaced by stale cached content.
- The same status vocabulary appears in each migrated view.

### Phase 2 Progress

Migration order and status:

1. **Logic diagrams — Done (2026-07-06).**
2. **Notes REST fallback — Done (2026-07-06).**
3. **Canvas REST fallback — Done (2026-07-06).**
4. **Kanban REST fallback — Done (2026-07-06).**
5. **SVG vector editor — Done (2026-07-06).**
6. **Grid view — Done (2026-07-06, audit-only).**
7. **PDF/image sidecars — Done (2026-07-06).**

**Logic diagram migration (`src/views/LogicDiagramView.tsx`):**

- Replaced `useDocumentSessionState` + the bespoke `hashRef` / `baseContentRef` /
  `conflictedRef` / `savedStructuralRef` bookkeeping and the ad-hoc
  `writeLogic`/autosave with `useDocumentSessionController`. Version, dirty, save
  serialization, remote-candidate policy, and conflict latch now live in the
  shared controller.
- View-specific logic kept local: the structural-signature gate still decides
  *when* to mark a local change (so selection / measurement / fit-view / pan do
  not autosave), and `fromFlowGraph`/`toFlowGraph` serialization stays in the
  view. A `lastMarkedSigRef` makes the mark idempotent per distinct signature so
  a controller-driven re-render never re-marks the same edit.
- **New safe remote handling Logic never had**: added `vault:file-modified`
  (local) and `onReplicaMutated` (hosted) listeners that route through
  `controller.handleExternalMutation`. Clean docs auto-apply (with a refresh
  pulse); dirty docs queue the remote as pending; our own write echo and
  same-version reads are rejected as stale.
- **Conflict is no longer a dead-end**: the old latch-until-reopen (`conflictedRef`
  + toast) is replaced by the controller's `conflict` state with inline
  `Load latest` / `Keep mine` recovery (the latter rebases onto their version and
  re-saves). Autosave stays paused until resolved.
- **Shared status surface**: new `src/components/layout/DocumentStatusPill.tsx`
  renders the controller `status` vocabulary + remote/conflict recovery actions.
  This is the reusable surface every subsequent migrated view will use, so the
  "same status vocabulary" criterion is satisfied from the first migration.

**Tests:** `DocumentStatusPill.test.tsx` (labels + action wiring) and
`LogicDiagramView.test.tsx` (clean external change auto-applies; unsaved local
edit is preserved and the remote is queued while dirty; stale same-version
watcher event is ignored).

**Notes migration (`src/views/NoteView.tsx`):**

- Replaced `useDocumentSessionState` + `hashRef`/`savedContentRef`/`contentRef`/
  `isDirtyRef`/`shouldSkipAutosave` and the bespoke `performSave`/`requestSave`/
  autosave effect with `useDocumentSessionController`. Version, dirty, save
  serialization (trailing-coalesce), remote-candidate policy, and conflict latch
  now live in the controller.
- **Live-when-connected preserved**: the hosted Yjs path is untouched;
  `isLive: () => liveSession !== null` disables REST autosave and remote reloads
  while live, and `setLiveState('live-connected')` surfaces the live status. A
  remote apply echoes back through the editor's `onChange`, but since it equals
  the just-saved content the controller treats it as not dirty — no guard needed.
- Watcher + replica listeners now route through `controller.handleExternalMutation`
  (clean auto-apply with pulse, dirty → queued pending, stale/echo ignored). This
  replaces the old `version !==` + `isDirtyRef` checks.
- View-specific behavior kept local: the H1-title rename-move runs after a
  successful write inside the injected `write`, snapshot creation stays in the
  manual-save handler, tag transforms flow through `setContent` → `onChange`.
- **Conflict** is routed through the controller + `DocumentStatusPill`
  (`Load latest` / `Keep mine`), consistent with Logic. Notes no longer calls
  `addConflict`, so the legacy modal `ConflictDialog` no longer appears for notes
  (it remains for the not-yet-migrated Canvas/Kanban). Phase 3 will build the
  richer shared conflict surface (with the side-by-side diff) on top of the pill.
- `readOnly` (hosted viewer) is gated in both `markLocalChange` (skipped) and the
  injected `write` (no-op), so a viewer never triggers a rejected write.

**Notes tests** (`NoteView.test.tsx`): existing clean-reload / dirty-preserved /
overlapping-autosave / hosted-open / read-only-never-writes / live-drives-editor
cases updated for the read-then-evaluate policy, plus a new case: a newer remote
change is queued while dirty and applied on `Load latest`.

Full suite green (127 files / 626 tests) and `tsc` clean.

**Canvas migration (`useCanvasDocumentSession.ts` + `CanvasPage.tsx`):**

- All REST session state moved into `useDocumentSessionController`, built
  *inside* the hook. `CanvasPage` no longer creates `useDocumentSessionState` and
  no longer threads `hashRef`/`lastWriteRef`/`markLoaded`/`shouldSkipAutosave`/
  `markWriteStarted`/`shouldCreateSnapshot`/`runExclusiveSave`/`isDirtyRef`/
  `addConflict` down — the hook's option surface shrank to just view state,
  setters, conversions, identity, `pauseAutosave`, and `readOnly`.
- **The hosted live-JSON path is preserved verbatim** — the corruption guards
  (`liveHydratedRef`, `lostRestNodes`, empty-root REST fallback,
  `discardOfflineState`, awareness publish, debounced `writeJson`) are unchanged.
  `isLive: () => liveSession !== null` disables REST autosave/remote reloads while
  a live session owns the canvas; `restCanvasRef` (used by `lostRestNodes`) is now
  refreshed by the controller's `applyDocument`.
- **Round-trip-canonical baseline**: because the flow round-trip normalizes JSON,
  the controller is loaded/read with `roundTripCanonical(canvas)` (the exact
  `fromFlowNode`/`fromFlowEdge` serialization) so re-applying loaded content and
  the first local-change mark produce byte-identical content — no spurious dirty
  on open. A `firstMarkAfterApplyRef` skips one mark after every apply as a
  belt-and-suspenders against non-idempotent round-trips.
- Local edits drive the controller via an effect on `[nodes, edges, viewport]`;
  the controller's content-equality now treats selection-only changes as clean
  (fewer redundant writes than before). `pauseAutosave` (drag interaction) maps to
  `controller.pauseAutosave()/resumeAutosave()`. Watcher + replica route through
  `handleExternalMutation`; the initial load keeps the sanitize + dangling-edge
  repair-write + blank-seed behavior before establishing the baseline.
- Conflict routed through the controller + `DocumentStatusPill` (in the
  `DocumentTopBar` meta), consistent with Notes/Logic; Canvas no longer calls
  `addConflict`. Snapshots created in the injected `write` on a successful save.

**Canvas tests**: `useCanvasDocumentSession.test.tsx` updated to the new option
interface (load/repair/autosave+snapshot/live-hydration/awareness); `CanvasPage.test.tsx`
conflict test now asserts the status pill (`Conflict needs review`) and the
dirty-watcher test asserts the read-then-evaluate policy (reads but does not
apply a same-version candidate). Full suite green (127 files / 626 tests), `tsc`
clean, no unhandled rejections.

**Kanban migration (`KanbanPage.tsx` + `KanbanBoard.tsx`):**

- Same shape as Canvas: `useDocumentSessionController<KanbanBoard>` replaces
  `useDocumentSessionState` + `hashRef`/`savedBoardContentRef`/`latestBoardRef`/
  `saveTimerRef`/`isDirtyRef`/`addConflict`/manual `saveBoard`. The hosted
  live-JSON path (`openLiveJsonSession`, seed, `onChange`, `discardOfflineState`,
  awareness, `writeJson`) is unchanged; `isLive: () => liveSessionRef.current !== null`.
- **Automation handling is centered in the controller boundary**: `serialize` is
  the raw normalized board (dirty-tracking form); the injected `write` applies
  `runKanbanAutomations(..., 'onBoardSave')` before persisting and returns the
  automated/merged content as `mergedContent`, so the controller adopts any
  automation-applied changes back into the displayed board (matching the old
  `setBoard(automatedBoard)`). `applyDocument` applies `'onBoardOpen'` automations
  for display; the load baseline is `serializeBoardRaw(displayBoard(parsed))` so a
  revert-to-loaded edit reads as clean.
- `updateBoard` now marks a controller local change (REST) or writes to the CRDT
  (live), derived from `boardRef.current` (no side effects inside a setState
  updater). Watcher + replica route through `handleExternalMutation`. Conflict +
  pending-remote flow through the controller; the `DocumentStatusPill` is rendered
  in `KanbanBoard`'s `DocumentTopBar` meta (threaded via `KanbanContext`
  `sessionStatus`/`onLoadRemote`/`onKeepLocal`), and `setLiveState` shows `Live`.

**Kanban tests** (`KanbanPage.test.tsx`): the mock board exposes `sessionStatus`;
the conflict test asserts the controller status latches to `conflict`; the
dirty-watcher test asserts the read-then-evaluate policy; snapshot/clean-reload
cases unchanged. Full suite green (127 files / 626 tests), `tsc` clean.

**SVG vector editor migration (`src/components/image/useSvgSession.ts` + `src/views/SvgVectorView.tsx`):**

- `useSvgSession` now uses `useDocumentSessionController<SvgScene>` for version,
  dirty, save, remote-candidate, and conflict state. The SVG editor remains
  manual-save only (`schedule: () => () => {}`), but local edits are tracked
  against the controller baseline instead of bespoke `savedText` refs.
- Local `vault:file-modified` events and hosted `onReplicaMutated` notifications
  now route through `controller.handleExternalMutation`. Clean SVGs apply the
  latest document automatically; dirty SVGs keep the current scene and queue the
  remote candidate as `remote-pending` for explicit load/keep handling.
- Optimistic `writeDocument` results are mapped into controller outcomes,
  including backend merge adoption and conflict latching. Asset-backed legacy
  SVGs still load through the data-URL fallback and expose a clean baseline, but
  saving remains blocked because they are not revision-backed text documents.
- `SvgVectorView` renders the shared `DocumentStatusPill` in edit mode, giving
  SVGs the same pending-remote/conflict actions as the already migrated views.

**SVG tests** (`useSvgSession.test.tsx`): added watcher coverage for clean remote
apply and dirty remote queueing, while preserving manual-save, conflict,
asset-fallback, and read-only viewer coverage. Focused suite
(`useSvgSession.test.tsx` + `documentSessionController.test.ts`) and `tsc` are
green.

**Grid view audit (`src/views/GridView.tsx`, `src/store/gridStore.ts`, `src/components/grid/GridCell.tsx`):**

- No `useDocumentSessionController` migration is needed for the grid shell.
  Grid workspaces are app-local UI state persisted by `gridStore`
  (`grid-storage-v2`), not vault documents with optimistic versions, watcher
  reloads, replica mutations, or live sessions.
- Grid cells mount the real document views (`NoteView`, `CanvasPage`,
  `KanbanPage`, `LogicDiagramView`, `ImageView`, `PdfView`). Those embedded views
  own their document sessions, so the safe-reload policy follows the child view
  rather than the shell.
- `GridView` layout changes, cell swaps, cell clearing, split activation, and
  responsive layout fallback only mutate the app-local workspace descriptor. They
  cannot overwrite vault document content and therefore have no dirty/remote
  candidate state to preserve.

**Grid tests** (`GridCell.test.tsx`): added logic-diagram render and drag-in
coverage so the grid test matrix includes the migrated logic document type.

**PDF/image sidecar migration (`src/views/PdfView.tsx`, `src/components/image/useImageDocumentSession.ts`, `src-tauri/src/commands/watcher.rs`):**

- Image additive overlays now use `useDocumentSessionController<ImageOverlayDocument>`
  for baseline, dirty, autosave, pending remote, and conflict state. Local
  `vault:file-modified` events route through `handleExternalMutation`; clean
  overlays apply the latest sidecar, while dirty overlays queue the remote
  candidate and keep the visible local annotations.
- PDF sidecar state now uses `useDocumentSessionController<PdfSidecarState>`.
  Local vaults serialize the full sidecar including viewer state; hosted vaults
  serialize only shared annotation collections so page/zoom changes do not write
  hosted annotations. The PDF toolbar shows the shared `DocumentStatusPill`.
- The native watcher now has a narrow `.collab/` exception for image overlay and
  PDF sidecar files: it decodes `.collab/image-overlays/*.json` and
  `.collab/pdf/*.json` back to the source vault path and emits the normal
  `vault:file-modified` event. Other hidden `.collab/` runtime files remain
  suppressed.
- Permanent image raster edits remain outside the sidecar session. They still
  save generated image bytes through the existing explicit save flow.

**PDF/image tests**: `useImageDocumentSession.test.tsx` covers clean external
overlay apply, dirty remote queueing, and debounced overlay persistence. Native
watcher unit tests cover image/PDF sidecar path decoding. `tsc` and
`cargo check --workspace` are clean.

**Note — modal `ConflictDialog` removed in Phase 3.** After Phase 2, Notes,
Canvas, and Kanban no longer called `collabStore.addConflict` (SVG/PDF/image
never did), leaving the modal `ConflictDialog` unreachable. Phase 3 folded the
side-by-side diff into the shared `DocumentReconciler` surface and then deleted
the dead modal, its `AppShell` mount, and the `collabStore` conflict state (see
the Phase 3 Outcome below).

## Phase 3: Merge And Conflict UX

Add a shared non-modal document status surface:

- `Saved`
- `Saving...`
- `Offline changes queued`
- `Remote changes available`
- `Remote changes merged`
- `Conflict needs review`
- `Live`
- `Reconnecting`

Remote-change UX:

- Clean document: auto-apply and pulse.
- Dirty text document: attempt three-way merge using base/local/remote.
- Dirty structured document with safe merge support: attempt entity-level merge.
- Dirty unmergeable document: show pending remote banner with actions:
  - Review
  - Keep mine
  - Load remote
  - Save mine as new revision

Conflict dialog improvements:

- Show base/local/remote where available.
- Allow copy/export before resolving.
- Keep autosave paused until resolved.
- Never dismiss by accidentally clicking away if unresolved data would be lost.

Acceptance criteria:

- Users can understand whether they are editing local, live, or stale content.
- Dirty documents receive remote changes gracefully without immediate overwrite.
- All conflict resolution paths preserve at least one recoverable copy of local
  content.

### Phase 3 Outcome — Done (2026-07-06)

Built the shared reconciliation surface on top of the Phase 1 controller and
retired the legacy modal.

- **Unified reconciliation model.** The controller gained a `Reconciliation`
  projection (`deriveReconciliation(snapshot)` — pure, snapshot-driven) that
  collapses a queued pending-remote and a hard save conflict into one shape
  (`base` / `ours` / `theirs` / `theirVersion`), where `ours` is always a
  recoverable copy of the local content. New unified action methods replace the
  per-view `applyRemoteNow`/`discardRemoteCandidate`/`resolveConflict` glue:
  - `loadRemote()` — adopt the other side (works for pending and conflict).
  - `keepMine()` — for a conflict, keep-local; for a pending-remote, **rebase**
    the local edits onto the remote version so the next save cleanly overwrites
    it (base = their content). This fixes the old pending "keep mine" path, which
    left a stale version that would only hard-conflict on the next autosave.
  - `saveMineAsNew(persist)` — the caller persists local content to a new
    revision/file, then the active document adopts the remote; both copies
    survive. If `persist` rejects, the remote is not adopted.
- **Shared surface (`DocumentReconciler`).** Renders the non-modal
  `DocumentStatusPill` plus, when there is unresolved remote content, a "Review"
  button opening a **non-dismissible** dialog (overlay-click and Escape are
  prevented; no close button) that shows the your/their panes, a per-pane
  **Copy** escape hatch, a collapsible line diff (`diffLines`), and the three
  resolution actions. Autosave is paused for the entire time the dialog is open.
  Hidden entirely for read-only viewers.
- **Central mount.** `StatusBar` is the single active rendering site: the
  `documentStatusStore` registration now carries the live `controller` +
  `snapshot` + `onSaveAsNew` (types erased at the store boundary), and StatusBar
  renders `DocumentReconciler` from it (falling back to a bare pill for any
  legacy registrant). Every migrated view (Note/Canvas/Kanban/Logic) registers
  this payload and no longer re-implements load/keep handlers.
- **Text three-way merge for notes.** `src/lib/textMerge.ts` (`mergeText`, jsdiff
  `merge`) is injected as the note controller's `mergeRemote`, so a dirty note
  absorbs a disjoint remote change automatically (mirroring the backend
  `write_note` auto-merge); overlapping edits or a missing base fall back to the
  pending-review surface.
- **Save mine as new.** `src/lib/conflictedCopy.ts` writes a dated sibling
  `… (conflicted copy YYYY-MM-DD).ext` via the mode-agnostic `VaultClient`
  (local + hosted), wired as each view's `onSaveAsNew`.
- **Dead modal removed.** Deleted `ConflictDialog.tsx`, its `AppShell` mount, and
  the now-unused `collabStore` `conflicts`/`addConflict`/`dismissConflict` state
  (the write-result `ConflictInfo` type stays — it is the controller's conflict
  payload). All conflict resolution now flows through `DocumentReconciler`.

Tests: `textMerge`, `conflictedCopy`, `DocumentReconciler`, and controller
reconciliation-API specs added; NoteView gains an auto-merge case. Full suite
131 files / 658 tests green; `tsc --noEmit` clean.

## Phase 4: Hosted Cache And Replica Hardening

Problems to solve:

- Hosted reads may return cached content quickly and refresh in the background.
- Replica mutations can fire after background cache updates.
- Views may reload from cached content that is older than the current session.

Tasks:

- Include source metadata in document reads where useful:
  - `source: "cache" | "network" | "optimistic-replica"`
  - `version`
  - `manifestSequence`
  - `contentHash`
- Let session controller reject stale cache candidates by version/sequence.
- Do not emit active-document reload events for cache refreshes that do not
  advance the active file revision.
- Split replica events into structural manifest changes vs content cache changes
  where possible.
- Ensure hosted vault metadata refresh does not update active vault identity for
  content-only timestamp churn.
- Add tests around cached-first read plus later network refresh while local
  edits are dirty.

Acceptance criteria:

- Cache freshness improves file tree/index state without overwriting active
  editor state.
- A hosted offline/online transition cannot revert recent unsaved or just-saved
  document content.
- Pending offline edits remain visible as pending, not silently replaced.

### Phase 4 Outcome — Done (2026-07-06)

Implemented the hosted cache and replica hardening layer:

- Hosted document reads now carry source metadata (`network`, `cache`, or
  `optimistic-replica`), manifest sequence, and content hash where available.
- The shared document-session controller accepts read-source metadata and uses a
  shared version comparator so hosted revision sequences are ordered
  numerically; older cached candidates are rejected instead of treated as fresh
  opaque tokens.
- Notes, Kanban, Canvas, Logic, and text-backed SVG sessions use the shared
  comparator and propagate cached read source into the controller.
- Hosted offline write fallback now returns `offlineQueued`, allowing document
  sessions to keep the local edit dirty/offline instead of marking it as a clean
  saved revision.
- Offline queued saves clear optimistic cache echoes that can arrive from the
  replica mutation emitted during the queue write.
- Background hosted document cache refresh no longer emits a replica mutation
  when the active file revision/path/identity did not change.
- Replica mutation notifications are now typed as `manifest`, `content`,
  `pending`, `sync`, or `replica`, optionally scoped by affected file IDs and
  relative paths.
- Active document sessions subscribe only to manifest events affecting their own
  relative path. Content-cache-only refreshes and unrelated manifest changes no
  longer trigger active-document re-reads.
- File-tree/index refreshes subscribe only to manifest/replica events, while the
  sync status UI still listens broadly because pending-operation and sync-state
  changes are relevant there.
- Hosted vault metadata refresh already ignores manifest-sequence and
  updated-at-only churn for the active vault identity, updating only name, role,
  capabilities, and offline-copy intent.

## Phase 5: Live Structured Documents

Use the existing Yjs infrastructure for suitable hosted documents.

Already suitable:

- Notes: text Yjs already exists.
- Canvas: structured live JSON already exists.
- Kanban: structured live JSON already exists.

Next candidates:

- Logic diagrams: nodes and wires are stable-ID entities, good fit.
- Grid documents: likely suitable if cells have stable identities and merge
  semantics are defined.

Later or partial candidates:

- SVG vector editor: possible for recognized scene primitives, harder for raw
  passthrough SVG.
- PDF annotations: suitable for comments/highlights, not the PDF binary itself.
- Image overlays: suitable for overlay sidecars, not raster edits.

Tasks:

- Generalize structured live document hookup into a reusable hook:
  `useLiveJsonDocumentSession`.
- Support per-type validation before accepting live seed.
- Reject degenerate live state that would lose REST-canonical entities.
- Keep REST fallback when live connection is unavailable.
- Publish per-type awareness:
  - selected nodes/cards/cells
  - focused item
  - active drag/edit state where useful

Acceptance criteria:

- Hosted logic diagrams can be co-edited without REST autosave races.
- Concurrent edits to different stable-ID entities merge.
- Presence is visible in live-enabled document views.
- Broken or unavailable live sessions fall back to safe REST sessions.

### Phase 5 Outcome — Done (2026-07-07)

- Added the reusable `useLiveJsonDocumentSession` binding around the existing
  structured Yjs provider. The hook centralizes live open/cleanup, empty or
  invalid seed rejection, document-specific validation, remote-change adoption,
  and safe REST fallback.
- Logic diagrams now participate in hosted live collaboration through the shared
  structured JSON session. While live is connected, graph edits write to Yjs
  instead of scheduling REST autosaves, preventing autosave races for hosted
  co-editing.
- Logic live startup validates the CRDT seed against the REST-canonical diagram
  and discards degenerate cached state that would drop known nodes or wires.
- Logic diagrams publish live document awareness and show the shared live peer
  strip in the document top bar.
- Existing Canvas and Kanban live JSON paths remain supported, with the shared
  hook available for follow-up consolidation after this phase.

## Phase 6: Collaboration Polish

UX improvements:

- Consistent live peer strip across supported document views.
- Per-document connection state:
  - Live
  - Reconnecting
  - Offline fallback
  - REST fallback
- Remote cursor/selection indicators where useful.
- Non-intrusive save/reload status in shared document top bars.
- Clear “someone else changed this” messaging for local vaults and REST fallback.

Reliability improvements:

- Reconnect without dropping to REST mid-session.
- Persist live CRDT state to offline replica where supported.
- Add recovery for incompatible live protocol versions.
- Add telemetry/logging hooks for reload suppression decisions.

Acceptance criteria:

- Users can tell whether edits are live, saved, queued, or conflicted.
- Brief network drops do not interrupt an active document.
- Unsupported live collaboration degrades predictably to the safe session path.

### Phase 6 Outcome — Done (2026-07-07)

- Added a shared live-status hook that subscribes to the live provider and maps
  connected sessions to `live-connected` and transient socket drops/reconnects
  to `live-reconnecting`, without dropping the document back to REST mid-session.
- Surfaced the shared `DocumentStatusPill` in live-capable document top bars:
  notes, Canvas, Kanban, and Logic diagrams now show live, reconnecting, saved,
  dirty, queued, and conflict state near the document controls.
- Kept existing live peer strips consistent across supported views and preserved
  per-type awareness: note cursors through Yjs bindings, Canvas selected-node
  rings, Kanban card-edit indicators, and Logic live peer presence.
- Reused the existing safe REST fallback path for unsupported or failed live
  startup, including incompatible protocol recovery and offline replica CRDT
  persistence from the live provider.

## Phase 7: Advanced Office-Like Behavior

Deferred until the safe baseline is proven.

Potential work:

- Rich per-type operational models beyond generic JSON diffs.
- Better concurrent array move handling.
- Conflict-free ordering for diagrams, cards, and grid rows.
- Multi-user drag previews.
- Live comments/review threads.
- Cross-document collaboration status.

Acceptance criteria:

- Written design exists for each document type before implementation.
- The app does not claim Office-like behavior for document types that still use
  safe REST fallback only.

### Phase 7 Outcome — Done (2026-07-07)

Phase 7 is complete as the advanced-behavior design gate, not as a blanket
"Office-like" implementation. The app now documents live support only for the
document types that actually have live sessions: hosted notes, Kanban boards,
canvases, and logic diagrams. Document types still on safe REST/session
fallback remain described as safe/conflict-aware, not real-time co-editable.

| Document type | Current collaboration model | Advanced design before implementation |
| --- | --- | --- |
| Notes | Hosted Yjs text with CodeMirror cursor/selection awareness. | Keep text CRDT as canonical. Add comment/review threads as anchored ranges with explicit re-anchor behavior after edits; do not mix review state into raw markdown until export semantics are defined. |
| Canvas | Hosted generic live JSON, stable node/edge IDs, Canvas selected-node awareness. | Move to per-entity maps for nodes/edges plus an explicit ordered ID list or fractional order key so node field edits survive concurrent reorder/delete operations. Drag previews should remain awareness-only until commit. |
| Kanban | Hosted generic live JSON, stable column/card IDs, card-edit awareness. | Model columns and cards as entity maps with conflict-free order keys per column. Card moves should update card location/order atomically, while title/content/comments remain independent fields. |
| Logic diagrams | Hosted generic live JSON, stable gate/wire IDs, live peer presence. | Model gates and wires as entity maps with stable IDs. Gate movement, input toggles, group membership, and wire edits should be independent operations; multi-user drag previews stay awareness-only. |
| Grid | App-scoped workspace shell embedding document views; no vault-document write path. | No Office-like claim. Cross-document status should aggregate embedded child document states rather than inventing a live grid document model. |
| SVG vector editor | Safe REST/manual save through `useSvgSession`; no live vector session. | Require a scene-operation design first: recognized primitives can become entity maps, but raw passthrough SVG, defs, filters, groups, and `<use>` need preserve/lock semantics before live editing is offered. |
| PDF annotations | Safe hosted/local sidecar sessions; no live PDF annotation session. | Limit live work to annotation/comment sidecars. Highlights, text boxes, and comments can become entity maps with page/anchor coordinates; the PDF binary itself stays immutable. |
| Image overlays | Safe local additive overlay sessions; hosted overlay persistence is unavailable. | Live only the additive overlay sidecar after hosted overlay storage exists. Raster edits remain explicit generated-image operations, never collaborative pixel editing. |

Advanced work must land behind document-type-specific designs and tests. Generic
JSON reconciliation remains acceptable for today’s stable-ID co-editing, but the
app must not claim conflict-free reordering, live comments, or multi-user drag
previews until those per-type models exist.

## Phase 0 Audit (Completed 2026-07-06)

Source of truth for the audit below is the code as it stands today:
`NoteView.tsx`, `useCanvasDocumentSession.ts`, `KanbanPage.tsx`,
`LogicDiagramView.tsx`, `GridView.tsx`, `useSvgSession.ts`,
`useImageDocumentSession.ts`, `PdfView.tsx`, and the shared
`useDocumentSessionState` in `documentSession.ts`.

### Audit Matrix (filled)

| Document type | Owner module | Current save path | Current reload triggers | Live support | Conflict handling | Main risk | Migration target |
| --- | --- | --- | --- | --- | --- | --- |
| Notes | `NoteView.tsx` | REST optimistic autosave (600 ms debounce) via `runExclusiveSave`→`performSave` with `expected_hash` + `base_content` auto-merge; manual save; H1-title rename-move; snapshot on manual save. Hosted live Yjs text disables REST autosave. | initial load on path/vault change; `vault:file-modified` watcher (local); `onReplicaMutated` (hosted); `forceReloadPath` from HistoryPanel; live session seed/binding. | Hosted text Yjs (`openLiveNoteSession`) | `performSave` conflict → `addConflict` → `ConflictDialog`. | Watcher/replica compare with `version !== hashRef` (not monotonic "newer than"); dirty is *ignored* (not queued) so a remote change is silently dropped while typing; no cache-source awareness. | shared controller + existing live path |
| Canvas | `useCanvasDocumentSession.ts` | REST optimistic autosave (600 ms) via `runExclusiveSave`→`saveCanvas`; merge adoption; blank-doc create + dangling-edge repair writes on load; snapshot. Hosted live JSON disables REST autosave. | initial `loadCanvas(true)`; `vault:file-modified` (local, skip if dirty or <2 s since write); `onReplicaMutated` (hosted, skip if dirty/live, pulse); live `onChange`→`applyLiveCanvas`; merged-content adoption after save. | Hosted JSON Yjs, hardened (`liveHydratedRef`, `lostRestNodes`, empty-root REST fallback, `discardOfflineState`) | `addConflict` → `ConflictDialog`. | Most complex per-view reload logic; several guards to preserve; still `version !==` rather than monotonic. | shared structured session hook |
| Kanban | `KanbanPage.tsx` | REST optimistic autosave via `updateBoard`→debounced `writeNote` through `runExclusiveSave`; automations on open/save; snapshots. Hosted live JSON disables REST autosave. | initial `loadBoard(true)`; `vault:file-modified` (local, skip if dirty or <2 s); `onReplicaMutated` (hosted, skip if dirty/live, pulse); live `onChange` seed/apply. | Hosted JSON Yjs (`openLiveJsonSession`) | `addConflict` → `ConflictDialog`. | Duplicated session/reload logic mirrored from Canvas; same `version !==` limitation. | shared structured session hook |
| Logic | `LogicDiagramView.tsx` | REST optimistic autosave (600 ms) through `useDocumentSessionController`; hosted live JSON disables REST autosave. | initial load; `vault:file-modified` watcher (local); `onReplicaMutated` (hosted); live session seed/reconnect through per-type validation. | Hosted JSON Yjs with gate/wire entity validation and live peer presence. | Conflict/pending remote → shared `DocumentStatusPill` load/keep actions. | Generic JSON live reconciliation still does not provide conflict-free reordering or multi-user drag previews. | live JSON complete; advanced entity/order model deferred behind Phase 7 design |
| Grid | `GridView.tsx` / `gridStore` | Not a per-file vault document. Workspace layout + cell content persisted in app-scoped `gridStore` (Zustand `persist`). Cells embed other views, which own their own document sessions. | none of its own (embedded views reload independently). | n/a | n/a (no vault-document write) | Low direct risk; safety depends entirely on the embedded child views. | audit-only; no session migration for the grid shell itself |
| SVG | `useSvgSession.ts` | **Manual save only** (no autosave) through `useDocumentSessionController`; optimistic `writeDocument` with `base_content` merge; asset-backed legacy SVGs load but cannot save. | initial load; `vault:file-modified` watcher (local); `onReplicaMutated` (hosted) through the shared safe-remote policy. | none | Conflict/pending remote → shared `DocumentStatusPill` load/keep actions. | Live collaborative vector editing is still out of scope; REST fallback now prevents dirty-state overwrite. | shared controller, REST safe path complete |
| PDF annotations | `PdfView.tsx` | `useDocumentSessionController<PdfSidecarState>` owns sidecar baseline/autosave. Local writes full sidecar including viewer state; hosted writes shared annotation collections only. | initial load; decoded local sidecar watcher; hosted replica mutation through safe remote policy. | none | Conflict/pending remote → shared `DocumentStatusPill` load/keep actions. | Live PDF co-editing is still out of scope; REST/sidecar fallback now prevents dirty-state overwrite. | controller sidecar path complete |
| Image overlays | `useImageDocumentSession.ts` | `useDocumentSessionController<ImageOverlayDocument>` owns additive overlay baseline/autosave; permanent raster edits remain explicit generated-image saves. | initial load; decoded local sidecar watcher through safe remote policy. | none | Conflict/pending remote → shared `DocumentStatusPill` load/keep actions in additive mode. | Hosted overlay persistence remains unavailable; local sidecar overwrite risk is mitigated. | controller sidecar path complete |

### Reload-Trigger Policy

Every known content-reload trigger and its required policy. "Current" is what
the code does today; "Target" is the invariant-compliant behavior the shared
controller must enforce.

| Trigger | Sources today | Current behavior | Target policy |
| --- | --- | --- | --- |
| Initial load / tab open / path change | all views | authoritative first read | **force explicit reload** (establishes session version + baseline) |
| `vault:file-modified` watcher (local) | Notes, Canvas, Kanban, Logic, SVG, PDF/image sidecars where applicable | route through the shared controller or view-specific live guard | clean+newer → **auto-apply** (pulse); dirty → **queue pending**; older/equal version → **ignore** |
| `onReplicaMutated` (hosted) | Hosted document and sidecar views | route through the shared controller, path filter, and live-session guard | clean+newer → **auto-apply** (pulse); dirty → **queue pending**; live session active → **ignore**; stale cache (older seq/hash) → **ignore** |
| Hosted vault metadata polling | `serverStore` | can churn vault identity | **ignore** for content-only timestamp churn (Phase 4) |
| History/snapshot restore | Notes `forceReloadPath` (others TBD) | force reload | **force explicit reload** (user-initiated; must still protect unsaved local via confirm) |
| Live session seed / reconnect | Notes, Canvas, Kanban, Logic | `onChange` applies; per-type guards | **auto-apply** (CRDT authoritative) behind per-type validation guards |
| Offline cache refresh | replica read-through | may reload from cache | **ignore** unless it advances the active revision; feed file-tree/index only |
| Server merged-content adoption (post-save) | Notes, Canvas, Kanban, Logic | adopt merged result | **auto-apply** (server merge is authoritative for that write) |

Views with **no live session today** (SVG, PDF, Image) still route remote
signals through the shared controller and safe REST/session path. Adding live
support later must extend those controller-backed paths rather than re-deriving
ad-hoc reload listeners.

### Save-Trigger Inventory

| Save trigger | Views | Notes |
| --- | --- | --- |
| Debounced autosave | Notes (600 ms), Canvas (600 ms), Kanban (600 ms), Logic (600 ms, structural-signature-gated), PDF sidecar (400 ms local / 400 ms hosted), Image overlay (450 ms) | all document autosaves funnel through `runExclusiveSave` except sidecars/overlays |
| Manual save | Notes, Logic (Save button), SVG (only save path) | — |
| Toolbar / structural actions | Canvas, Kanban, Logic, SVG, Image | mutate in-memory state → mark dirty → trigger autosave (except SVG which requires manual save) |
| Live CRDT persistence | Notes, Canvas, Kanban, Logic (hosted) | server relay persists; REST autosave is disabled while live |
| Rename / title-derived move | Notes (H1 → filename) | writes then `renameMove` + tree refresh |
| Sidecar writes | PDF (viewer state + annotations), Image (overlays), plus note-arrow/image-overlay sidecars | independent of the document-revision path |

### Acceptance Check

- **Every active document type has an owner row** — Notes, Canvas, Kanban,
  Logic, Grid, SVG, PDF annotations, Image overlays are all represented above.
- **Every known reload trigger has a policy** — see the Reload-Trigger Policy
  table (auto-apply / queue pending / ignore / force explicit reload).
- **Shared invariants accepted before implementation** — the Safety Invariants
  section stands as the contract for Phases 1–2. No view code has been changed
  in Phase 0; this phase is documentation only.

## Test Strategy

Shared controller tests:

- skips first autosave after load
- serializes overlapping saves
- coalesces trailing save to latest content
- rejects stale remote candidates
- queues remote candidates while dirty
- auto-applies newer remote candidates while clean
- pauses autosave on conflict
- resumes only after explicit resolution

Per-view tests:

- clean external update applies
- dirty external update does not replace local content
- save-in-flight external update does not replace local content
- hosted cache read older than current session is ignored
- conflict path preserves local content
- live session disables REST autosave

Integration/manual checks:

- Two app windows editing the same hosted note.
- Hosted note live unavailable, falling back to REST.
- Hosted canvas/kanban live editing with another user.
- Logic diagram hosted save under slow network.
- Offline hosted edit, reconnect, and sync conflict.

## Rollout Notes

- Do not migrate every editor at once.
- Keep the old behavior behind each view until its tests pass.
- Prefer additive status UI before removing existing conflict dialogs.
- Treat “no data loss” as the success metric, not silent auto-merge.
- Office Online-like behavior should emerge from live sessions per document type,
  not from forced background reloads.
