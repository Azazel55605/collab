# Advanced Tables Release Validation

Phase 9 release gate for the `.sheet` workbook document. It records what is
enforced automatically, what has to be checked on a physical device, and the
licensing and security position of the dependencies involved.

Reference documents: `docs/desktop/sheet-reference.md` (behavior),
`docs/plans/advanced-tables-phase0-contract.md` (measured baselines and
budgets), `docs/plans/advanced-tables-formula-support.md` (function surface).

## Automated Release Checks

Run from the repository root:

```bash
pnpm exec vitest run src/lib/sheet src/components/sheet src/views/SheetView.test.tsx
pnpm exec tsc --noEmit
cargo test -p collab-sheet --release
cargo test -p collab-documents sheet
cargo test -p collab sheet_convert
pnpm mobile:test
```

`cargo test -p collab-sheet` is run in release mode deliberately: the scale
proof in `crates/collab-sheet/tests/formula_proof.rs` measures load and
recalculation, and a debug build is an order of magnitude slower than the
machine the baselines were recorded on.

### What each suite covers

| Suite | Gate |
| --- | --- |
| `src/lib/sheet/performance.test.ts` | First open, save serialization, scroll frame cost, and a 10,000-cell paste against the Phase 9 budgets |
| `src/lib/sheet/fixtureShapes.test.ts` | Sparse, dense, wide, tall, deeply dependent, and highly formatted workbooks round-trip; corrupted workbooks are rejected or repaired with a report |
| `src/lib/sheet/recovery.test.ts` | Autosave/reload, crash recovery, schema upgrade, and revision conflict |
| `src/components/sheet/SheetGridAccessibility.test.tsx` | Screen-reader grid semantics, focus, and keyboard-only operation |
| `src/components/sheet/SheetGridTheme.test.ts` | Contrast, zoom, and reduced motion |
| `crates/collab-sheet/tests/formula_proof.rs` | Function baseline, cycles, bounded recalculation, and the 100,000-cell scale proof |
| `crates/collab-sheet/tests/conversion_proof.rs` | `.xlsx` import fidelity, hostile-archive rejection, and the semantic export/re-import round trip |
| `src/lib/sheet/conversion.test.ts`, `src/types/sheetConversion.test.ts` | Import routing into the vault, computed-value export, and report presentation |
| `src/components/sheet/SheetCsvExportDialog.test.tsx` | CSV scope, worksheet loss disclosure, and the formula-injection opt-in |

### Budget scaling on slow machines

The budgets in `src/lib/sheet/budgets.ts` are ceilings measured on a Linux/Zen 4
development machine. A shared CI runner or an emulator can be several times
slower. Rather than loosening the published budgets, set
`COLLAB_SHEET_BUDGET_SCALE` (clamped to 1–20) for that environment and record
the scale in the matrix below. Memory budgets are never scaled.

## Platform Matrix

Fill in per release. `Automated` means the suites above ran green on that
platform; `Manual` means the interactive checklist below was walked.

| Platform | Automated | Manual | Budget scale | Notes |
| --- | --- | --- | --- | --- |
| Linux (x86-64, WebKitGTK) | ✅ | ⬜ | 1 | Reference platform for the recorded baselines |
| Windows (x86-64, WebView2) | ⬜ | ⬜ | | |
| macOS (Apple silicon, WKWebView) | ⬜ | ⬜ | | |
| Android (arm64, Android WebView) | ⬜ | ⬜ | | Mobile editing is bounded — see below |

### Manual checklist per desktop platform

1. Open the 100,000-cell fixture workbook; scrolling stays smooth in all four
   directions, including with frozen panes.
2. Resize rows and columns, and auto-size a column by double-clicking its edge.
3. Edit a cell, a formula, and a merged range; undo and redo each.
4. Copy a 100×100 range and paste it as all, values, formulas, and formatting.
5. Switch each of the four themes and confirm grid lines, table banding, and
   the formula precedent/dependent tints stay legible.
6. Set the app zoom to its minimum and maximum; text stays sharp and headers
   stay aligned with cells.
7. Turn off animations in Settings, and separately enable the OS
   reduced-motion setting; the save spinner stops in both cases.
8. Drive a full edit cycle with the keyboard only, starting from `Tab` into the
   grid, without touching the pointer.
9. With a screen reader running, move the cursor and confirm the address, the
   value, and the formula source are announced, and that selecting a range
   announces its shape.
10. Export a chart and a range as SVG and confirm the files open standalone.

### Manual checklist for Android

1. Open a `.sheet` from the Files screen; the touch grid renders only the
   viewport window.
2. Pinch zoom in and out; frozen rows and columns stay pinned.
3. Edit a value and a formula; the text keypad opens and `=` is reachable.
4. Filter a table column and enter a validation-backed cell.
5. Background the app during an edit, let the system reclaim the process, and
   reopen — the edit is either saved or queued, never lost.
6. Open a large workbook and watch resident memory; the app must not be killed
   for memory while scrolling.

Items 5 and 6 are the outstanding Phase 8 release gate and require physical
devices; an emulator is not sufficient evidence.

## Dependency Audit

### Formula engine

`formualizer` (`formualizer-common`, `formualizer-eval`, `formualizer-workbook`)
sits behind `collab_sheet::formula::SheetFormulaEngine`. Every crate reachable
from `collab-sheet` is permissively licensed — MIT, Apache-2.0, ISC, BSD-2, or
Unicode-3.0 — with no copyleft and no unknown license. Re-check with:

```bash
cargo tree -p collab-sheet --edges normal
cargo audit
```

The engine is wrapped so its types never leak past the adapter, and it is given
no network, filesystem, custom-function, or WASM-plugin surface. The `.sheet`
document, never the engine, is the authoritative formula source.

### Grid renderer and charts

Both are first-party. The grid is a canvas layer plus a DOM overlay over the
renderer-free viewport model in `src/lib/sheet/viewport.ts`; charts are
generated as self-contained accessible SVG by `src/lib/sheet/analysis.ts`. There
is no third-party spreadsheet grid or charting library, and none may be added.
The only external frontend imports in the whole `.sheet` surface are `react`
(MIT), `d3` scales (ISC), `lucide-react` icons (ISC), and `sonner` toasts (MIT).

### Clipboard

Clipboard handling uses the browser clipboard events directly; there is no
third-party clipboard dependency. The Collab payload is a versioned JSON MIME
type, TSV and HTML are generated for other applications, and incoming HTML is
sanitized before conversion. Paste is bounded to 100,000 cells.

### Conversion (`.xlsx` / `.csv`)

First-party, in `collab-sheet::convert`, built on the workspace `zip` (MIT) and
`quick-xml` (MIT) codecs. There is no third-party spreadsheet reader or writer,
so the archive bounds — entry count, per-entry expanded size, total expansion,
and unsafe entry names — are enforced in code we control. Neither codec reaches
the network, the filesystem, or a database.

An export never writes a macro, connection, external-link, or query part, so an
exported file cannot carry a capability the source `.sheet` did not have. CSV
export prefixes fields a spreadsheet would execute unless the user explicitly
turns that off.

### Standing security position

- Formulas cannot reach files, environment variables, credentials, URLs, or
  executable runtimes; macros and external workbook links are out of scope.
- Recalculation is bounded by cell count and wall clock; cycles return `#CIRC!`
  and always terminate.
- Formula and document errors are bounded, typed, and must not echo stored
  content or local paths back to the user.
- Protected ranges are editor policy only — not encryption and not an
  authorization boundary. Hosted authorization stays server-side.

## Exit Gate

- [x] Phase 9 budgets are enforced by automated tests on the reference platform.
- [x] Fixtures cover sparse, dense, wide, tall, deeply dependent, highly
      formatted, and corrupted workbooks.
- [x] Keyboard-only operation, focus, screen-reader semantics, contrast, zoom,
      and reduced motion are validated.
- [x] Autosave/reload, crash recovery, schema upgrade, and revision conflict are
      covered.
- [x] Formula, clipboard, import, renderer, and chart dependencies are audited
      for licensing and security.
- [x] Supported functions, limits, keyboard behavior, collaboration semantics,
      and recovery paths are documented.
- [ ] Windows, macOS, and Android rows of the platform matrix are filled in from
      real runs on those platforms.
- [ ] Conversion is validated against files produced by maintained spreadsheet
      applications (see below).

## Conversion Validation

`crates/collab-sheet/tests/conversion_proof.rs` builds its fixtures inline, so
the XML each test asserts against is visible next to the assertion. That proves
the reader against the shapes those applications *document*; it does not prove
it against what they actually emit. Before release, run the import against real
files and record the result:

| Source application | Import opens | Values correct | Formulas correct | Styles reasonable | Report honest |
| --- | --- | --- | --- | --- | --- |
| Excel (desktop) | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| Excel (web) | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| LibreOffice Calc | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| Google Sheets export | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| Numbers export | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

Each file should include dates, a non-English locale, formulas (including a
shared formula group), styles, merged cells, hidden rows and sheets, a chart,
Unicode text, and a large sparse sheet. Then export from Collab and confirm the
result opens in each application without a repair prompt.

"Report honest" is the column that matters most: a conversion that loses
something and says so is a pass; one that loses something silently is a
release blocker.
