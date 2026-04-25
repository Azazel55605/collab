# Collab Stabilization Overview

## Summary

This document tracks what has already been stabilized, what is currently blocking the deferred document-session retry, and what should happen next.

The broad Phase 2 shared document-session refactor is intentionally deferred. The current strategy is:

1. keep the stable Stage 1 and safe Phase 2 fixes in place
2. finish regression coverage for the remaining reload paths
3. decompose the largest stateful views
4. retry the broader shared session architecture in smaller slices

## Progress Snapshot

| Area | Status | Progress | Notes |
|------|--------|----------|-------|
| Stage 1 reliability fixes | Complete | 100% | Core note/kanban/canvas save, conflict, snapshot, and presence fixes are in place. |
| Safe Phase 2 cleanup | Complete | 100% | Transport/config cleanup, shortcut normalization, and `AppShell` remount hardening are kept. |
| Stage 3 regression coverage | Complete for current gates | 100% | Current save/reload/conflict regression coverage is in place for note, kanban, and canvas, and `pnpm test` exits cleanly again. |
| Stage 3 `CanvasPage` decomposition | In progress | 11 slices landed | `CanvasPickerDialog`, `CanvasNodeTypes`, `CanvasEdgeTypes`, `CanvasPreviewUtils`, `CanvasEdgeInspector`, `CanvasToolbar`, `useCanvasViewportControls`, `useCanvasNodeCommands`, `useCanvasPreviews`, `useCanvasDocumentSession`, and `CanvasFlowNodeUtils` are extracted and tested. |
| Stage 3 `ImageView` decomposition | Complete enough for now | 8 landed slices | The utility extraction, annotations popover/header UI extraction, additive toolbar extraction, additive stage rendering extraction, permanent stage/crop footer extraction, permanent toolbar extraction, image document/session hook extraction, and interaction hook extraction are landed. `ImageView.tsx` is down to 848 lines and now reads primarily as orchestration/composition. |
| Remaining large-file decomposition | Started | Early progress | `ImageView` is now underway; `MarkdownEditor`, `CardDialog`, `SettingsModal`, and `CommandBar` still need decomposition after it. |
| Deferred document-session retry | Deferred | 0% | Intentionally blocked on decomposition, then retried in small document-type slices. |
| Later roadmap | Not started | 0% | Live session expansion, recovery UX, and broader product features remain later work. |

## Completed Work

### Stage 1: Reliability fixes

- Added `src/lib/documentSession.ts` as the stable low-level helper for:
  - saved hash tracking
  - write timestamps
  - initial-load autosave suppression
  - snapshot timing policy
- Fixed note loading/saving so notes do not autosave immediately after initial load.
- Added kanban conflict surfacing through the shared `ConflictDialog`.
- Added kanban snapshot creation after successful saves.
- Added canvas conflict surfacing through the shared `ConflictDialog`.
- Added canvas snapshot creation after successful saves.
- Fixed canvas hash handling so external reloads do not leave stale save hashes behind.
- Fixed collaboration presence lifecycle so chat/sidebar visibility does not clear presence.
- Fixed drag-move file handling so moved paths propagate into `editorStore.renameTab`.

### Safe Phase 2 work kept in place

- Expanded transport-backed config/listener usage in collaboration flows.
- Switched kanban config reads to `CollabTransport`.
- Switched vault permissions config reads/listeners to `CollabTransport`.
- Normalized shortcut handling away from punctuation-based primaries.
- Updated PDF, image, and canvas zoom bindings to named-key primaries.
- Hardened `AppShell` so note/image/pdf/canvas/kanban views remount by `type:path`, preventing stale state leakage across tab switches.

### Stage 3 progress: regression harness and initial coverage

- Added a Vitest + jsdom frontend test harness.
- Added tests for `useDocumentSessionState()` helper behavior.
- Added tests for `editorStore.renameTab()` path propagation.
- Added tests for `AppShell` remounting the active document view on same-type tab switches.
- Added tests for `CollabProvider` presence stability.
- Added tests for `NoteView` reload behavior on external modification.
- Added tests for `KanbanPage` conflict surfacing and snapshot creation on save.
- Added tests for `KanbanPage` watcher reload behavior for clean versus locally edited state.
- Added tests for `CanvasPage` conflict surfacing and snapshot creation on save.
- Added tests for `CanvasPage` watcher reload behavior for clean versus locally edited state.

### Additional reliability hardening landed during test work

- `KanbanPage` now blocks watcher-driven reloads while local unsaved edits are present.
- `CanvasPage` now blocks watcher-driven reloads while local unsaved edits are present.
- Fixed a `CanvasPage` mount-time reload loop that caused the full Vitest suite to hang. The cause was an unstable inline `buildFlowNode` callback passed into `useCanvasDocumentSession`; it is now memoized so document load runs once per real dependency change instead of once per render.

## Current Focus

### Regression coverage status

The core save/conflict/reload paths for note, kanban, and canvas are now covered.

What remains is lower priority compared with the planned file decomposition:

- broader tab-switch permutations beyond the current same-type remount safeguard
- any additional targeted unmount/remount tests that become useful during decomposition

### CanvasPage decomposition in progress

Eleven decomposition slices have landed:

- `CanvasPickerDialog` has been extracted from `CanvasPage.tsx` into `src/components/canvas/CanvasPickerDialog.tsx`
- `CanvasNodeTypes` has been extracted from `CanvasPage.tsx` into `src/components/canvas/CanvasNodeTypes.tsx`
- `CanvasEdgeTypes` has been extracted from `CanvasPage.tsx` into `src/components/canvas/CanvasEdgeTypes.tsx`
- `CanvasPreviewUtils` has been extracted from `CanvasPage.tsx` into `src/components/canvas/CanvasPreviewUtils.ts`
- `CanvasEdgeInspector` has been extracted from `CanvasPage.tsx` into `src/components/canvas/CanvasEdgeInspector.tsx`
- `CanvasToolbar` has been extracted from `CanvasPage.tsx` into `src/components/canvas/CanvasToolbar.tsx`
- `useCanvasViewportControls` has been extracted from `CanvasPage.tsx` into `src/components/canvas/useCanvasViewportControls.ts`
- `useCanvasNodeCommands` has been extracted from `CanvasPage.tsx` into `src/components/canvas/useCanvasNodeCommands.ts`
- `useCanvasPreviews` has been extracted from `CanvasPage.tsx` into `src/components/canvas/useCanvasPreviews.ts`
- `useCanvasDocumentSession` has been extracted from `CanvasPage.tsx` into `src/components/canvas/useCanvasDocumentSession.ts`
- `CanvasFlowNodeUtils` has been extracted from `CanvasPage.tsx` into `src/components/canvas/CanvasFlowNodeUtils.ts`
- all extracted canvas modules now have their own test coverage

Next decomposition slices should keep the same approach:

- extract render-only canvas UI before deeper persistence/session logic
- preserve the already-stabilized save and reload behavior while reducing file size

### ImageView decomposition starting

`ImageView.tsx` is the next large-file target after the `CanvasPage` work. Based on the current shape of the file, the expected decomposition is roughly 6 to 8 slices:

- image editing math and file/output helpers
- additive overlay header and control UI
- additive overlay stage rendering
- permanent-edit toolbar and crop UI
- keyboard/pointer interaction hooks
- image load/save/session logic
- final top-level composition cleanup

The first slice is now landed:

- `ImageViewUtils` has been extracted from `ImageView.tsx` into `src/components/image/ImageViewUtils.ts`
- `ImageViewUtils.test.ts` covers the extracted helper behavior

The second slice is now landed:

- `ImageAnnotationsPopover` has been extracted from `ImageView.tsx` into `src/components/image/ImageAnnotationsPopover.tsx`
- `ImageAnnotationsPopover.test.tsx` covers the extracted annotation list behavior

The third slice is now landed:

- `ImageAdditiveToolbar` has been extracted from `ImageView.tsx` into `src/components/image/ImageAdditiveToolbar.tsx`
- `ImageAdditiveToolbar.test.tsx` covers the additive top-bar control behavior

The fourth slice is now landed:

- `ImageAdditiveStage` has been extracted from `ImageView.tsx` into `src/components/image/ImageAdditiveStage.tsx`
- `ImageAdditiveStage.test.tsx` covers additive stage rendering and interaction forwarding

The fifth slice is now landed:

- `ImagePermanentStage` and `ImageCropFooter` have been extracted from `ImageView.tsx` into `src/components/image/ImagePermanentStage.tsx`
- `ImagePermanentStage.test.tsx` covers permanent preview/crop rendering and crop footer actions

The sixth slice is now landed:

- `ImagePermanentToolbar` has been extracted from `ImageView.tsx` into `src/components/image/ImagePermanentToolbar.tsx`
- `ImagePermanentToolbar.test.tsx` covers permanent editing toolbar behavior

The seventh slice is now landed:

- `useImageDocumentSession` has been extracted from `ImageView.tsx` into `src/components/image/useImageDocumentSession.ts`
- `useImageDocumentSession.test.tsx` covers the image load/session and additive overlay persistence behavior

The eighth slice is now landed:

- `useImageInteractions` has been extracted from `ImageView.tsx` into `src/components/image/useImageInteractions.ts`
- `useImageInteractions.test.tsx` covers additive draft creation and keyboard shortcut interaction behavior

Current assessment:

- `ImageView.tsx` is now down to 848 lines from 2139.
- The remaining code is mostly coordinator glue, local state wiring, and top-level composition.
- Further splitting is possible, but the next slices would be smaller-value glue refactors rather than the high-yield decompositions we have been landing.
- Recommendation: stop the `ImageView` split here and move to the next stabilization target unless a new bug or awkward boundary shows up during normal work.

### Large-file decomposition still pending

These are still the main decomposition targets:

- `src/views/CanvasPage.tsx`
- `src/views/ImageView.tsx`
- `src/components/editor/MarkdownEditor.tsx`
- `src/components/kanban/CardDialog.tsx`
- `src/components/settings/SettingsModal.tsx`
- `src/components/command-bar/CommandBar.tsx`

Recommended decomposition direction:

- extract document-session hooks
- extract canvas save/load/preview hooks
- extract kanban editing/move/save hooks
- split large dialogs into focused subcomponents

## Deferred Architecture Retry

The broader Phase 2 document-session refactor is deferred.

Current decision:

- `useDocumentSessionState()` remains the stable baseline.
- The earlier broader shared document-session refactor was rolled back after it regressed document loading and tab switching.
- A retry should happen only after the remaining regression coverage is in place.
- A retry should happen only after the largest stateful views are decomposed.
- Retry order: `NoteView`, then `KanbanPage`, then `CanvasPage`.
- `ImageView` and `PdfView` are out of scope for the shared editable-document session abstraction unless their lifecycle later matches note/kanban/canvas.

## Later Roadmap

These items are still intentionally later than the stabilization and decomposition work:

- live collaboration/session model promised by repo docs
- richer live awareness for note/kanban/canvas
- recovery/versioning UX on top of snapshots
- compare/restore/recover flows
- stronger search/navigation improvements
- more advanced PDF/image/web-card preview improvements
- collaboration quality-of-life improvements such as:
  - presence in document headers
  - clearer role/read-only indicators
  - richer conflict resolution context

## Current Status

### Done

- note/kanban/canvas reliability fixes are in place
- kanban/canvas conflict handling is in place
- kanban/canvas snapshot creation is in place
- kanban/canvas dirty-state reload protection is in place
- presence lifecycle bug tied to chat visibility is fixed
- drag-move tab/path desync is fixed
- safe Phase 2 transport and shortcut cleanup is in place
- shell remount hardening is in place
- frontend regression test harness is in place
- regression coverage for helper, tab propagation, remounting, presence, note reload, and kanban/canvas save and reload behavior is in place
- the full `pnpm test` suite exits cleanly again
- eleven `CanvasPage` decomposition slices are in place

### Not done yet

- large-file decomposition
- deferred shared document-session retry
- live-sync/session expansion
- recovery/versioning UX
- broader product roadmap work

## Next Steps

1. Continue decomposing `CanvasPage.tsx`, starting with more render-only canvas UI pieces before touching deeper session logic.
2. Decompose the other large stateful files after the `CanvasPage` split is in a safer place.
3. Retry the broader shared document-session refactor in this order: `NoteView`, `KanbanPage`, `CanvasPage`.
4. Add any additional focused unmount/remount regression tests needed during that decomposition and retry work.
5. After that architecture work is stable, continue with live-session and recovery/versioning work.
