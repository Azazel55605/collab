# Markdown Pages And Print Preview

Implemented: 2026-11-09. This is a follow-on feature, separate from the completed
desktop audit. Notifications and icon customization are outside this change.

## Implementation tracker

- [x] Editable Pages mode in the existing Markdown editor. Switching layout keeps
      the same CodeMirror document, selection, undo history, and collaboration binding.
- [x] Shared A4/Letter, portrait/landscape, and narrow/normal/wide margin preferences.
      The Pages preference and paper settings persist locally.
- [x] Rendered print preview with separate numbered sheets, browser-measured
      content fragmentation, continuation table headers, and oversized asset fitting.
- [x] Explicit Print / Save PDF action after pagination completes; opening the
      preview does not immediately open the system print dialog.
- [x] Editor-triggered exports snapshot the current document, including unsaved
      edits, without changing save/conflict behavior.
- [x] Layout decorations and print fragments never become Markdown content.
- [ ] Installed desktop acceptance: Linux WebKitGTK, Windows WebView2 and macOS
      printing/PDF output, mixed scripts, IME, selection across sheets, live editing,
      large notes and diagrams, and physical paper/printer settings.

## Layout ownership

`notePageLayout.ts` defines physical page dimensions. `notePageStore.ts` owns
local view preferences. `noteEditorPagination.ts` adds visual gaps using a
CodeMirror state field, measuring and refining its height map without replacing
the editor. Offscreen height estimates refine as content enters the viewport.
Oversized wrapped source lines break at word boundaries.

`PaginatedNotePreview` waits for Markdown assets and fonts, then `paginateNote.ts`
fragments a rendered snapshot into physical sheets. Paragraphs, code, lists and
nested blocks can continue across pages. Table headers repeat; oversized atomic
assets fit a sheet. The print stylesheet prints these same prepared sheets,
using the selected paper size with zero additional CSS page margins.

Editable page boundaries reflect the current live Markdown styling, including
syntax exposed at the cursor and the user's editor font. Rendered print pages
use the print typography; they can have different page counts. The preview is
a snapshot: close and reopen it to include subsequent edits. Printer-dialog
paper size, scaling and system headers/footers can affect physical output.

## Validation

Focused regression tests cover page geometry, splitting, unchanged Markdown,
selection and undo through layout changes, current-content export, and explicit
printing after readiness. Browser checks use the actual editor and renderer in
a temporary harness with Tauri IPC mocked; they are not installed native acceptance.
Full repository checks and browser/PDF results are recorded with the implementation.

### Verified on 2026-11-09

- Desktop frontend suite executed; all timing failures passed when their eight
  affected files were rerun with one worker (156 tests). The existing security
  dependency test passed using the installed patched `braces` through `NODE_PATH`.
- Focused editor/preview regressions passed, including the fractional Letter
  landscape height regression; TypeScript and changed-file formatting passed.
- Desktop production build and bundle budgets passed. Admin tests/build and
  mobile tests passed with isolated reruns of their initial timeout failures.
- `cargo test --workspace`, `cargo check --workspace`, crate boundaries and
  version alignment passed. Changed-file ESLint has no errors; the existing
  NoteView memo dependency warning remains.
- Playwright Chromium on `127.0.0.1:1427`, 1440×1000, using the real components
  with mocked Tauri IPC: boundary insertion, undo after toggling Pages, A4/Letter
  and orientation changes passed without application errors. Browser plugin was
  unavailable, so the installed Playwright runtime was used.
- Long fixture: 24 sections, an oversized paragraph, 80 table rows and 100 code
  lines. Letter landscape produced 18 preview pages with no body overflow; A4
  portrait preview and printed PDF both produced 14 pages. PDF text retained the
  final table row, final code line and end marker; first/last pages were rendered
  and visually inspected. These are browser/PDF results, not native certification.
- Compose configuration passed. The isolated `collab-pagination-smoke` server
  smoke attempt stopped during image build on a Debian repository `Hash Sum
mismatch`, alongside upstream dependency download errors. Server health checks
  were not reached; the temporary Compose project was taken down.
