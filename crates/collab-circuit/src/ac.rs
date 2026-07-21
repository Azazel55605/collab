use std::{
    collections::{BTreeMap, BTreeSet},
    f64::consts::PI,
    ops::{Add, AddAssign, Div, Mul, Neg, Sub, SubAssign},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{dc, Circuit, Component, ComponentId, NodeId, SimulationError};

const DEFAULT_MAX_AC_SAMPLES: usize = 4_096;
const DEFAULT_MAX_AC_VALUES: usize = 1_048_576;
const DEFAULT_MAX_AC_DURATION: Duration = Duration::from_secs(30);
const DEFAULT_MAX_DENSE_UNKNOWNS: usize = 512;
const DEFAULT_MAX_DENSE_MATRIX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AcSweepScale {
    Linear,
    Logarithmic,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcSource {
    pub component: ComponentId,
    pub magnitude: f64,
    pub phase_degrees: f64,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AcOutput {
    NodeVoltage { node: NodeId },
    ComponentCurrent { component: ComponentId },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcSweepRequest {
    pub source: AcSource,
    pub start_hertz: f64,
    pub stop_hertz: f64,
    pub sample_count: usize,
    pub scale: AcSweepScale,
    pub outputs: Vec<AcOutput>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcTrace {
    pub output: AcOutput,
    pub magnitude: Vec<f64>,
    pub phase_degrees: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcSweepResult {
    pub source: AcSource,
    pub frequencies_hertz: Vec<f64>,
    pub traces: Vec<AcTrace>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AcSweepLimits {
    pub max_samples: usize,
    pub max_result_values: usize,
    pub max_duration: Duration,
    pub max_unknowns: usize,
    pub max_matrix_bytes: usize,
}

impl Default for AcSweepLimits {
    fn default() -> Self {
        Self {
            max_samples: DEFAULT_MAX_AC_SAMPLES,
            max_result_values: DEFAULT_MAX_AC_VALUES,
            max_duration: DEFAULT_MAX_AC_DURATION,
            max_unknowns: DEFAULT_MAX_DENSE_UNKNOWNS,
            max_matrix_bytes: DEFAULT_MAX_DENSE_MATRIX_BYTES,
        }
    }
}

#[derive(Clone, Debug, Error, PartialEq, Serialize)]
#[serde(
    tag = "code",
    content = "context",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AcSweepError {
    #[error("the circuit is invalid: {0}")]
    InvalidCircuit(SimulationError),
    #[error("an AC sweep requires at least two samples")]
    InvalidSampleCount { sample_count: usize },
    #[error(
        "the AC sweep requests {sample_count} samples, exceeding the {max_samples} sample limit"
    )]
    SampleLimitExceeded {
        sample_count: usize,
        max_samples: usize,
    },
    #[error("AC sweep frequencies must be distinct, finite, and greater than zero")]
    InvalidFrequencyRange { start_hertz: f64, stop_hertz: f64 },
    #[error("the AC source magnitude and phase must be finite")]
    InvalidSourcePhasor,
    #[error("an AC sweep requires at least one output trace")]
    MissingOutputs,
    #[error("the AC sweep output is duplicated")]
    DuplicateOutput { output: AcOutput },
    #[error("AC source '{source_id}' does not exist")]
    UnknownSource { source_id: ComponentId },
    #[error("component '{source_id}' is not an independent voltage or current source")]
    UnsupportedSource { source_id: ComponentId },
    #[error("AC voltage output node '{node}' does not exist")]
    UnknownNodeOutput { node: NodeId },
    #[error("AC current output component '{component}' does not exist")]
    UnknownComponentOutput { component: ComponentId },
    #[error("component '{component}' requires DC-bias small-signal linearization")]
    SmallSignalLinearizationRequired { component: ComponentId },
    #[error("the dense AC solver supports at most {max_unknowns} unknowns, but this circuit requires {unknowns}")]
    DenseSolverSizeLimitExceeded {
        unknowns: usize,
        max_unknowns: usize,
    },
    #[error("the dense AC system for {unknowns} unknowns requires {required_bytes} bytes, exceeding the {max_bytes} byte limit")]
    MatrixMemoryLimitExceeded {
        unknowns: usize,
        required_bytes: usize,
        max_bytes: usize,
    },
    #[error("the AC sweep result requires {required_values} values, exceeding the {max_values} value limit")]
    ResultBufferLimitExceeded {
        required_values: usize,
        max_values: usize,
    },
    #[error("the AC system is singular or underconstrained near unknown {index} at {frequency_hertz} Hz")]
    SingularSystem { index: usize, frequency_hertz: f64 },
    #[error("the AC sweep was cancelled")]
    Cancelled,
    #[error("the AC sweep exceeded its {limit_millis} ms execution limit")]
    TimeLimitExceeded { limit_millis: u64 },
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Complex {
    re: f64,
    im: f64,
}

impl Complex {
    const ZERO: Self = Self { re: 0.0, im: 0.0 };
    const ONE: Self = Self { re: 1.0, im: 0.0 };

    fn polar(magnitude: f64, phase_degrees: f64) -> Self {
        let phase = phase_degrees.to_radians();
        Self {
            re: magnitude * phase.cos(),
            im: magnitude * phase.sin(),
        }
    }

    fn norm_squared(self) -> f64 {
        self.re * self.re + self.im * self.im
    }

    fn magnitude(self) -> f64 {
        self.norm_squared().sqrt()
    }

    fn phase_degrees(self) -> f64 {
        self.im.atan2(self.re).to_degrees()
    }

    fn is_finite(self) -> bool {
        self.re.is_finite() && self.im.is_finite()
    }
}

impl Add for Complex {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        Self {
            re: self.re + rhs.re,
            im: self.im + rhs.im,
        }
    }
}

impl AddAssign for Complex {
    fn add_assign(&mut self, rhs: Self) {
        *self = *self + rhs;
    }
}

impl Sub for Complex {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self {
        Self {
            re: self.re - rhs.re,
            im: self.im - rhs.im,
        }
    }
}

impl SubAssign for Complex {
    fn sub_assign(&mut self, rhs: Self) {
        *self = *self - rhs;
    }
}

impl Mul for Complex {
    type Output = Self;
    fn mul(self, rhs: Self) -> Self {
        Self {
            re: self.re * rhs.re - self.im * rhs.im,
            im: self.re * rhs.im + self.im * rhs.re,
        }
    }
}

impl Div for Complex {
    type Output = Self;
    fn div(self, rhs: Self) -> Self {
        let denominator = rhs.norm_squared();
        Self {
            re: (self.re * rhs.re + self.im * rhs.im) / denominator,
            im: (self.im * rhs.re - self.re * rhs.im) / denominator,
        }
    }
}

impl Neg for Complex {
    type Output = Self;
    fn neg(self) -> Self {
        Self {
            re: -self.re,
            im: -self.im,
        }
    }
}

pub fn sweep_ac(
    circuit: &Circuit,
    request: &AcSweepRequest,
) -> Result<AcSweepResult, AcSweepError> {
    sweep_ac_with_control(circuit, request, AcSweepLimits::default(), || false)
}

pub fn sweep_ac_with_control(
    circuit: &Circuit,
    request: &AcSweepRequest,
    limits: AcSweepLimits,
    mut should_cancel: impl FnMut() -> bool,
) -> Result<AcSweepResult, AcSweepError> {
    let topology = validate_request(circuit, request, limits)?;
    let started_at = Instant::now();
    check_control(&mut should_cancel, started_at, limits.max_duration)?;

    let frequencies_hertz = frequency_values(request);
    let mut traces = request
        .outputs
        .iter()
        .cloned()
        .map(|output| AcTrace {
            output,
            magnitude: Vec::with_capacity(request.sample_count),
            phase_degrees: Vec::with_capacity(request.sample_count),
        })
        .collect::<Vec<_>>();

    for frequency_hertz in frequencies_hertz.iter().copied() {
        check_control(&mut should_cancel, started_at, limits.max_duration)?;
        let solution = solve_frequency(
            circuit,
            request,
            &topology,
            frequency_hertz,
            &mut should_cancel,
            started_at,
            limits.max_duration,
        )?;
        for trace in &mut traces {
            let value = output_value(
                circuit,
                request,
                &topology,
                &solution,
                frequency_hertz,
                &trace.output,
            );
            trace.magnitude.push(value.magnitude());
            trace.phase_degrees.push(value.phase_degrees());
        }
    }

    Ok(AcSweepResult {
        source: request.source.clone(),
        frequencies_hertz,
        traces,
    })
}

struct Topology {
    node_indices: BTreeMap<NodeId, usize>,
    branch_indices: BTreeMap<ComponentId, usize>,
    unknown_count: usize,
}

fn validate_request(
    circuit: &Circuit,
    request: &AcSweepRequest,
    limits: AcSweepLimits,
) -> Result<Topology, AcSweepError> {
    dc::validate(circuit).map_err(AcSweepError::InvalidCircuit)?;
    if request.sample_count < 2 {
        return Err(AcSweepError::InvalidSampleCount {
            sample_count: request.sample_count,
        });
    }
    if request.sample_count > limits.max_samples {
        return Err(AcSweepError::SampleLimitExceeded {
            sample_count: request.sample_count,
            max_samples: limits.max_samples,
        });
    }
    if !request.start_hertz.is_finite()
        || !request.stop_hertz.is_finite()
        || request.start_hertz <= 0.0
        || request.stop_hertz <= 0.0
        || request.start_hertz == request.stop_hertz
    {
        return Err(AcSweepError::InvalidFrequencyRange {
            start_hertz: request.start_hertz,
            stop_hertz: request.stop_hertz,
        });
    }
    if !request.source.magnitude.is_finite() || !request.source.phase_degrees.is_finite() {
        return Err(AcSweepError::InvalidSourcePhasor);
    }
    if request.outputs.is_empty() {
        return Err(AcSweepError::MissingOutputs);
    }
    let required_values = request
        .outputs
        .len()
        .checked_mul(2)
        .and_then(|trace_values| trace_values.checked_add(1))
        .and_then(|values_per_sample| values_per_sample.checked_mul(request.sample_count))
        .unwrap_or(usize::MAX);
    if required_values > limits.max_result_values {
        return Err(AcSweepError::ResultBufferLimitExceeded {
            required_values,
            max_values: limits.max_result_values,
        });
    }

    let source = circuit
        .components
        .iter()
        .find(|component| component.id() == &request.source.component)
        .ok_or_else(|| AcSweepError::UnknownSource {
            source_id: request.source.component.clone(),
        })?;
    if !matches!(
        source,
        Component::VoltageSource { .. } | Component::CurrentSource { .. }
    ) {
        return Err(AcSweepError::UnsupportedSource {
            source_id: request.source.component.clone(),
        });
    }
    if let Some(component) = circuit.components.iter().find(|component| {
        matches!(
            component,
            Component::Diode { .. } | Component::BipolarNpn { .. }
        )
    }) {
        return Err(AcSweepError::SmallSignalLinearizationRequired {
            component: component.id().clone(),
        });
    }

    let nodes = circuit
        .components
        .iter()
        .flat_map(Component::nodes)
        .cloned()
        .chain(std::iter::once(circuit.reference.clone()))
        .collect::<BTreeSet<_>>();
    let component_ids = circuit
        .components
        .iter()
        .map(|component| component.id().clone())
        .collect::<BTreeSet<_>>();
    let mut outputs = BTreeSet::new();
    for output in &request.outputs {
        if !outputs.insert(output.clone()) {
            return Err(AcSweepError::DuplicateOutput {
                output: output.clone(),
            });
        }
        match output {
            AcOutput::NodeVoltage { node } if !nodes.contains(node) => {
                return Err(AcSweepError::UnknownNodeOutput { node: node.clone() });
            }
            AcOutput::ComponentCurrent { component } if !component_ids.contains(component) => {
                return Err(AcSweepError::UnknownComponentOutput {
                    component: component.clone(),
                });
            }
            _ => {}
        }
    }

    let non_reference_nodes = nodes
        .into_iter()
        .filter(|node| node != &circuit.reference)
        .collect::<Vec<_>>();
    let node_indices = non_reference_nodes
        .into_iter()
        .enumerate()
        .map(|(index, node)| (node, index))
        .collect::<BTreeMap<_, _>>();
    let mut branch_components = circuit
        .components
        .iter()
        .filter_map(|component| match component {
            Component::VoltageSource { id, .. } => Some(id.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    branch_components.sort();
    let branch_indices = branch_components
        .into_iter()
        .enumerate()
        .map(|(index, id)| (id, node_indices.len() + index))
        .collect::<BTreeMap<_, _>>();
    let unknown_count = node_indices.len() + branch_indices.len();
    if unknown_count > limits.max_unknowns {
        return Err(AcSweepError::DenseSolverSizeLimitExceeded {
            unknowns: unknown_count,
            max_unknowns: limits.max_unknowns,
        });
    }
    let required_matrix_bytes = dense_working_set_bytes(unknown_count).unwrap_or(usize::MAX);
    if required_matrix_bytes > limits.max_matrix_bytes {
        return Err(AcSweepError::MatrixMemoryLimitExceeded {
            unknowns: unknown_count,
            required_bytes: required_matrix_bytes,
            max_bytes: limits.max_matrix_bytes,
        });
    }

    Ok(Topology {
        node_indices,
        branch_indices,
        unknown_count,
    })
}

fn frequency_values(request: &AcSweepRequest) -> Vec<f64> {
    let denominator = (request.sample_count - 1) as f64;
    (0..request.sample_count)
        .map(|index| {
            if index == 0 {
                request.start_hertz
            } else if index + 1 == request.sample_count {
                request.stop_hertz
            } else {
                let fraction = index as f64 / denominator;
                match request.scale {
                    AcSweepScale::Linear => {
                        request.start_hertz + (request.stop_hertz - request.start_hertz) * fraction
                    }
                    AcSweepScale::Logarithmic => (request.start_hertz.ln()
                        + (request.stop_hertz.ln() - request.start_hertz.ln()) * fraction)
                        .exp(),
                }
            }
        })
        .collect()
}

fn solve_frequency(
    circuit: &Circuit,
    request: &AcSweepRequest,
    topology: &Topology,
    frequency_hertz: f64,
    should_cancel: &mut impl FnMut() -> bool,
    started_at: Instant,
    max_duration: Duration,
) -> Result<Vec<Complex>, AcSweepError> {
    let mut matrix = vec![vec![Complex::ZERO; topology.unknown_count]; topology.unknown_count];
    let mut rhs = vec![Complex::ZERO; topology.unknown_count];
    let omega = 2.0 * PI * frequency_hertz;
    let source_value = Complex::polar(request.source.magnitude, request.source.phase_degrees);

    for component in &circuit.components {
        check_control(should_cancel, started_at, max_duration)?;
        match component {
            Component::Resistor {
                positive,
                negative,
                resistance_ohms,
                ..
            } => stamp_admittance(
                &mut matrix,
                topology.node_indices.get(positive).copied(),
                topology.node_indices.get(negative).copied(),
                Complex {
                    re: 1.0 / resistance_ohms,
                    im: 0.0,
                },
            ),
            Component::Capacitor {
                positive,
                negative,
                capacitance_farads,
                ..
            } => stamp_admittance(
                &mut matrix,
                topology.node_indices.get(positive).copied(),
                topology.node_indices.get(negative).copied(),
                Complex {
                    re: 0.0,
                    im: omega * capacitance_farads,
                },
            ),
            Component::Inductor {
                positive,
                negative,
                inductance_henries,
                ..
            } => stamp_admittance(
                &mut matrix,
                topology.node_indices.get(positive).copied(),
                topology.node_indices.get(negative).copied(),
                Complex {
                    re: 0.0,
                    im: -1.0 / (omega * inductance_henries),
                },
            ),
            Component::Switch {
                positive,
                negative,
                closed,
                closed_resistance_ohms,
                open_resistance_ohms,
                ..
            } => {
                let resistance = if *closed {
                    *closed_resistance_ohms
                } else {
                    *open_resistance_ohms
                };
                stamp_admittance(
                    &mut matrix,
                    topology.node_indices.get(positive).copied(),
                    topology.node_indices.get(negative).copied(),
                    Complex {
                        re: 1.0 / resistance,
                        im: 0.0,
                    },
                );
            }
            Component::CurrentSource {
                id,
                positive,
                negative,
                ..
            } => stamp_current_source(
                &mut rhs,
                topology.node_indices.get(positive).copied(),
                topology.node_indices.get(negative).copied(),
                if id == &request.source.component {
                    source_value
                } else {
                    Complex::ZERO
                },
            ),
            Component::VoltageSource {
                id,
                positive,
                negative,
                ..
            } => stamp_voltage_source(
                &mut matrix,
                &mut rhs,
                topology.node_indices.get(positive).copied(),
                topology.node_indices.get(negative).copied(),
                topology.branch_indices[id],
                if id == &request.source.component {
                    source_value
                } else {
                    Complex::ZERO
                },
            ),
            Component::Diode { .. } | Component::BipolarNpn { .. } => {
                unreachable!("validated before solving")
            }
        }
    }

    solve_linear_system(
        matrix,
        rhs,
        frequency_hertz,
        should_cancel,
        started_at,
        max_duration,
    )
}

fn output_value(
    circuit: &Circuit,
    request: &AcSweepRequest,
    topology: &Topology,
    solution: &[Complex],
    frequency_hertz: f64,
    output: &AcOutput,
) -> Complex {
    let voltage_at = |node: &NodeId| {
        topology
            .node_indices
            .get(node)
            .map(|index| solution[*index])
            .unwrap_or(Complex::ZERO)
    };
    match output {
        AcOutput::NodeVoltage { node } => voltage_at(node),
        AcOutput::ComponentCurrent { component } => {
            let component = circuit
                .components
                .iter()
                .find(|candidate| candidate.id() == component)
                .expect("validated output component");
            let omega = 2.0 * PI * frequency_hertz;
            match component {
                Component::Resistor {
                    positive,
                    negative,
                    resistance_ohms,
                    ..
                } => {
                    (voltage_at(positive) - voltage_at(negative))
                        / Complex {
                            re: *resistance_ohms,
                            im: 0.0,
                        }
                }
                Component::Capacitor {
                    positive,
                    negative,
                    capacitance_farads,
                    ..
                } => {
                    (voltage_at(positive) - voltage_at(negative))
                        * Complex {
                            re: 0.0,
                            im: omega * capacitance_farads,
                        }
                }
                Component::Inductor {
                    positive,
                    negative,
                    inductance_henries,
                    ..
                } => {
                    (voltage_at(positive) - voltage_at(negative))
                        * Complex {
                            re: 0.0,
                            im: -1.0 / (omega * inductance_henries),
                        }
                }
                Component::Switch {
                    positive,
                    negative,
                    closed,
                    closed_resistance_ohms,
                    open_resistance_ohms,
                    ..
                } => {
                    let resistance = if *closed {
                        *closed_resistance_ohms
                    } else {
                        *open_resistance_ohms
                    };
                    (voltage_at(positive) - voltage_at(negative))
                        / Complex {
                            re: resistance,
                            im: 0.0,
                        }
                }
                Component::CurrentSource { id, .. } => {
                    if id == &request.source.component {
                        Complex::polar(request.source.magnitude, request.source.phase_degrees)
                    } else {
                        Complex::ZERO
                    }
                }
                Component::VoltageSource { id, .. } => solution[topology.branch_indices[id]],
                Component::Diode { .. } | Component::BipolarNpn { .. } => {
                    unreachable!("validated before solving")
                }
            }
        }
    }
}

fn stamp_admittance(
    matrix: &mut [Vec<Complex>],
    positive: Option<usize>,
    negative: Option<usize>,
    admittance: Complex,
) {
    if let Some(index) = positive {
        matrix[index][index] += admittance;
    }
    if let Some(index) = negative {
        matrix[index][index] += admittance;
    }
    if let (Some(positive), Some(negative)) = (positive, negative) {
        matrix[positive][negative] -= admittance;
        matrix[negative][positive] -= admittance;
    }
}

fn stamp_current_source(
    rhs: &mut [Complex],
    positive: Option<usize>,
    negative: Option<usize>,
    current: Complex,
) {
    if let Some(index) = positive {
        rhs[index] -= current;
    }
    if let Some(index) = negative {
        rhs[index] += current;
    }
}

fn stamp_voltage_source(
    matrix: &mut [Vec<Complex>],
    rhs: &mut [Complex],
    positive: Option<usize>,
    negative: Option<usize>,
    source_index: usize,
    voltage: Complex,
) {
    if let Some(index) = positive {
        matrix[index][source_index] += Complex::ONE;
        matrix[source_index][index] += Complex::ONE;
    }
    if let Some(index) = negative {
        matrix[index][source_index] -= Complex::ONE;
        matrix[source_index][index] -= Complex::ONE;
    }
    rhs[source_index] += voltage;
}

fn solve_linear_system(
    mut matrix: Vec<Vec<Complex>>,
    mut rhs: Vec<Complex>,
    frequency_hertz: f64,
    should_cancel: &mut impl FnMut() -> bool,
    started_at: Instant,
    max_duration: Duration,
) -> Result<Vec<Complex>, AcSweepError> {
    let size = rhs.len();
    for column in 0..size {
        check_control(should_cancel, started_at, max_duration)?;
        let pivot = (column..size)
            .max_by(|left, right| {
                matrix[*left][column]
                    .norm_squared()
                    .total_cmp(&matrix[*right][column].norm_squared())
            })
            .expect("a non-empty pivot range");
        let pivot_value = matrix[pivot][column];
        if pivot_value.norm_squared() == 0.0 || !pivot_value.is_finite() {
            return Err(AcSweepError::SingularSystem {
                index: column,
                frequency_hertz,
            });
        }
        matrix.swap(column, pivot);
        rhs.swap(column, pivot);

        for row in (column + 1)..size {
            let factor = matrix[row][column] / matrix[column][column];
            let pivot_rhs = rhs[column];
            matrix[row][column] = Complex::ZERO;
            for next_column in (column + 1)..size {
                let pivot_value = matrix[column][next_column];
                matrix[row][next_column] -= factor * pivot_value;
            }
            rhs[row] -= factor * pivot_rhs;
        }
    }

    let mut solution = vec![Complex::ZERO; size];
    for row in (0..size).rev() {
        check_control(should_cancel, started_at, max_duration)?;
        let remainder = ((row + 1)..size).fold(Complex::ZERO, |sum, column| {
            sum + matrix[row][column] * solution[column]
        });
        solution[row] = (rhs[row] - remainder) / matrix[row][row];
    }
    Ok(solution)
}

fn dense_working_set_bytes(unknown_count: usize) -> Option<usize> {
    let scalar = std::mem::size_of::<Complex>();
    let matrix_values = unknown_count.checked_mul(unknown_count)?;
    let numeric_values = matrix_values
        .checked_add(unknown_count)?
        .checked_add(unknown_count)?;
    let numeric_bytes = numeric_values.checked_mul(scalar)?;
    let row_headers = unknown_count.checked_mul(std::mem::size_of::<Vec<Complex>>())?;
    numeric_bytes.checked_add(row_headers)
}

fn check_control(
    should_cancel: &mut impl FnMut() -> bool,
    started_at: Instant,
    max_duration: Duration,
) -> Result<(), AcSweepError> {
    if should_cancel() {
        return Err(AcSweepError::Cancelled);
    }
    if started_at.elapsed() >= max_duration {
        return Err(AcSweepError::TimeLimitExceeded {
            limit_millis: max_duration.as_millis().min(u64::MAX as u128) as u64,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str) -> NodeId {
        NodeId::new(id)
    }

    fn component(id: &str) -> ComponentId {
        ComponentId::new(id)
    }

    fn rc_low_pass() -> Circuit {
        Circuit {
            reference: node("0"),
            components: vec![
                Component::VoltageSource {
                    id: component("V1"),
                    positive: node("vin"),
                    negative: node("0"),
                    voltage_volts: 5.0,
                },
                Component::Resistor {
                    id: component("R1"),
                    positive: node("vin"),
                    negative: node("out"),
                    resistance_ohms: 1_000.0,
                },
                Component::Capacitor {
                    id: component("C1"),
                    positive: node("out"),
                    negative: node("0"),
                    capacitance_farads: 1.0e-6,
                },
            ],
        }
    }

    fn request() -> AcSweepRequest {
        AcSweepRequest {
            source: AcSource {
                component: component("V1"),
                magnitude: 1.0,
                phase_degrees: 0.0,
            },
            start_hertz: 10.0,
            stop_hertz: 1_000.0,
            sample_count: 3,
            scale: AcSweepScale::Logarithmic,
            outputs: vec![AcOutput::NodeVoltage { node: node("out") }],
        }
    }

    fn assert_close(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "{actual} != {expected}"
        );
    }

    #[test]
    fn solves_rc_low_pass_magnitude_and_phase_at_cutoff() {
        let cutoff = 1.0 / (2.0 * PI * 1_000.0 * 1.0e-6);
        let mut request = request();
        request.start_hertz = cutoff / 2.0;
        request.stop_hertz = cutoff * 2.0;
        request.sample_count = 3;
        let result = sweep_ac(&rc_low_pass(), &request).unwrap();

        assert_close(result.frequencies_hertz[1], cutoff, 1.0e-9);
        assert_close(result.traces[0].magnitude[1], 1.0 / 2.0_f64.sqrt(), 1.0e-9);
        assert_close(result.traces[0].phase_degrees[1], -45.0, 1.0e-9);
    }

    #[test]
    fn generates_linear_and_logarithmic_frequency_axes_with_exact_endpoints() {
        let mut request = request();
        request.scale = AcSweepScale::Linear;
        assert_eq!(
            sweep_ac(&rc_low_pass(), &request)
                .unwrap()
                .frequencies_hertz,
            vec![10.0, 505.0, 1_000.0]
        );

        request.scale = AcSweepScale::Logarithmic;
        let frequencies = sweep_ac(&rc_low_pass(), &request)
            .unwrap()
            .frequencies_hertz;
        assert_eq!(frequencies[0], 10.0);
        assert_close(frequencies[1], 100.0, 1.0e-12);
        assert_eq!(frequencies[2], 1_000.0);
    }

    #[test]
    fn reports_component_current_and_preserves_source_phase() {
        let mut request = request();
        request.source.phase_degrees = 30.0;
        request.outputs = vec![AcOutput::ComponentCurrent {
            component: component("C1"),
        }];
        let result = sweep_ac(&rc_low_pass(), &request).unwrap();

        assert!(result.traces[0].magnitude.iter().all(|value| *value > 0.0));
        assert!(result.traces[0].phase_degrees[0] > 30.0);
    }

    #[test]
    fn rejects_nonlinear_components_until_bias_linearization_exists() {
        let mut circuit = rc_low_pass();
        circuit.components.push(Component::Diode {
            id: component("D1"),
            anode: node("out"),
            cathode: node("0"),
            saturation_current_amps: 1.0e-12,
            emission_coefficient: 1.0,
            thermal_voltage_volts: 0.02585,
        });
        assert_eq!(
            sweep_ac(&circuit, &request()),
            Err(AcSweepError::SmallSignalLinearizationRequired {
                component: component("D1")
            })
        );
    }

    #[test]
    fn enforces_result_and_execution_bounds() {
        let request = request();
        assert!(matches!(
            sweep_ac_with_control(
                &rc_low_pass(),
                &request,
                AcSweepLimits {
                    max_result_values: 8,
                    ..AcSweepLimits::default()
                },
                || false,
            ),
            Err(AcSweepError::ResultBufferLimitExceeded {
                required_values: 9,
                max_values: 8
            })
        ));
        assert_eq!(
            sweep_ac_with_control(&rc_low_pass(), &request, AcSweepLimits::default(), || true,),
            Err(AcSweepError::Cancelled)
        );
    }

    #[test]
    fn result_serialization_keeps_frequency_domain_fields_explicit() {
        let result = sweep_ac(&rc_low_pass(), &request()).unwrap();
        let value = serde_json::to_value(result).unwrap();

        assert!(value.get("frequenciesHertz").is_some());
        assert!(value["traces"][0].get("magnitude").is_some());
        assert!(value["traces"][0].get("phaseDegrees").is_some());
        assert!(value["traces"][0].get("values").is_none());
    }
}
