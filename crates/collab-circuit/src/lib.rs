//! First-party circuit simulation primitives for Collab.
//!
//! The crate has no UI, platform, filesystem, or network dependencies. Its
//! public model is intentionally independent of the matrix backend so later
//! sparse and transient solvers can reuse the same validated circuit boundary.

mod compiler;
mod dc;
mod model;
mod sweep;
mod transient;

pub use compiler::{
    compile_schematic, CompilationError, CompiledCircuit, DiagramMode, ProbeMap, ProbeTarget,
    SchematicComponentKind, SchematicDcSweepConfig, SchematicDocument,
    SchematicElectricalParameters, SchematicNode, SchematicProbe, SchematicProbeKind,
    SchematicSimulationConfig, SchematicSourceMap, SchematicSourceWaveform,
    SchematicTransientConfig, SchematicWire, TerminalNet, TerminalRef, WireEndpointRole, WireNet,
};
pub use dc::{
    solve_dc, solve_dc_with_control, solve_dc_with_limits, DcDiagnostic, DcOperatingPoint,
    DcSolveLimits, SimulationError,
};
pub use model::{Circuit, Component, ComponentId, NodeId};
pub use sweep::{
    dc_sweep_outputs_for_probes, sweep_dc, sweep_dc_with_control, DcSweepError, DcSweepLimits,
    DcSweepOutput, DcSweepRequest, DcSweepResult, DcSweepTrace,
};
pub use transient::{
    solve_transient, solve_transient_with_control, transient_outputs_for_probes, SourceWaveform,
    TransientError, TransientLimits, TransientOutput, TransientRequest, TransientResult,
    TransientTrace,
};
