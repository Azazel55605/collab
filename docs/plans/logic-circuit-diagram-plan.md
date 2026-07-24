# Logic And Circuit Diagram Editor Plan

## Summary

Add a phased diagramming feature for university-oriented logic-gate overviews first, then expand toward electronics component diagrams. The first useful version should create editable vault documents, simulate basic digital logic, and export a note-embeddable graphic that remains linked to the source editor.

## Progress Tracker

| Phase | Status | Goal |
| --- | --- | --- |
| 0. Product shaping | Complete | Locked document format, source/export intent, and local groundwork. |
| 1. Static logic diagram editor | Complete | Create editable logic-gate diagrams as vault documents. |
| 2. Boolean interaction | Complete | Add toggleable inputs and live gate evaluation. |
| 3. Note insertion/export | Complete | Export editable-source-linked graphics into notes. |
| 4. Diagram polish and reuse | Complete | Add templates, library improvements, and better authoring flow. |
| 5. Electronic component diagrams | Complete | Add static resistor/transistor/etc. schematic symbols. |
| 5.1 Digital simulation tools | Complete | Add sequenced clock sources and dynamic value tables. |
| 6. Full circuit simulation | In progress | Build first-party analog and mixed-signal simulation in Rust. |

## Phase Details

### Phase 0: Product Shaping

- Choose a new document extension, defaulting to `.logic`.
- Store diagrams as JSON documents through the existing `VaultClient` document path.
- Treat `.logic` files as editable source documents, not generated images.
- Keep note insertion as exported SVG snapshots for v1, with source metadata linking back to the editable `.logic` document.
- Avoid analog simulation in the first release.

Acceptance criteria:

- The feature has a settled file extension, document schema, and first-screen workflow.
- The initial gate/component list is fixed before implementation.

Groundwork completed:

- `.logic` is the editable source extension.
- v1 source documents use `kind: "logic-diagram"`, `schemaVersion: 1`, `nodes`, `wires`, and `viewport`.
- `.logic` imports are validated before document creation.
- Local vault file allow-lists and encryption handling include `.logic`.
- Hosted `.logic` support remains a Phase 1 implementation item because hosted document typing currently recognizes note, kanban, and canvas only.
- The current schema is v6 and adds SI electrical parameters plus DC analysis/probe configuration on top of v5 schematic rotation, v4 clock timing, and the v3 `diagramMode`; older documents normalize safely without invented electrical values.

### Phase 1: Static Logic Diagram Editor

- Add a `LogicDiagramView` opened for `.logic` tabs.
- Use React Flow, matching the existing canvas technology stack.
- Support nodes for input, output, AND, OR, NOT, XOR, NAND, NOR, and XNOR.
- Support wires between compatible handles.
- Add a document top bar using the shared `DocumentTopBar` pattern.
- Add toolbar actions for gate insertion, input/output insertion, delete, duplicate, zoom, and fit view.
- Persist diagram JSON with optimistic document writes through `VaultClient.writeDocument`.

Acceptance criteria:

- Users can create, open, edit, save, close, and reopen a `.logic` file.
- The diagram round-trips through local and hosted vault document APIs.
- Invalid or older JSON loads safely with a recoverable empty/default diagram.

Implementation notes:

- `.logic` files open in `LogicDiagramView`.
- The first editor uses React Flow with static input/output and logic-gate nodes.
- Users can add gates, connect wires, delete selected gates/wires, fit view, and save.
- Command bar creation writes an initial v1 `.logic` source document.
- Boolean evaluation, templates, note export, and click-to-reopen exported graphics remain later phases.

### Phase 2: Boolean Interaction

- Add a pure TypeScript logic evaluator.
- Inputs can be toggled between `0` and `1`.
- Gate outputs update live based on connected upstream values.
- Outputs and active wires visually show their current state.
- Detect unresolved, floating, or cyclic circuits and surface non-blocking warnings.

Acceptance criteria:

- Basic circuits such as NOT, AND, OR, XOR, half-adder, and full-adder evaluate correctly.
- Cycles or incomplete wiring do not crash the editor.
- Evaluator logic is covered by focused unit tests.

Implementation notes:

- Inputs toggle between `0` and `1` through mouse, keyboard, and context-menu actions.
- Gate outputs, output nodes, and wires update from the pure evaluator.
- Wires show signal direction and active/off/unknown state.
- Active nodes show accent overlays based on active inputs or active output state.
- Gate input handles enforce the expected arity and one wire per input.
- Focused evaluator and flow round-trip tests cover the core logic behavior.

### Phase 3: Note Insertion, Export, And Reopen

- Add an export action that renders the current diagram to SVG first.
- Save exported graphics into `Pictures/` using existing generated-asset conventions where possible.
- Insert markdown image syntax into the active note, preferring the SVG export
  saved under `Pictures/`.

- Preserve the `.logic` source document separately from the exported graphic.
- Include source metadata in the exported SVG, such as the source `.logic` relative path and a diagram export marker.
- Extend rendered-note image handling so clicking a generated diagram SVG opens the source `.logic` editor when source metadata is available.
- Keep normal image behavior for non-diagram images and for legacy exported diagrams that lack source metadata.
- Provide an explicit image-view fallback for exported diagrams whose source `.logic` document is missing or inaccessible.

Acceptance criteria:

- A diagram can be exported and embedded into a note as a visible graphic.
- Clicking the embedded generated diagram in a note opens the editable source diagram, similar to how image assets open the image editor.
- Re-exporting can overwrite the previous graphic by default so the note stays pointed at the latest visual, with unique-name export available when requested.
- Hosted vault behavior respects existing read/write permissions.

Implementation notes:

- Logic diagrams export through a deterministic SVG renderer with embedded source metadata containing a diagram marker and source `.logic` relative path.
- `LogicDiagramView` exposes an `Insert in note` action that saves the SVG into `Pictures/`, appends markdown image syntax to an open note, and switches back to that note.
- Local exports overwrite the stable `Pictures/<diagram>.svg` asset by default so existing note links continue to point at the latest visual.
- Shift-clicking `Insert in note` requests a unique generated SVG path instead of overwriting the stable local export.
- Hosted exports use the hosted asset import capability and remain disabled for read-only hosted viewers.
- Rendered note images inspect exported SVG metadata and open the source `.logic` editor when the source still exists; if the source is missing, the click falls back to opening the exported image asset.

### Phase 4: Diagram Polish And Reuse

- Add starter templates: basic gates, half-adder, full-adder, multiplexer, flip-flop overview.
- Add keyboard shortcuts using layout-independent keys only.
- Add gate labels, wire labels, and compact truth-value badges.
- Add reusable logic components as a separate abstraction from templates.
- Add command-bar and slash-command entry points after the core workflow is stable.

Acceptance criteria:

- Common university examples can be created quickly without manual layout from scratch.
- The editor feels consistent with existing canvas, kanban, image, and PDF document views.

Implementation notes:

- Four starter templates ship in `logicDiagramTemplates.ts`: Half-Adder, Full-Adder, 2:1 Multiplexer, and SR Flip-Flop Overview. (Basic Gates was dropped — individual gates are faster to add via the toolbar.)
- `instantiateLogicDiagramTemplate()` regenerates fresh node/wire IDs on each call so multiple inserts into the same diagram never collide.
- A "Templates" toolbar button (Shapes icon) opens a picker dialog that appends the chosen template at the viewport center and fits the view.
- Gate labels are editable for all node kinds (not just groups) via double-click, `F2`, or context menu. The rename dialog title adapts ("Rename group" / "Label gate" / "Label output" / "Label wire").
- Wire labels render live in the editor via `EdgeLabelRenderer` as a pill badge at the wire midpoint. Labels were already exported in SVG; "Label wire" is added to the edge context menu.
- Keyboard shortcuts added: `Ctrl/Cmd+D` duplicates the selection (gates + internal wires), `r` = OR, `d` = NAND, `e` = NOR (completing the set alongside existing `i`/`o`/`a`/`n`/`x`). All use `event.key.toLowerCase()` for layout independence.
- A "Logic Diagram" slash command is added to `slashCommands.ts` for discoverability. The command-bar `new-logic` entry already existed.
- Truth-value display kept as-is (color wash, wire color, `0`/`1`/`unset` text) — no new badge component.
- Reusable logic components are stored in local vaults under `.collab/templates/logic-components/`. Existing templates still append node collections; components are placed as executable single nodes with snapshot or linked behavior.
- Saved components can be opened from the component picker in an isolated full-editor workspace, updated in place without changing their stable ID, or cancelled back to the host diagram without writing component internals into that file.
- Hosted component libraries are cached in the encrypted offline replica. Offline creates, edits, and deletes update the local library immediately and queue component-specific mutations for replay after reconnect.
- Custom component nodes share one N-to-M port geometry model across the editor and SVG export: their height grows with the larger port count, handles and labels remain centered at fixed spacing, and active-state radial fades originate independently at every active input and output port.

### Phase 5: Electronic Component Diagrams

- Add a separate schematic mode or new document extension only after logic diagrams are useful.
- Start with static symbols: resistor, capacitor, inductor, diode, LED, transistor, switch, ground, voltage source.
- Reuse the same editor shell where practical, but keep logic evaluation separate from electronics diagrams.
- Export electronic diagrams to notes using the same graphic pipeline.

Acceptance criteria:

- Users can create clean static electronics overviews for notes.
- No UI implies real analog simulation unless simulation has actually been implemented.

Implementation notes:

- `.logic` schema v3 adds `diagramMode: "logic" | "schematic"`; existing documents migrate to logic mode, while early electronic documents are inferred as schematic mode.
- The shared editor shell, document sessions, live JSON collaboration, grouping, labels, wires, zoom/pan, optimistic save, and note-export pipeline are reused by both modes.
- Schematic mode includes resistor, capacitor, inductor, diode, LED, NPN transistor, switch, ground, and voltage-source symbols with component-specific terminals.
- Schematic terminals are bidirectional and allow fan-out or multiple wires on the same electrical terminal. Digital gate inputs retain their one-driver constraint.
- Schematic symbols rotate clockwise in 90-degree steps; symbol bounds, terminal handles, wire anchors, persisted JSON, and SVG exports use the same rotated geometry.
- Schematic wires remain electrically neutral until a solver result exists. The renderer supports solver-driven energized-wire glow without inferring voltage from connectivity alone.
- Empty diagrams can switch mode from the document toolbar. The command bar also provides `New Electronic Schematic` for direct creation.
- The mode selector locks after the first element is added, preventing mixed digital/electronic documents and ambiguous evaluator behavior.
- SVG note exports render the actual schematic symbols and preserve the same source metadata used to reopen the editable `.logic` document.
- No analog values or simulation controls are exposed; Phase 6 remains a separate research decision.

### Phase 5.1: Digital Simulation Tools

- Add a clock source with a configurable period, duty cycle, and phase offset.
- Keep clock play/pause/reset state local to the open editor; only timing configuration is persisted.
- Generate exhaustive value tables for the whole logic file from its input and output nodes.
- Generate the same tables for reusable component definitions using their named ports.
- Treat clock sources as regular input columns in exhaustive tables so the table remains deterministic and independent of wall-clock timing.
- Limit generated tables to ten inputs (1,024 rows) to prevent exponential work from locking the editor.

Acceptance criteria:

- A clock can drive gates and outputs while the simulation is running, pause without changing the document, and restart from phase zero.
- A file with three inputs and two outputs produces eight rows containing every input state and both calculated outputs.
- Snapshot and linked reusable components can be selected as the table scope.
- Floating or invalid outputs render as unknown rather than failing table generation.

Implementation notes:

- `.logic` schema v4 adds optional `clock` timing to logic nodes while preserving migration of older files.
- The pure evaluator accepts elapsed clock time and recursively applies it inside reusable components.
- `logicTruthTable.ts` reuses the normal evaluator for each input permutation instead of maintaining a second simulation implementation.
- The editor exposes clock configuration on double-click and run, pause, reset, and value-table controls in the shared document toolbar.

### Phase 6: Full Circuit Simulation

The implementation is specified in [Electronic Circuit Simulation Integration Plan](electronic-circuit-simulation-plan.md).

- Build the focused simulation engine as the first-party MIT-licensed `collab-circuit` Rust crate; do not link or redistribute an external simulator.
- Deliver a deterministic linear DC baseline first, then nonlinear DC, transient/DC sweep, AC analysis, and a Collab-owned mixed-signal scheduler.
- Keep simulation local and offline-capable; synchronize source/configuration through the existing document session while treating numerical results as derived cache data.
- Require identical crate behavior and numerical fixtures across desktop targets and Android arm64 before enabling each analysis there.

Current implementation:

- Schema v6 persists optional SI electrical parameters and DC probe configuration; new symbols receive explicit defaults while migrated symbols remain unconfigured until edited.
- `collab-circuit` compiles stable terminal/wire connectivity into deterministic electrical nets, preserving terminal and wire source maps for future probes and energized-wire rendering.
- The schematic editor can split a wire at its context-menu position with an explicit junction node. Shared endpoints and junctions connect; wires that only cross visually remain separate electrical nets.
- Schema-v6 voltage and branch-current probes are now editable from schematic wire/component context menus, persisted through normal document collaboration, validated by the Rust compiler, and returned as typed DC readouts.
- The compiler now reports disconnected terminals, DC-floating islands, invalid ideal-source loops, and oversized dense-solver jobs before numerical assembly, with source IDs carried into actionable desktop errors.
- The deterministic compiler phase is covered by exact typed component/source-map golden contracts and generated 2-64 branch permutations across ordering and rotation changes.
- The Tauri DC slice compiles and solves resistors, capacitors, inductors, switches, independent voltage sources, built-in diode/LED models, and a deliberately scoped forward-active NPN model. It uses damped Newton-Raphson for nonlinear devices and returns explicit diagnostics for unsupported model references and NPN bias points outside the supported region.
- Desktop and Android DC runs use the same bounded native worker registry, shared TypeScript polling runner, and typed start/status/cancel/result commands. Solver cancellation is checked inside nonlinear iteration and dense elimination, view teardown cancels then drains active jobs, and compact status polling exposes compile/solve/finalize stages. Shared 10-second and 32 MiB dense-working-set limits bound each DC run without blocking either UI; Android adds read-only operating-point results and solved-wire polarity highlighting.
- Schematic symbols expose an electrical-value dialog, the toolbar runs DC operating-point analysis, and a compact results surface shows convergence iterations, signed node voltages, component current direction, and absorbed/supplied power. Fresh results color mapped wires by solved voltage polarity; electrical edits make old results visibly stale.
- Desktop and Android settings expose ANSI/IEEE and IEC/DIN schematic notation. The preference is client-local, applies to rendering and desktop SVG export, and never mutates `.logic` topology or collaboration state.

## Key Implementation Changes

- Add a new tab/document type for `.logic`.
- Add routing in the app shell so `.logic` files open in `LogicDiagramView`.
- Add diagram types and schema helpers in frontend code.
- Add pure evaluator tests for digital logic.
- Add export helpers for SVG/PNG generation and note insertion.
- Add metadata-aware note image click handling so generated diagram graphics can reopen their source editor.
- Keep all frontend file access through `VaultClient` and `tauriCommands`; do not call Tauri filesystem plugins directly from components.

## Test Plan

- Unit-test schema normalization and migration defaults.
- Unit-test boolean evaluator behavior for every supported gate.
- Unit-test cycle, missing input, and disconnected output handling.
- Component-test the editor for add/connect/toggle/save flows.
- Component-test export/note insertion behavior with mocked vault client APIs.
- Component-test clicking an embedded generated diagram image from rendered notes opens the source `.logic` editor.
- Component-test fallback behavior when the embedded diagram source path is missing.
- Run `pnpm test` and `pnpm exec tsc --noEmit`.
- For backend-touching export changes, also run `cd src-tauri && cargo test` and `cargo check`.

## Assumptions

- The first version uses `.logic` as the editable source format.
- Existing releases remain usable as static diagrams while Phase 6 simulation is added incrementally.
- Note embedding uses exported SVG graphics first, but those graphics remain linked to their editable source document.
- React Flow remains the diagram editing foundation.
- Electronics simulation uses documented component equations, deterministic numerical fixtures, explicit model limitations, and a first-party Rust engine; the UI never claims unsupported SPICE compatibility.
