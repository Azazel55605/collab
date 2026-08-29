# `.sheet` Workbook Reference

The Phase 9 reference for Collab's spreadsheet document: what it supports, what
it limits, how the keyboard works, what collaboration guarantees, and how it
recovers when something goes wrong.

Related documents:

- `docs/plans/advanced-tables-formula-support.md` — the function-by-function
  compatibility table.
- `docs/plans/advanced-tables-phase0-contract.md` — measured baselines, the
  performance budgets, and the structural limits.
- `docs/build/advanced-tables-release-validation.md` — the per-platform
  validation matrix and release gates.

## Document Model

| Property       | Value                                                   |
| -------------- | ------------------------------------------------------- |
| Extension      | `.sheet`                                                |
| Media type     | `application/vnd.collab.sheet+json`                     |
| Document kind  | `collab-sheet`                                          |
| Schema version | `1`                                                     |
| Storage        | Sparse structured JSON through the normal document APIs |

One file is one workbook holding one or more worksheets. Row, column,
worksheet, style, table, chart, and named-range identities are stable strings;
A1 addresses are always derived from position, never stored. Formula source is
authoritative and computed values are never written to the file, so a workbook
recovered from any revision recalculates rather than showing stale numbers.

`.xlsx` and `.csv` are conversion formats only. Collab converts them into a new
`.sheet` document and writes separate exported copies; neither is ever the
editable backing model, and round trips are lossy. The exact supported features
are in `docs/desktop/sheet-conversion.md`.

## Limits

Enforced by `SHEET_LIMITS` in `src/types/sheet.ts` and mirrored in
`crates/collab-documents/src/sheet.rs`. A document that exceeds a limit is
rejected with a clear error — never silently truncated.

| Limit                             | Value             |
| --------------------------------- | ----------------- |
| Worksheets per workbook           | 200               |
| Rows per worksheet                | 1,000,000         |
| Columns per worksheet             | 16,384            |
| Populated cells per worksheet     | 500,000           |
| Populated cells per workbook      | 1,000,000         |
| Formula cells per workbook        | 200,000           |
| Formula source length             | 8,192 characters  |
| Cell text length                  | 32,768 characters |
| Worksheet name length             | 64 characters     |
| Styles per workbook               | 10,000            |
| Named ranges per workbook         | 1,000             |
| Merged ranges per worksheet       | 10,000            |
| Conditional formats per worksheet | 500               |
| Charts per worksheet              | 50                |
| Copy / paste selection            | 100,000 cells     |
| Document size                     | 64 MiB            |

Evaluation is separately bounded by `SheetFormulaBudget`: 200,000 formula cells
and a 5 s wall clock per evaluation on desktop. Mobile and background callers
pass smaller budgets rather than trusting the document.

## Formulas

The supported baseline, the unsupported-function behavior, and the exact error
codes are documented in `advanced-tables-formula-support.md`. In short:

- An unknown function evaluates to `#NAME?`; a recognized but unimplemented one
  to `#N/IMPL!`; malformed source to `#ERROR!`; a cycle to `#CIRC!`; and an
  evaluation stopped by the Collab budget to `#TIMEOUT!`.
- No formula can reach the network, the filesystem, environment variables,
  credentials, external workbooks, or executable code.
- Named formulas stay symbolic in the document and expand only at the native
  evaluation and reference-inspection boundaries.
- Kanban and calendar connections are explicit, refreshable snapshots that
  materialize inert values. Formulas never trigger them.

## Keyboard

Every binding uses `KeyboardEvent.key`, so it is layout-independent — there are
no punctuation or physical-position shortcuts in the grid.

### Navigation

| Key                           | Action                                    |
| ----------------------------- | ----------------------------------------- |
| Arrow keys                    | Move the active cell                      |
| `Ctrl`/`Cmd` + arrow          | Jump to the next populated edge           |
| `Shift` + arrow               | Extend the selection                      |
| `Tab` / `Shift`+`Tab`         | Move right / left                         |
| `PageUp` / `PageDown`         | Move one viewport                         |
| `Home` / `End`                | Start / end of the row                    |
| `Ctrl`/`Cmd` + `Home` / `End` | Start / end of the grid                   |
| `Ctrl`/`Cmd` + `A`            | Select the whole worksheet                |
| `Escape`                      | Collapse the selection to the active cell |

### Editing

| Key                                    | Action                                  |
| -------------------------------------- | --------------------------------------- |
| Any printable character                | Start editing with that character       |
| `Enter` or `F2`                        | Edit the active cell's existing content |
| `Enter` (in the editor)                | Commit and move down                    |
| `Tab` (in the editor)                  | Commit and move right                   |
| `Escape` (in the editor)               | Cancel and return focus to the grid     |
| `Delete` / `Backspace`                 | Clear the selection                     |
| `Ctrl`/`Cmd` + `Z` / `Shift`+`Z` / `Y` | Undo / redo                             |
| `Ctrl`/`Cmd` + `F`                     | Find and replace                        |
| `Ctrl`/`Cmd` + `C` / `X` / `V`         | Copy / cut / paste                      |

Read-only workbooks (a hosted viewer, or a workbook written by a newer schema)
accept every navigation key and no editing key.

## Accessibility

The grid paints cells to a canvas, which has no text for assistive technology
to read. It therefore exposes:

- `role="grid"` with `aria-rowcount`, `aria-colcount`, and `aria-readonly`;
- `role="columnheader"` / `role="rowheader"` for the visible headers;
- one `role="gridcell"` describing the active cell, referenced by
  `aria-activedescendant`, giving the address, the displayed value, the formula
  source, and whether the cell has a note, link, or attachments;
- a polite live region announcing the selection — the cell for a single cell,
  the shape and corners for a range, and the read-only state.

The deliberate limitation: the _whole_ visible window is not mirrored into the
DOM. Doing so would add hundreds of nodes per scroll frame and break the scroll
budget, so browse-mode table navigation reads the active cell rather than the
surrounding grid. Focus-mode navigation with the arrow keys is the supported
path and covers every cell.

Contrast, zoom, and motion:

- The grid takes text color from the active theme. The only colors it invents
  are faint state tints (≤ 20% alpha) painted behind that text, neutral grid
  lines, and four fixed indicators (formula error, note corner, link corner,
  default border) that mean the same thing in every theme.
- Geometry is in CSS pixels and the canvas backing store is scaled by device
  pixel ratio, so app zoom and HiDPI displays stay sharp.
- The grid has no animation of its own. The shared save/loading spinner is
  suppressed by the app-wide `[data-motion='off']` rule, which follows both the
  app's animation setting and the OS `prefers-reduced-motion` preference.

## Collaboration

- Hosted workbooks are a first-class hosted document type and use the shared
  structured Yjs room. They are never opened as note text.
- Ephemeral state — active worksheet, active cell, selected range — travels in
  awareness. It is never persisted into the workbook.
- Formula results stay local derived state. The server never evaluates formulas
  as an authorization or persistence requirement.
- Offline edits are queued in the native replica and replayed on reconnect.
  Cached content and the pending queue are encrypted at rest.
- REST and offline revision recovery uses the stable-ID merge in
  `src/lib/sheet/collaboration.ts`. Concurrent structural inserts are ordered
  deterministically; overlapping edits and edits to a deleted target become
  reported conflicts in the shared reconciliation UI rather than a silent
  overwrite.

Mobile editing is deliberately bounded to values, formulas, a small formatting
set, table column filters, and validation-backed cells. Structural operations,
charts, named ranges, data connections, and protection editing are desktop-only.

## Recovery

| Situation                                                                                                                  | Behavior                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Empty `.sheet` file                                                                                                        | Opens as a new workbook — a file created but never written is not corruption                                        |
| Truncated or non-JSON content                                                                                              | Rejected with `invalid-json`; the grid never opens blank over recoverable bytes                                     |
| Wrong document kind                                                                                                        | Rejected with `wrong-kind`                                                                                          |
| Missing or invalid schema version                                                                                          | Rejected with `invalid-schema-version`                                                                              |
| Newer schema version                                                                                                       | Opens read-only; never normalized or rewritten                                                                      |
| Over a structural limit                                                                                                    | Rejected with `limit-exceeded`                                                                                      |
| Missing worksheets, duplicate or invalid row/column identifiers, cells pointing at removed rows, duplicate worksheet names | Repaired on open, and every repair is reported to the user                                                          |
| Unknown fields from a newer build                                                                                          | Preserved verbatim at document, worksheet, and cell level                                                           |
| Crash with unsynced edits                                                                                                  | The replica's last synced revision is the merge base, so the pending edit replays against the newer server revision |
| Conflicting concurrent edits                                                                                               | Reported as `overlapping-edit` or `deleted-target` with the exact path; the merged workbook still opens for review  |

Repairs are never silent: `SheetDocumentInspection.warnings` surfaces them in
the editor, because a repair changes what the user stored.

## Performance

The enforced budgets and the machine they were measured on are in
`advanced-tables-phase0-contract.md`. They are checked by
`src/lib/sheet/performance.test.ts` (open, save, scroll, paste) and
`crates/collab-sheet/tests/formula_proof.rs` (load and recalculation). On a slow
runner, set `COLLAB_SHEET_BUDGET_SCALE` and record the scale in the release
validation matrix.

Two rules keep those budgets reachable and must not be undone:

- Never derive a count with `Object.keys(worksheet.cells).length` inside a
  per-cell loop.
- Never fold a single-cell operation over a list. Use `setCells` and
  `applyCellStyles` for batched writes; each single-cell call copies the whole
  sparse map.
