# Remaining Stabilization Steps

## Summary

This document captures the remaining work after the large-file decomposition pass.

The decomposition phase is complete enough for now. The next work should **not** be more UI splitting. The next meaningful phase is the deferred document-session architecture retry, but only in small, controlled steps.

## Current Pause Point

The codebase is in a good holding state:

- Stage 1 reliability fixes are in place.
- Safe Phase 2 cleanup is in place.
- Regression coverage is in place for the current save/reload/conflict gates.
- Large-file decomposition is complete enough for:
  - `CanvasPage`
  - `ImageView`
  - `MarkdownEditor`
  - `CardDialog`
  - `SettingsModal`
  - `CommandBar`
- `pnpm test`, `pnpm exec tsc --noEmit`, and `cargo check` are clean.

## Remaining Main Phase

### Deferred document-session architecture retry

This is the next real stabilization phase.

Important constraints:

- Do **not** retry the old broad shared-session refactor all at once.
- Keep `src/lib/documentSession.ts` as the stable low-level baseline.
- Retry the architecture one document type at a time.
- Preserve existing behavior first; do not mix in feature work during the retry.

Retry order:

1. `NoteView`
2. `KanbanPage`
3. `CanvasPage`

Out of scope for this retry:

- `ImageView`
- `PdfView`
- live collaboration/session expansion
- recovery/versioning UX

## Recommended Resume Plan

### Step 1: Update planning docs before resuming

Before implementation resumes:

- update `COLLAB_STABILIZATION_OVERVIEW.md`
- make sure it reflects that large-file decomposition is complete enough
- make sure it clearly shows the next phase is the deferred architecture retry

### Step 2: Start with `NoteView` only

Do not begin with kanban or canvas.

Recommended first slice:

- extract `NoteView` load/save/external-reload/autosave/conflict/snapshot wiring into a note-specific session hook
- suggested shape: `src/components/editor/useNoteDocumentSession.ts` or similar

Requirements for the `NoteView` retry:

- no autosave on initial load
- saved hash stays in sync
- external reload works when local state is clean
- dirty local edits are not silently overwritten
- optimistic-write conflicts still surface correctly
- snapshot cadence remains correct
- tab switching stays safe with the existing `AppShell` remount behavior

### Step 3: Reassess after `NoteView`

After the `NoteView` retry lands:

- run the full verification pass
- manually sanity-check document switching and reload behavior
- decide whether the abstraction is actually clearer and safer

Only continue if the answer is yes.

If the retry looks too coupled or awkward:

- stop
- keep the note-specific extraction
- do not force the broader shared abstraction yet

### Step 4: Move to `KanbanPage`

Only after `NoteView` is stable:

- extract kanban session/save/reload/conflict/snapshot behavior behind the same narrow pattern
- preserve existing conflict and snapshot behavior exactly
- do not change board semantics while doing the extraction

Must preserve:

- debounced write behavior
- conflict surfacing
- snapshot creation
- dirty-state reload protection

### Step 5: Move to `CanvasPage`

Only after `KanbanPage` is stable:

- apply the same session architecture pattern to canvas
- keep canvas preview, viewport, and node/edge behavior separate from the save/session core

Must preserve:

- debounced write behavior
- conflict surfacing
- snapshot creation
- dirty-state reload protection
- current extracted hook/component boundaries

## Testing Requirements When Resuming

The following checks should stay green throughout the retry:

- note does not autosave on initial load
- note reload behavior respects clean vs dirty state
- kanban conflicts surface through the shared conflict flow
- kanban snapshots still occur on successful saves
- kanban watcher reload behavior still respects local dirty state
- canvas conflicts surface through the shared conflict flow
- canvas snapshots still occur on successful saves
- canvas watcher reload behavior still respects local dirty state
- repeated tab switching does not leak stale state or crash
- presence does not flicker when chat/sidebar visibility changes

Verification commands:

```bash
pnpm test
pnpm exec tsc --noEmit
cd src-tauri && cargo check
```

## Things To Avoid

- Do not retry a generic cross-document session abstraction in one jump.
- Do not combine the retry with live-sync work.
- Do not combine the retry with recovery/versioning UX.
- Do not pull `ImageView` or `PdfView` into the editable-document session abstraction.
- Do not weaken the test suite just to make the retry easier.

## After The Retry Phase

Once `NoteView`, `KanbanPage`, and `CanvasPage` are stable under the narrower retry:

1. reassess whether the shared session architecture is actually successful
2. only then resume:
   - live collaboration/session expansion
   - recovery/versioning UX
   - broader roadmap features

## Short Version

When we come back to this:

1. update the overview doc
2. retry the session architecture with `NoteView` only
3. verify and reassess
4. then `KanbanPage`
5. then `CanvasPage`
6. only after that move on to later collaboration and recovery work
