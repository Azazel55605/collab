# collab-circuit

`collab-circuit` is Collab's first-party, MIT-licensed circuit simulation core.
It intentionally has no Tauri, filesystem, network, or external simulator
dependency so the same deterministic implementation can run on desktop and
Android.

The current Phase 6.0-6.5 implementation provides:

- typed node and component identifiers;
- resistors, capacitors, inductors, resistive switches, independent
  current/voltage sources, built-in diode/LED models, and a deliberately scoped
  two-junction NPN model with forward-active and saturation behavior;
- numeric and identity validation;
- deterministic modified nodal analysis ordering;
- a pivoted dense DC solver with damped Newton-Raphson iteration;
- nonlinear-terminal voltage limiting that leaves exact linear source nodes free
  to settle immediately across high dynamic ranges;
- shared wall-clock, 512-unknown, and estimated dense-working-set limits with
  typed failures;
- node-voltage, component-current, and passive-sign-convention component-power
  operating-point results;
- typed diagnostics when the basic NPN model enters unsupported reverse-active
  operation;
- deterministic schematic terminal/wire net compilation with terminal fan-out,
  explicit junction nodes, and disconnected visual crossings;
- source maps from terminals, wires, and persisted probes to electrical nodes
  or component branches, with stale probe-target validation;
- bounded, source-mapped topology validation for disconnected terminals,
  DC-floating islands, and inconsistent or redundant ideal-voltage loops;
- typed golden compiler contracts for every supported schematic component plus
  generated branch/order/rotation invariants; and
- a synchronous compatibility solve boundary plus a cancellable solver callback
  used by the bounded, stage-reporting Tauri worker runtime shared by desktop
  and Android builds; and
- a deterministic linear DC source-sweep core with explicit requested traces,
  cancellation, per-sample error context, and sample/result/time budgets; and
- a bounded adaptive transient solver with capacitor and inductor Norton
  companions, trapezoidal integration checked against a backward-Euler
  reference, ringing/convergence fallback, exact endpoint sampling, reactive
  branch-current reconstruction, and DC/pulse/damped-sine source waveforms.

Capacitors are open circuits and inductors are ideal shorts for DC operating
point analysis. The built-in NPN model uses exponential base-emitter and
base-collector junctions, fixed forward gain, and a conservative fixed reverse
gain to model forward-active and saturation behavior. Reverse-active operation,
breakdown, capacitances, Early effect, high-level injection, and temperature
variation remain unsupported. Bias points outside that supported region are
returned with an explicit diagnostic instead of silently implying full
BJT-model accuracy.
Transient analysis uses nonuniform adaptive timesteps bounded by the configured
maximum and a sample/result-budget-derived minimum. Trapezoidal candidates are
accepted only when they agree with the stable backward-Euler reference and do
not show method-induced ringing; bounded rejection and fallback keep difficult
steps deterministic. Native transient jobs share the bounded DC/sweep registry
and expose retained 512-sample chunk reads; desktop provides persisted
configuration/run/plot controls while Android runs and plots that configuration
through its viewer-only surface.

The dense matrix implementation is a small-circuit correctness baseline. A
representative 256-node ladder uses only about 1.17% of its dense matrix cells,
so a reviewed sparse backend is required before the explicit 512-unknown limit
or compiler diagram limits are raised. The
public circuit and result types are kept independent of that backend so later
sparse, transient, AC, and mixed-signal solvers can replace or extend
it without changing callers.

See `docs/electronic-circuit-simulation-plan.md` for scope and sequencing.
