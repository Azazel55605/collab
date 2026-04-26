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
| Stage 3 `MarkdownEditor` decomposition | Complete enough for now | 7 landed slices | The inline color preview plugin, indent/ligature plugin extraction, editor construction/config extraction, theme/highlighting extraction, drop/open/preview integration extraction, imperative handle extraction, and context-menu/clipboard extraction are landed. `MarkdownEditor.tsx` is down to 486 lines and now reads primarily as orchestration/composition. |
| Stage 3 `CardDialog` decomposition | Complete enough for now | 7 landed slices | The draft/session hook, move/archive/status actions extraction, checklist/comments hook, sidebar/meta UI extraction, tags/attachments UI extraction, checklist/comments UI extraction, and move-tags prompt extraction are landed. `CardDialog.tsx` is down to 354 lines and now reads primarily as orchestration/composition. |
| Stage 3 `SettingsModal` decomposition | Complete enough for now | 7 landed slices | The shared settings controls plus appearance, editor, general, display, canvas, calendar, and profile section extractions are landed. `SettingsModal.tsx` is down to 283 lines and now reads primarily as shell/composition glue. |
| Remaining large-file decomposition | In progress | CommandBar next | `ImageView`, `MarkdownEditor`, `CardDialog`, and `SettingsModal` are complete enough for now; `CommandBar` is the next obvious large-file target. |
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

### ImageView decomposition completed enough for now

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

### MarkdownEditor decomposition starting

`MarkdownEditor.tsx` is now the active large-file target. Based on its current shape, the expected decomposition is roughly 6 to 8 slices:

- editor document helpers
- theme and highlighting configuration
- indent and ligature plugins
- inline color preview plugin
- editor construction/config hook
- drop/open/preview integration hook
- imperative editor handle helpers
- context-menu and clipboard glue

The first slice is now landed:

- `colorPreview` has been extracted from `MarkdownEditor.tsx` into `src/components/editor/colorPreview.ts`
- `colorPreview.test.ts` covers color parsing, match detection, and disabled-extension behavior

The second slice is now landed:

- `indentationPlugins` has been extracted from `MarkdownEditor.tsx` into `src/components/editor/indentationPlugins.ts`
- `indentationPlugins.test.tsx` covers indentation facet configuration, empty-selection tab insertion, and basic plugin wiring

The third slice is now landed:

- `markdownEditorViewConfig` has been extracted from `MarkdownEditor.tsx` into `src/components/editor/markdownEditorViewConfig.ts`
- `markdownEditorViewConfig.test.ts` covers compartment setup, reconfigure effect generation, and editor-state construction with the configured indentation state

The fourth slice is now landed:

- `markdownEditorTheme` has been extracted from `MarkdownEditor.tsx` into `src/components/editor/markdownEditorTheme.ts`
- `markdownEditorTheme.test.ts` covers the shared theme and highlight-style builders used by both `MarkdownEditor` and `CodeBlockEditorDialog`

The fifth slice is now landed:

- `useMarkdownEditorIntegrations` has been extracted from `MarkdownEditor.tsx` into `src/components/editor/useMarkdownEditorIntegrations.ts`
- `useMarkdownEditorIntegrations.test.ts` covers hover preview resolution, dropped-image import behavior, and native drag-drop dedupe behavior

The sixth slice is now landed:

- `useMarkdownEditorHandle` has been extracted from `MarkdownEditor.tsx` into `src/components/editor/useMarkdownEditorHandle.ts`
- `useMarkdownEditorHandle.test.ts` covers wrap/line/snippet/range editor mutations behind the imperative editor handle

The seventh slice is now landed:

- `MarkdownEditorContextMenu` has been extracted from `MarkdownEditor.tsx` into `src/components/editor/MarkdownEditorContextMenu.tsx`
- `MarkdownEditorContextMenu.test.tsx` covers clipboard actions, select-all behavior, inline formatting actions, and the tags-line event dispatch

Current assessment:

- `MarkdownEditor.tsx` is now down to 486 lines and mostly acts as orchestration/composition glue.
- The highest-yield seams have already been extracted.
- Further splitting is possible around the document-helper functions, but the remaining work is lower-yield than the slices already landed.
- Recommendation: stop the `MarkdownEditor` split here and move to the next stabilization target unless a new bug or awkward boundary shows up during normal work.

### CardDialog decomposition queued next

`CardDialog.tsx` is the next active large-file target. Based on its current shape at 1030 lines, the realistic decomposition is roughly 6 to 8 slices:

- small utilities and card/file helpers
- draft/session hook
- move/archive/status actions hook
- metadata/sidebar actions hook
- checklist/comments hook
- extracted tags/attachments/checklist UI sections
- extracted sidebar/meta UI sections
- move-tags prompt dialog cleanup

Recommended order:

1. draft/session hook
2. move/archive/status actions hook
3. checklist/comments hook
4. larger UI section extraction

Current assessment:

- `CardDialog.tsx` has several clear stateful seams and should decompose cleanly.
- The highest-value work is in the draft/update/move logic before the render-only UI splits.
- Estimated practical total: about 7 slices, with a realistic range of 6 to 8.

The first slice is now landed:

- `useCardDialogDraftSession` has been extracted from `CardDialog.tsx` into `src/components/kanban/useCardDialogDraftSession.ts`
- `useCardDialogDraftSession.test.tsx` covers draft normalization, debounced board flush behavior, and card replacement in the target column

The second slice is now landed:

- `useCardDialogActions` has been extracted from `CardDialog.tsx` into `src/components/kanban/useCardDialogActions.ts`
- `useCardDialogActions.test.tsx` covers move/archive/delete helpers, prompt-tag board updates, and done-state action behavior

The third slice is now landed:

- `useCardDialogChecklistComments` has been extracted from `CardDialog.tsx` into `src/components/kanban/useCardDialogChecklistComments.ts`
- `useCardDialogChecklistComments.test.tsx` covers checklist/comment helpers, linked-card title resolution, and checklist/comment hook behavior

The fourth slice is now landed:

- `CardDialogSidebar` has been extracted from `CardDialog.tsx` into `src/components/kanban/CardDialogSidebar.tsx`
- `CardDialogSidebar.test.tsx` covers priority/assignee/archive/delete sidebar interactions and delete-confirmation behavior

The fifth slice is now landed:

- `CardDialogTagsAttachments` has been extracted from `CardDialog.tsx` into `src/components/kanban/CardDialogTagsAttachments.tsx`
- `CardDialogTagsAttachments.test.tsx` covers tag add/remove flows, suggested-tag application, and attachment open/remove/picker actions

The sixth slice is now landed:

- `CardDialogChecklistComments` has been extracted from `CardDialog.tsx` into `src/components/kanban/CardDialogChecklistComments.tsx`
- `CardDialogChecklistComments.test.tsx` covers checklist toggle/edit/remove flows, linked-card checklist insertion, comment posting, and comment deletion

The seventh slice is now landed:

- `CardDialogMoveTagsPrompt` has been extracted from `CardDialog.tsx` into `src/components/kanban/CardDialogMoveTagsPrompt.tsx`
- `CardDialogMoveTagsPrompt.test.tsx` covers prompt rendering plus dismiss/apply-once/always-apply actions

Current assessment:

- `CardDialog.tsx` is now down to 354 lines from 1030.
- The remaining code is mostly coordinator glue, title/description editing, and top-level composition.
- Further splitting is possible, but the next cuts would be much lower-yield than the slices already landed.
- The state-heavy logic is already in much better shape because the draft/session, action, checklist/comment, and sidebar responsibilities are now separated.
- Recommendation: stop the `CardDialog` split here and move to the next stabilization target unless a new bug or awkward boundary shows up during normal work.

### SettingsModal decomposition queued next

`SettingsModal.tsx` is the next active large-file target. Based on its current shape at 952 lines, the realistic decomposition is roughly 6 to 8 slices:

- sidebar/search shell
- shared settings-control helpers beyond the current small local helpers
- general settings section
- appearance settings section
- editor settings section
- display/canvas/calendar grouped settings sections
- profile section
- about/update glue and final composition cleanup

Recommended order:

1. extract one of the heavier settings sections first
2. extract the sidebar/search shell if it still carries too much local wiring
3. extract shared section components only where they simplify the remaining composition
4. leave final about/footer glue for last

Current assessment:

- `SettingsModal.tsx` has several clear render-section seams and should decompose cleanly.
- The most likely high-yield slices are the larger tab content sections, especially appearance and editor.
- Estimated practical total: about 7 slices, with a realistic range of 6 to 8.

The first slice is now landed:

- `settingsControls.tsx` has been extracted from `SettingsModal.tsx` into `src/components/settings/settingsControls.tsx`
- `SettingsAppearanceSection` has been extracted from `SettingsModal.tsx` into `src/components/settings/SettingsAppearanceSection.tsx`
- `SettingsAppearanceSection.test.tsx` covers theme, accent, interface font, and interface font-size interactions

The second slice is now landed:

- `SettingsEditorSection` has been extracted from `SettingsModal.tsx` into `src/components/settings/SettingsEditorSection.tsx`
- `SettingsEditorSection.test.tsx` covers editor font, font-size, indentation, and inline color-preview settings interactions

The third slice is now landed:

- `SettingsGeneralSection` has been extracted from `SettingsModal.tsx` into `src/components/settings/SettingsGeneralSection.tsx`
- `SettingsGeneralSection.test.tsx` covers startup, web-preview, and delete-confirmation settings interactions

The fourth slice is now landed:

- `SettingsDisplaySection` has been extracted from `SettingsModal.tsx` into `src/components/settings/SettingsDisplaySection.tsx`
- `SettingsDisplaySection.test.tsx` covers interface scale and motion settings interactions

The fifth slice is now landed:

- `SettingsCanvasSection` has been extracted from `SettingsModal.tsx` into `src/components/settings/SettingsCanvasSection.tsx`
- `SettingsCanvasSection.test.tsx` covers canvas web-card mode and auto-load settings interactions

The sixth slice is now landed:

- `SettingsCalendarSection` has been extracted from `SettingsModal.tsx` into `src/components/settings/SettingsCalendarSection.tsx`
- `SettingsCalendarSection.test.tsx` covers date-format and week-start settings interactions

The seventh slice is now landed:

- `SettingsProfileSection` has been extracted from `SettingsModal.tsx` into `src/components/settings/SettingsProfileSection.tsx`
- `SettingsProfileSection.test.tsx` covers profile name editing and save action behavior

Current assessment:

- `SettingsModal.tsx` is now down to 283 lines from 952.
- The remaining code is mostly search/sidebar shell, tab switching, about/shortcuts mounting, and footer composition.
- Further splitting is possible, but the next cuts would be lower-yield than the slices already landed.
- The shared settings-control scaffolding is now in place, which should make the next settings slices cleaner and more consistent.
- Recommendation: stop the `SettingsModal` split here and move to the next stabilization target unless a new bug or awkward boundary shows up during normal work.

### Large-file decomposition still pending

These are still the main decomposition targets:

- `src/views/CanvasPage.tsx`
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

1. Continue decomposing `MarkdownEditor.tsx`, with the editor construction/config hook as the next highest-value slice.
2. Decompose `CardDialog.tsx`, `SettingsModal.tsx`, and `CommandBar.tsx` after `MarkdownEditor` is in a safer place.
3. Retry the broader shared document-session refactor in this order: `NoteView`, `KanbanPage`, `CanvasPage`.
4. Add any additional focused unmount/remount regression tests needed during decomposition and the later retry work.
5. After that architecture work is stable, continue with live-session and recovery/versioning work.
