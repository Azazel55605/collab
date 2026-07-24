# Electronic Circuit Simulation Integration Plan

## Goal

Turn schematic-mode `.logic` files into offline-capable circuit simulations powered by a first-party Rust engine owned and maintained with Collab. The simulator is intentionally scoped to the components and analyses exposed by Collab rather than attempting full SPICE or vendor-model compatibility.

The completed subsystem should support DC operating point, transient, DC sweep, AC analysis, probes and plots, mixed analog/digital circuits, reusable Collab component models, and solver-driven voltage/current overlays on desktop and Android.

This remains a large numerical subsystem. A reliable initial release is approximately 17-27 engineering weeks for one experienced engineer. Advanced semiconductor models and broad SPICE compatibility are explicitly outside the first release.

## Engine Decision

Build an MIT-licensed, pure-Rust simulation engine in `crates/collab-circuit`.

- Collab owns the simulation architecture, component models, numerical behavior, diagnostics, and platform integration.
- No ngspice, XSPICE, or other external simulator is linked, bundled, downloaded, or required at runtime.
- Published circuit-analysis methods may be implemented independently, but external simulator source code must not be copied or translated.
- Permissively licensed numerical crates may be adopted after an explicit dependency and license review. The baseline starts with an internal dense solver so the API and reference fixtures do not depend on that decision.
- External simulators may be used by developers as unbundled numerical comparison tools. They are never a production dependency or source of copied implementation code.

The first release is a focused Collab simulator, not a general SPICE replacement. It will not accept arbitrary SPICE decks, control scripts, vendor binary models, filesystem directives, or shell commands.

## Supported Scope

Initial target:

- Resistors, capacitors, inductors, independent voltage/current sources, switches, clocks, ground, junctions, probes, diodes, and LEDs.
- Existing digital gates and reusable digital components.
- DC operating point, transient analysis, DC sweep, and basic small-signal AC analysis.
- Explicit analog-to-digital and digital-to-analog bridges for mixed circuits.

Deferred until the core is stable:

- BJT and MOSFET model families beyond a deliberately documented basic model.
- Op-amp macro-model import, transmission lines, RF/noise/process simulation, arbitrary behavioral expressions, and vendor SPICE model compatibility.
- A raw simulation console or user-supplied executable code.

## Progress Tracker

| Phase | Status | Goal |
| --- | --- | --- |
| 6.0 First-party foundation | Complete | Establish the Rust crate, typed model, deterministic behavior, and linear DC baseline. |
| 6.1 Simulation document model | In progress | Add electrical values, probes, analyses, junctions, and source waveforms to `.logic`. |
| 6.2 Schematic compiler | Complete | Compile validated `.logic` connectivity into deterministic electrical nets and solver systems. |
| 6.3 DC operating point | Complete | Expand the baseline solver with diagnostics, nonlinear devices, and live overlays. |
| 6.4 Runtime integration | In progress | Run, cancel, and stream simulations through typed Tauri commands on desktop and Android. |
| 6.5 Transient and DC sweep | Complete | Dynamic elements, adaptive trapezoidal integration with backward-Euler fallback, bounded sweeps, and shared desktop/Android plot inspection are implemented. |
| 6.6 AC analysis | In progress | The bounded linear complex sweep core is implemented; DC-bias small-signal linearization, native jobs, and Bode UI remain. |
| 6.7 Mixed-signal simulation | Planned | Coordinate the existing digital evaluator with analog timesteps through explicit bridges. |
| 6.8 Offline, cache, and collaboration | Planned | Cache derived results locally while synchronizing source and configuration only. |
| 6.9 Numerical hardening and release | Planned | Add sparse solving, convergence controls, platform stress tests, and reproducible validation. |

## Phase 6.0: First-Party Foundation

Create `crates/collab-circuit` as a pure Rust workspace crate with no Tauri, webview, filesystem, or network dependency.

Baseline deliverables:

- Stable IDs and typed definitions for nodes and linear DC components.
- Numeric validation rejecting non-finite values, invalid resistance, duplicate IDs, missing references, and unsolvable systems.
- Deterministic unknown ordering and result maps independent of insertion order.
- Modified nodal analysis stamping for resistors, independent current sources, and independent voltage sources.
- A pivoted dense linear solver suitable for small baseline fixtures.
- Node-voltage and per-component branch-current results with typed diagnostics.
- Divider, source, current-source, invalid-value, singular-circuit, and ordering tests.

Implemented baseline:

- `collab-circuit` is a workspace crate used directly by the Tauri application on desktop and Android builds.
- The deterministic compiler unions stable terminal handles through wires, supports terminal fan-out, ignores visual rotation/order, and returns terminal/wire source maps.
- Explicit junction nodes can be inserted at an arbitrary wire position; insertion splits the selected wire while preserving its ID and label. Only shared terminals and explicit junction endpoints join electrical nets, so visual wire crossings remain disconnected.
- Persisted voltage and branch-current probes compile to stable electrical-node/component targets. Stale component references, removed terminals, duplicate probe IDs, and invalid ground-current probes fail with source-mapped compilation diagnostics.
- Before matrix assembly, the bounded compiler rejects disconnected component terminals, DC-floating islands, self-connected ideal voltage sources, conflicting or redundant ideal-voltage loops, and jobs above 512 components, 4,096 wires, or 2,048 probes. Capacitors and current-source branches do not falsely establish a DC reference path.
- Schema v6 persists normalized SI electrical parameters plus DC analysis/probe configuration. Migrated documents do not receive invented values; newly inserted symbols receive explicit editable defaults.
- The compatibility `circuit_solve_dc` command and the job-based DC runtime compile and solve resistor, capacitor, inductor, switch, independent-voltage-source, diode, LED, and built-in NPN schematics through typed frontend wrappers. Unsupported model references and malformed connectivity return structured diagnostics.
- The desktop editor can edit persisted SI values, run the local DC solver, inspect node voltage polarity, component current direction, and component power, and highlight mapped wires using positive/negative solved-voltage colors. Electrically relevant edits mark displayed results stale and remove their glow until rerun.
- The bounded solver now uses damped Newton-Raphson for the built-in diode and LED models, reports iteration counts and convergence failures, treats capacitors as DC-open and inductors as DC-shorts, and keeps deterministic ordering. The desktop editor runs it through the cancellable Phase 6.4 worker API; streamed progress remains future work before larger analyses are enabled.

The dense solver is a correctness baseline, not the final large-circuit implementation. Its public model and result types must remain usable when the matrix backend is replaced with a sparse implementation.

Gate:

- Do not connect simulation controls to the editor until reference fixtures pass deterministically and the `.logic` compiler can report source-mapped diagnostics.

## Phase 6.1: Simulation Document Model

Schema v6 is established. Continue expanding its validated optional simulation data:

- Numeric SI component parameters plus display-unit preferences.
- Stable built-in `modelRef` values for nonlinear components.
- Analysis configuration containing tolerances, temperature, time/frequency ranges, and output limits.
- Voltage, differential-voltage, branch-current, and digital probes.
- Explicit junction nodes for branches at arbitrary wire positions. Existing shared terminals remain valid net junctions.
- DC, sine, pulse, piecewise-linear, and clock-derived sources.

Rules:

- Store numeric SI values, not only display strings such as `1k`.
- Rotation is visual and never changes terminal identity or electrical meaning.
- Existing v1-v5 files continue to open as static schematics with safe defaults.
- Unsupported components remain visible but block simulation with a source-mapped diagnostic.

## Phase 6.2: Deterministic Schematic Compiler

- Convert schematic terminals, wires, and explicit junctions into electrical nets using union-find.
- Support any number of wires joining the same terminal or junction.
- Require exactly one reference ground for analog simulation.
- Assign stable node and device ordering from document IDs, independent of visual position and JSON order.
- Produce typed `collab-circuit` inputs rather than generating text netlists.
- Return source maps from solver nodes/components to Collab node, terminal, wire, and probe IDs.
- Detect floating islands, conflicting ideal sources, disconnected pins, invalid values, unsupported models, and oversized jobs before execution.

Testing:

- Golden compiled-circuit tests for every supported component.
- Permutation tests proving insertion order and rotation do not affect results.
- Property tests for net union, junction branching, and stable source mapping.
- Regression fixtures for terminal fan-out and crossing wires that are not junctions.

Implemented slice:

- Deterministic union-find nets, terminal/wire/probe source maps, stable component ordering, and terminal fan-out.
- Typed source diagnostics for missing values/models, stale wire/probe references, disconnected terminals, and invalid ground usage.
- DC-aware reference-path validation, including a forward-active NPN collector that does not by itself constrain collector voltage.
- Weighted ideal-voltage-source path validation that rejects inconsistent and redundant loops of any length before they reach MNA.
- Explicit bounded-job rejection for the current dense-solver baseline.
- Explicit junction validation and editor wire splitting, with regression fixtures proving junction fan-out and non-connecting wire crossings.
- Exact typed golden contracts for every supported schematic component model and source-map output.
- Generated branch-topology contracts cover 2-64 branches across 144 deterministic node/wire permutations and all persisted rotations.

Phase 6.2 is complete. Future component models must add their compiler golden contract before they become supported.

## Phase 6.3: DC Operating Point

- Replace the baseline dense backend with or supplement it by a reviewed sparse matrix backend before large diagrams are enabled.
- Add conductance/current/voltage stamping abstractions shared by all analyses.
- Implement nonlinear Newton-Raphson iteration with damping, iteration limits, absolute/relative tolerances, and actionable convergence diagnostics.
- Add diode and LED models first; add deliberately scoped BJT/MOSFET models only after diode convergence is stable.
- Calculate node voltages, component currents, power, and digital bridge states.
- Drive wire glow, polarity, direction, and probe readouts from actual solver values.
- Mark successful results stale immediately after an electrically relevant edit.

Acceptance fixtures must cover dividers, bridges, open/floating circuits, shorts, diode bias, LED current limiting, and deliberately difficult convergence cases against independently calculated or published reference values.

Implemented slice:

- Damped Newton-Raphson with bounded iterations, absolute/relative convergence checks, voltage-step limiting, and typed non-convergence diagnostics.
- Built-in Shockley diode and LED models selected through stable `modelRef` values.
- A deliberately scoped `builtin:npn` two-junction model with exponential base-emitter/base-collector currents, fixed forward gain, and bounded saturation behavior. Reverse-active behavior, breakdown, capacitances, Early effect, high-level injection, and temperature variation remain explicitly unsupported.
- DC operating-point behavior for capacitors (open), inductors (ideal short with branch current), and resistive open/closed switches.
- Passive-sign-convention component power, explicit component current direction, signed node/wire polarity, and iteration metadata in the typed Tauri result and desktop results panel.
- Typed NPN operating-region diagnostics when a solved bias point enters unsupported reverse-active operation. The UI identifies the source component and reports its solved VBE/VCE values instead of silently presenting the approximation as a complete transistor model.
- Strong-base-drive and saturation fixtures verify that the nonlinear solve remains bounded, respects the collector load limit, and no longer forces an impossible negative collector voltage.
- Newton voltage limiting is scoped to nonlinear terminal nodes, so exact linear source nodes settle immediately instead of being throttled by junction damping. A 100 V resistor-limited diode fixture verifies convergence in fewer than 20 iterations.
- A balanced Wheatstone bridge fixture verifies both analytic midpoint voltages and effectively zero bridge current.
- Current direction is reported per component and through explicit branch probes. A branched electrical net does not have one well-defined wire current, so wire overlays remain voltage/polarity indicators.
- Schematic context actions create persisted voltage probes from wires and branch-current probes from components. `circuit_solve_dc` returns typed probe values, and the results panel renders those focused readings separately from the complete operating-point tables.

Phase 6.3 is complete. The sparse-backend evaluation found that a representative 256-node ladder stamps 766 nonzero entries into 65,536 possible dense cells (about 1.17% occupancy). The public model/result boundary remains backend-independent, but the current solver now enforces a 512-unknown ceiling in addition to its memory and wall-clock limits. A reviewed sparse backend is required before that ceiling or the compiler's bounded-diagram limits may be raised. Explicit digital bridge states remain scheduled for the Rust-owned mixed-signal boundary in Phase 6.7, where their thresholds, impedance, hysteresis, and event timing can be defined coherently.

## Phase 6.4: Runtime Integration

- Add typed Tauri wrappers for validate, start, cancel, status, and bounded result reads.
- Run simulation on dedicated Rust workers so the UI thread and async runtime remain responsive.
- Use cancellation tokens plus wall-clock, iteration, matrix-size, sample-count, and memory limits.
- Stream progress and result chunks through Tauri channels rather than large JSON responses.
- Use the same Rust crate on desktop and Android; platform code should only provide scheduling and IPC.
- A panic or failed solve must become a diagnostic and must never dirty or corrupt the document.

Implemented slice:

- `AppState` owns a bounded native job registry with at most four active jobs and 32 retained entries. DC jobs run on named Rust worker threads instead of the webview or async runtime thread.
- Typed Tauri commands start a job, poll its compact phase, request cancellation, and consume a terminal result exactly once. The original synchronous DC command remains available as a compatibility boundary, but the desktop editor no longer uses it.
- Cancellation is checked before validation, throughout Newton iterations and dense elimination/back-substitution, and while assembling the result. Closing the editor requests cancellation while its poller drains the terminal result.
- The shared DC solver enforces a 10-second wall-clock limit, a 512-unknown dense-backend ceiling, and a 32 MiB estimated dense working-set limit. Limit failures use typed simulation errors, and user cancellation takes priority when competing conditions are observed.
- Compact status polling reports phase, elapsed time, and queued/compiling/solving/finalizing stages. Desktop and Android share the pure TypeScript polling runner and structured-error formatter while keeping their platform controls separate.
- Worker panics and solver failures become typed job failures. Cancelled and failed jobs never mutate the `.logic` source; failures clear the displayed operating point instead of leaving it looking current.
- Desktop and Android expose Run DC and Cancel states and keep their UI responsive while native work is active. The Android viewer also renders solved wire polarity plus a read-only operating-point sheet for probes, voltages, currents, power, and model diagnostics.

Remaining in Phase 6.4:

- Add progress channels when transient analysis produces long-running jobs that need finer feedback than compact stage polling.
- Extend the sweep result-buffer and sample-count model to transient analysis once transient samples exist.

The bounded DC portion of Phase 6.4 is complete on desktop and Android. DC sweep now uses the same worker registry and bounded native chunk reads; progress channels remain deferred until transient jobs need finer-grained progress.

## Phase 6.5: Transient And DC Sweep

- Add transient capacitor and inductor companion models (their DC-open/DC-short behavior is already implemented).
- Begin with backward Euler for stability, then add trapezoidal integration with oscillation detection and method fallback.
- Add adaptive timesteps with explicit minimum/maximum bounds and rejection limits.
- Add source sweeps and bounded typed-array result buffers.
- Add a plot drawer with synchronized cursors, units, trace visibility, pan/zoom, and CSV/SVG export.
- Downsample only for rendering and retain the bounded source result for inspection/export.

Implemented slice:

- The pure Rust core linearly sweeps an independent voltage or current source and records only explicitly requested node-voltage/component-current traces. Compiled persisted probes map into deduplicated sweep outputs without losing their source-map identity.
- Sweep requests validate source identity/type, output identity and uniqueness, finite distinct bounds, and a minimum of two samples before solving.
- Default limits cap a sweep at 4,096 samples, 1,048,576 stored scalar values, and 30 seconds while retaining all per-operating-point DC limits and cancellation checks.
- Results and failures have explicit serialized shapes, including the failing sample index/value when one operating point cannot be solved.
- `.logic` schema v6 now preserves an optional linear DC sweep configuration containing the selected independent source, finite start/stop values, and a clamped 2-4,096 sample count. Invalid legacy or partial sweep data falls back to DC operating-point mode without making the document unreadable.
- Desktop and Android expose typed sweep start, status, cancel, result-summary, chunk-read, and discard boundaries over the existing native worker registry. Completed arrays stay in Rust and each IPC read is capped at 512 aligned samples across the source axis and requested traces.
- Sweep jobs share the four-active/32-retained registry limits. Unlike compact DC results, a completed sweep remains available after its summary is read and must be explicitly discarded after chunk consumption.
- Desktop can configure and persist a voltage-source sweep, then run it without blocking the editor. Android preserves its viewer-only boundary and runs the same persisted configuration without introducing a second document editor.
- Both clients use one chunk assembler and one responsive SVG plot. Native chunks are validated for continuity, trace identity, and aligned lengths before display; retained jobs are discarded even when validation fails. Trace visibility is interactive and rendering downsamples large traces without changing the retained source arrays.
- The shared plot synchronizes a nearest-sample cursor across every visible trace, keeps voltage and current readouts unit-aware, and supports bounded button/wheel zoom plus pointer or touch panning with an explicit reset.
- Desktop exports the exact retained samples as CSV or a standalone full-resolution SVG through the native download boundary. Android shares the inspection and navigation controls while remaining viewer-only and does not expose file-export actions.
- `.logic` schema v6 now also preserves a bounded transient configuration with duration, maximum timestep, and per-independent-source DC, pulse, or damped-sine waveforms. Normalization caps duration at one hour and raises undersized timesteps to keep persisted runs within 4,096 samples.
- The pure Rust core implements bounded adaptive transient integration. Capacitors and inductors are converted to method-specific Norton companions per timestep, then reuse the bounded nonlinear DC/Newton solver; reactive branch currents are reconstructed under the original component identities.
- Transient requests have explicit time-axis/trace/result/error types, exact endpoint sampling, source/output validation, cancellation, 4,096-sample and 1,048,576-value budgets, and a 30-second wall-clock limit. RC and RL fixtures verify delayed pulse response and reactive current behavior.
- Transient analysis now runs through the shared four-active/32-retained native worker registry with typed start, status, cancellation, summary, 512-sample aligned chunk-read, and explicit-discard commands on desktop and Android. Result arrays remain in Rust until the shared TypeScript assembler validates and consumes them.
- Native worker tests cover an RC pulse from persisted configuration through compilation, asynchronous execution, typed summary serialization, multiple chunk reads, and disposal. Malformed frontend chunks still release retained native memory.
- Desktop now configures transient duration, maximum timestep, and per-voltage-source DC/pulse/sine waveforms with bounded validation before persisting them. It runs or cancels the native job, marks results stale after electrical edits, and renders the retained traces in a dedicated result drawer.
- Android remains viewer-only but can run or cancel a persisted transient configuration and inspect its results. Both clients use the shared sampled-series plot for trace visibility, synchronized unit-aware cursors, wheel/button zoom, and pointer/touch panning over a time axis.
- Each candidate timestep is solved with backward Euler as the stable reference and trapezoidal integration as the higher-accuracy result. The trapezoidal candidate is accepted only within absolute/relative error tolerances and when it does not reverse a reactive-state delta against the backward-Euler reference; convergence failure, excessive local error, or detected ringing falls back to backward Euler.
- Adaptive timesteps never exceed the persisted maximum. Their minimum is derived from the stricter of the 4,096-sample and 1,048,576-value budgets, retries are capped at 12 per accepted sample, fallback reduces the following step, and successful low-error steps grow only up to the configured maximum. Accepted nonuniform timestamps remain exact through native retained-result chunking and the shared desktop/Android plot.

Phase 6.5 is complete. Phase 6.6 begins the separate complex-valued AC-analysis path.

## Phase 6.6: AC Analysis

- Add complex-valued matrix stamping and small-signal component linearization.
- Support logarithmic and linear frequency sweeps.
- Plot magnitude and phase and support transfer-function probes.
- Keep DC, transient, and frequency-domain result types explicit rather than sharing ambiguous arrays.

Implemented first slice:

- `collab-circuit` exposes a bounded complex-valued AC sweep with explicit frequency, magnitude, and phase result fields.
- Linear and logarithmic frequency axes support independent voltage/current source excitation and node-voltage or component-current outputs.
- Resistors, capacitors, inductors, switches, and independent sources use direct frequency-domain MNA stamping with cancellation, wall-clock, dense-matrix, sample, and result-buffer limits.
- Analytic RC low-pass fixtures verify cutoff magnitude and phase. Diodes and transistors currently return an explicit small-signal-linearization-required error instead of silently using an invalid zero-bias model.
- Native retained-result jobs, persisted AC analysis configuration, transfer-function normalization, Bode plots, and nonlinear DC-bias linearization remain for the next Phase 6.6 slices.

## Phase 6.7: Mixed-Signal Simulation

- Keep the existing deterministic digital evaluator for digital-only circuits.
- Introduce one Rust-owned mixed-signal scheduler for combined runs.
- Define explicit digital-to-analog output voltage, impedance, rise/fall time, and current limits.
- Define analog-to-digital low/high thresholds, hysteresis, propagation delay, and unknown state.
- Advance analog time to the next digital event or accepted analog timestep; bridges enqueue deterministic events at converged boundaries.
- Detect zero-time oscillation and cap event iterations with a source-mapped diagnostic.
- Reusable digital components compile to the existing digital graph rather than foreign code models.

## Phase 6.8: Offline, Cache, And Collaboration

- Simulation is entirely local and works without a server connection.
- Synchronize `.logic` source, values, probes, and analysis configuration through existing document sessions.
- Treat numerical results as derived local data, not CRDT state.
- Cache results under `.collab/simulations/` using source schema/hash, simulator version, model version, and normalized analysis configuration.
- Do not upload cached results automatically. Explicit exports may create normal vault CSV/SVG/note assets.
- Keep required source/model data in the hosted offline replica.

## Phase 6.9: Numerical Hardening And Release

- Establish published reference fixtures and independently calculated analytic fixtures; optional developer-only comparisons may use external simulators without bundling them.
- Add matrix conditioning estimates, scaling, convergence tracing, and compact user diagnostics.
- Fuzz document compilation and component validation.
- Stress cancellation, singular matrices, extreme scales, repeated runs, zero-time event loops, and bounded output behavior.
- Benchmark representative circuits on desktop and Android and enforce regression budgets.
- Inventory every numerical dependency and retain its required notices in release packaging.
- Publish the supported component equations, model limitations, tolerances, and simulator version in user documentation.

Release gate:

- All supported platforms pass identical numerical fixtures within declared tolerances.
- Offline and online runs are identical for the same source and simulator versions.
- Failed and cancelled runs cannot freeze the UI or alter source documents.
- The UI never describes unsupported models or analyses as SPICE-compatible.

## Recommended Delivery Order

1. Complete the Phase 6.0 linear DC baseline and deterministic API.
2. Land schema v6 and the schematic-to-circuit compiler together.
3. Expose validation and DC operating point as the first user-testable slice.
4. Add nonlinear diode/LED solving before transient analysis.
5. Finish runtime progress/resource budgets and Android parity before enabling larger jobs.
6. Add transient/DC sweep, then AC analysis.
7. Add mixed-signal scheduling only after both analog and digital boundaries are deterministic.
