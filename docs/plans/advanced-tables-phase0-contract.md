# Advanced Tables Phase 0 Contract

## Status

Phase 0 is complete. This document freezes the `.sheet` product contract, the
engine selections, the resource budgets, and the compatibility policy that
Phases 1-10 of `docs/plans/advanced-tables-plan.md` build on.

The executable half of this contract lives in:

- `src/types/sheet.ts` — the `.sheet` schema, limits, and defaults
- `src/lib/sheet/address.ts` — stable-identity to A1 translation
- `src/lib/sheet/viewport.ts` — the renderer-free virtualization model
- `src/lib/sheet/fixture.ts` — deterministic workbook fixtures
- `crates/collab-sheet/` — the Collab-owned formula boundary and its proofs

Nothing here delivers a user-visible spreadsheet. There is no `SheetView`, no
`.sheet` routing, no vault integration, and no formula UI yet; that work starts
in Phase 1.

## Decisions

| Decision | Outcome |
| --- | --- |
| Extension | `.sheet` |
| Media type | `application/vnd.collab.sheet+json` |
| Document kind | `collab-sheet` |
| Initial schema version | `1` |
| Schema ownership | Collab-owned in `src/types/sheet.ts`; no engine type may appear in stored documents |
| Formula engine | [`formualizer`](https://github.com/psu3d0/formualizer) 0.7.x (MIT OR Apache-2.0), Rust, behind `collab_sheet::formula` |
| Where formulas run | Native Rust, reached over typed IPC — the same crate serves desktop and Android |
| Grid renderer | First-party canvas grid with a DOM overlay; no third-party grid dependency |
| Domain location | `src/lib/sheet/` and `src/types/sheet.ts`, not a workspace package |
| Date/time storage | ISO-8601 strings with an explicit `valueType`; serials exist only at the engine boundary |
| Canonical formula syntax | English function names, `,` argument separator, `.` decimal separator — locale affects display only |
| Collaboration model | Semantic cell/range/structure operations over stable IDs (designed in Phase 6) |

### Why `.sheet` and not a spreadsheet library's own format

Collab must be able to replace the formula engine, the renderer, or the
converter without rewriting stored documents. The schema therefore uses stable
row/column IDs with a sparse `${rowId}:${columnId}` cell map, and A1 notation is
derived at read time (`SheetAddressIndex`). Inserting a row rewrites `rowOrder`
only; no unrelated cell key changes, which is also what makes semantic
collaboration operations tractable in Phase 6.

### Domain location

`apps/mobile-android/src/` already imports desktop modules directly
(`../../../src/types/...`, `../../../src/lib/...`), as `mobileTauri.ts` does for
calendar, circuit, and notification types. A workspace package would add build
complexity for sharing that already works, so the shared sheet domain stays in
`src/lib/sheet/`. Revisit only if the mobile build boundary changes.

## Formula Engine Evaluation

Reviewed 2026-07-29.

| Candidate | License | Verdict |
| --- | --- | --- |
| **formualizer** (Rust + WASM) | MIT OR Apache-2.0 | **Selected.** Parser, dependency graph, incremental recalculation, cancellable evaluation, 320+ functions, named ranges, undo/redo. Runs natively on both Tauri platforms. |
| HyperFormula | GPLv3 or commercial | **Rejected on license.** Collab ships under MIT; linking a GPLv3 engine would force the combined work to GPLv3 or require a paid proprietary licence. |
| fast-formula-parser | MIT | **Rejected on maintenance.** Last release 1.0.19, November 2020. No dependency graph. |
| `@formulajs/formulajs` | MIT | **Rejected on scope.** A function library only — no parser, dependency graph, cycle detection, or recalculation. Choosing it means hand-rolling exactly what the plan forbids. |
| First-party engine | n/a | **Not chosen.** Viable given the `collab-circuit` precedent, but a permissively licensed engine that already passes our proofs is a better use of the phase budget. The adapter keeps this option open. |

formualizer is young: first release September 2025, 0.7.1 as of 2026-07-02,
~3.8k total crate downloads. That risk is accepted and mitigated by the adapter
boundary (see Risks).

### Engine configuration (required, not optional)

`SheetFormulaEngine::new` constructs the workbook with
`WorkbookConfig::interactive().with_span_evaluation(true)`. Span evaluation is
not a tuning preference — without it, wide row-oriented range aggregations fall
off a performance cliff in the engine's column-oriented Arrow storage:

| Workload (1,000 formulas, release build) | Span evaluation off | Span evaluation on |
| --- | --- | --- |
| `=SUM(A1:CV1)` (100-cell row range) | 4,626 ms | 146 ms |
| `=SUM(A1:J1)` (10-cell row range) | 24 ms | — |
| `=SUM(A1:A1000)` (1,000-cell column range) | 33 ms | — |
| `=A1+B1` (scalar) | 10 ms | — |

These features stay **disabled** and must not be enabled later without a
security review: `webservice`, `import_range`, `io_builtins`, `wasm_plugins`,
`wasm_runtime_wasmtime`, `calamine`, `umya`, `csv`, `json`. No custom function
and no WASM module is ever registered. `WEBSERVICE`, `IMPORTRANGE`, and `RTD`
are proven unavailable by test.

## Grid Renderer Evaluation

| Candidate | License | Verdict |
| --- | --- | --- |
| **First-party canvas grid** | n/a | **Selected.** Matches the plan's own rendering split and the existing precedent of custom `PdfView`, `SvgVectorView`, and `LogicDiagramView` surfaces. Inherits the theme/accent token system, owns accessibility semantics, and carries no third-party licence or React-version risk. |
| glide-data-grid | MIT | Rejected. Requires peer dependencies this repo does not use (`styled-components`, `lodash`, `marked`, `canvg`) and its published React peer range stops at 18. Its cell model would also press back on the `.sheet` schema. |
| RevoGrid | MIT (Pro tier for advanced features) | Rejected. Stencil web component inside a React 19 app, theming friction, and several spreadsheet features sit behind the paid tier. |

`src/lib/sheet/viewport.ts` is the renderer-free half of that decision:
cumulative axis offsets, binary-search hit testing, frozen panes, and overscan.
The canvas layer, DOM editor overlay, and selection overlay are built on it in
Phase 2.

## Measured Baselines

Recorded 2026-07-29 on the development machine (Linux, AMD Zen 4). These are
the reference points Phase 9 enforces; re-measure per platform rather than
treating them as portable guarantees.

### Formula engine (Rust, release build)

| Operation | Measurement |
| --- | --- |
| Bulk load 100,000 numeric cells (`set_values`) | 650 ms |
| Cell-by-cell load of the same 100,000 cells | 700 ms (7 µs/cell — batch on open regardless) |
| Cold `evaluate_all`, 1,000 x `=SUM(<100-cell row>)` | 146 ms |
| Warm `evaluate_all`, nothing dirty | 1.2 ms |
| `evaluate_all` after one value edit (1,000 formulas) | 7.4 ms, 1 cell recomputed |
| `evaluate_all` after one value edit (20,000 formulas) | 2.5 ms, 100 cells recomputed |
| 20,000 scalar formulas, cold | 118 ms |
| 5,000-deep dependency chain, cold | 38 ms |
| 5,000-deep dependency chain, recalc after edit | 4.2 ms |

### Document and viewport (TypeScript, jsdom)

| Operation | Measurement |
| --- | --- |
| Build a 100,000-cell workbook (100,000 x 1,000 logical grid) | 83 ms |
| `JSON.stringify` | 48 ms, 5.38 MiB |
| `JSON.parse` | 64 ms |
| Axis metrics for 100,000 rows x 1,000 columns | 1.1 ms |
| `SheetAddressIndex` construction | 27 ms |
| Scroll frame: viewport + resolve every visible cell | 0.12 ms/frame, ~1,080 cells/frame |

### Phase 9 budgets

| Budget | Target |
| --- | --- |
| First open of a 100,000-cell workbook (parse + index + engine load) | < 1.5 s |
| Scroll frame cost (viewport + cell resolution, excluding paint) | < 4 ms |
| Interactive recalculation after a single edit | < 50 ms |
| Cold full recalculation of a 100,000-cell workbook | < 2 s |
| Save serialization | < 250 ms |
| Paste of 10,000 cells | < 500 ms |
| Resident memory over baseline for a 100,000-cell workbook | < 250 MiB |

## Structural Limits

Mirrored from `SHEET_LIMITS` in `src/types/sheet.ts`. A document exceeding a
limit is rejected with a clear error — never silently truncated.

| Limit | Value |
| --- | --- |
| Worksheets per workbook | 200 |
| Rows per worksheet | 1,000,000 |
| Columns per worksheet | 16,384 |
| Populated cells per worksheet | 500,000 |
| Populated cells per workbook | 1,000,000 |
| Formula cells per workbook | 200,000 |
| Formula source length | 8,192 characters |
| Cell text length | 32,768 characters |
| Worksheet name length | 64 characters |
| Styles per workbook | 10,000 |
| Named ranges per workbook | 1,000 |
| Merged ranges per worksheet | 10,000 |
| Conditional formats per worksheet | 500 |
| Charts per worksheet | 50 |
| Document size | 64 MiB |

Evaluation is additionally bounded at runtime by `SheetFormulaBudget`: 200,000
formula cells and a 5 s wall-clock ceiling per evaluation on desktop. Mobile and
background callers must pass smaller budgets rather than trusting the document.

## Formula Compatibility Policy

### Supported baseline

Proven by `crates/collab-sheet/tests/formula_proof.rs`: arithmetic, comparison,
concatenation and precedence; relative, absolute, mixed, range, and cross-sheet
references; `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, `COUNTA`, `IF`, `IFS`,
`AND`, `OR`, `NOT`, `IFERROR`, `ROUND`, `ABS`, `MOD`, `SQRT`, `POWER`, `CONCAT`,
`LEFT`, `RIGHT`, `MID`, `LEN`, `TRIM`, `DATE`, `YEAR`, `MONTH`, `DAY`, `SUMIF`,
`SUMIFS`, `COUNTIF`, `COUNTIFS`, `AVERAGEIF`, `AVERAGEIFS`, `INDEX`, `MATCH`,
`VLOOKUP`, `HLOOKUP`, and `XLOOKUP`.

Phase 3 publishes the exact support table in
`advanced-tables-formula-support.md`. The executable source of truth remains
`crates/collab-sheet/tests/formula_proof.rs`; the UI autocomplete list mirrors
that tested baseline.

### Unsupported-function behavior

An unrecognized function name evaluates to `#NAME?`; a function the engine
recognizes but does not implement evaluates to `#N/IMPL!`. Neither may return a
stale value, an empty cell, or a silently coerced result. Malformed source
evaluates to `#ERROR!`. Cycles evaluate to `#CIRC!` and always terminate.
Evaluation stopped by the Collab budget produces `#TIMEOUT!`, which is
Collab-owned and not an Excel code.

`SheetFormulaError::code()` in `crates/collab-sheet/src/formula.rs` and
`SheetErrorCode` in `src/types/sheet.ts` are the two halves of this list. Keep
them in sync.

### Volatile functions and time

`TODAY` and `NOW` are bound at the Collab adapter boundary once per batched
recalculation request. The request carries one timestamp and the app's
configured calendar timezone, so every formula in the workbook observes the
same local date/instant and volatile values are never recomputed per frame.

### Formula source is authoritative

The `.sheet` document owns formula text. The engine normalizes stored text and,
for malformed input, replaces it with its own diagnostic string — so
`engine_formula_text` is diagnostic only and must never be written back into a
document. Computed values are derived and are not persisted in Phase 1.

### Prohibited

Formulas may not reach the network, filesystem, environment, credentials,
external workbooks, or any executable runtime. This is enforced by feature
selection in `crates/collab-sheet/Cargo.toml`, by never registering custom or
WASM functions, and by test.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| formualizer is a young 0.x dependency with low adoption | Everything engine-specific lives in `crates/collab-sheet/src/formula.rs` behind Collab-owned value, error, and reference types. The proof suite is engine-agnostic, so a replacement is scoped to one file. Pin the exact version and review each upgrade. |
| Span evaluation is documented upstream as experimental | Required for acceptable range performance today. If it proves incorrect, `with_span_evaluation(false)` restores stable semantics at a large cost on wide ranges — that trade would need a Phase 3 decision, not a silent flip. |
| `TEXTJOIN`/`CONCAT` over a range collapse to the first cell in 0.7.1 | Pinned by `known_upstream_gap_range_text_aggregation`, which fails loudly when upstream fixes it. Phase 3 must report it upstream or implement the range form in the adapter. |
| The Arrow-backed dependency tree is large (~125 crates) | Adds build time and audit surface. `cargo audit` must cover it before the first `.sheet` release, and the ignore list plus `docs/build/security-advisories.md` must stay in sync per the repo's advisory policy. |
| IPC chattiness between the editor and a native engine | Recalculation is dependency-scoped and measured in single-digit milliseconds; the editor batches edits per commit rather than per keystroke. Phase 3 must keep a batched command surface instead of one call per cell. |
| Spilled array results are not modelled by schema version 1 | The adapter returns `#SPILL!` rather than collapsing an array to its top-left cell. Dynamic arrays need a schema addition, so they are explicitly out of scope until then. |

## Exit Gate Assessment

| Exit-gate requirement | Status |
| --- | --- |
| Selected engines satisfy licensing requirements | Met — MIT/Apache-2.0 engine, no third-party renderer |
| Selected engines satisfy performance requirements | Met — see Measured Baselines; span evaluation required |
| Schema represents structural edits without renderer internals | Met — stable IDs, sparse cells, derived A1; proven by `address.test.ts` |
| Sparse workbook of 100,000 cells in a much larger logical range | Met — `fixture.test.ts` |
| Formula dependency updates, cross-sheet references, cycles, bounded recalc | Met — `formula_proof.rs` |
| Formula compatibility and unsupported-function behavior defined | Met — see Formula Compatibility Policy |
| Baseline budgets recorded | Met — see Measured Baselines |

### Proven by model, not yet by pixels

Keyboard navigation, range selection, direct editing, resizing, and frozen
panes are proven at the viewport-model level (windowing, hit testing, frozen
offsets, per-frame cost), not yet as rendered interaction. Frame-time
validation against a real canvas belongs to Phase 2, measured against the
budgets above. Nothing in Phase 0 measured GPU paint, text shaping, or Android
rendering.

## Verification

```bash
cargo test -p collab-sheet          # 13 tests: adapter proofs and scale
pnpm vitest run src/lib/sheet       # 17 tests: identity, viewport, fixtures
pnpm rust:boundaries                # collab-sheet is a leaf domain crate
```
