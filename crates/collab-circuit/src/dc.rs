use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{Circuit, Component, ComponentId, NodeId};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DcOperatingPoint {
    pub node_voltages: BTreeMap<NodeId, f64>,
    /// Conventional primary branch current. For an NPN transistor this is the
    /// collector-to-emitter current.
    pub component_currents: BTreeMap<ComponentId, f64>,
    /// Passive-sign-convention power: positive values absorb power and
    /// negative values deliver power.
    pub component_powers: BTreeMap<ComponentId, f64>,
    pub diagnostics: Vec<DcDiagnostic>,
    pub iterations: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "code",
    content = "context",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DcDiagnostic {
    NpnOutsideForwardActive {
        component: ComponentId,
        base_emitter_voltage: f64,
        collector_emitter_voltage: f64,
    },
}

#[derive(Clone, Debug, Error, PartialEq, Serialize)]
#[serde(
    tag = "code",
    content = "context",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SimulationError {
    #[error("the circuit reference node is empty")]
    EmptyReference,
    #[error("component id '{0}' is empty")]
    EmptyComponentId(ComponentId),
    #[error("component id '{0}' is duplicated")]
    DuplicateComponentId(ComponentId),
    #[error("component '{component}' uses an empty node id")]
    EmptyNodeId { component: ComponentId },
    #[error("component '{component}' has a non-finite {field}")]
    NonFiniteValue {
        component: ComponentId,
        field: &'static str,
    },
    #[error("resistor '{component}' must have resistance greater than zero")]
    InvalidResistance { component: ComponentId },
    #[error("capacitor '{component}' must have capacitance greater than zero")]
    InvalidCapacitance { component: ComponentId },
    #[error("inductor '{component}' must have inductance greater than zero")]
    InvalidInductance { component: ComponentId },
    #[error("switch '{component}' must have positive open and closed resistances")]
    InvalidSwitchResistance { component: ComponentId },
    #[error("diode '{component}' has invalid model parameters")]
    InvalidDiodeModel { component: ComponentId },
    #[error("NPN transistor '{component}' has invalid model parameters")]
    InvalidBipolarModel { component: ComponentId },
    #[error("the DC system is singular or underconstrained near unknown {index}")]
    SingularSystem { index: usize },
    #[error("the nonlinear DC solution did not converge after {iterations} iterations")]
    ConvergenceFailed { iterations: usize },
    #[error(
        "the dense DC solver supports at most {max_unknowns} unknowns, but this circuit requires {unknowns}"
    )]
    DenseSolverSizeLimitExceeded {
        unknowns: usize,
        max_unknowns: usize,
    },
    #[error("the circuit simulation was cancelled")]
    Cancelled,
    #[error("the circuit simulation exceeded its {limit_millis} ms execution limit")]
    TimeLimitExceeded { limit_millis: u64 },
    #[error(
        "the dense DC system for {unknowns} unknowns requires {required_bytes} bytes, exceeding the {max_bytes} byte limit"
    )]
    MatrixMemoryLimitExceeded {
        unknowns: usize,
        required_bytes: usize,
        max_bytes: usize,
    },
}

const MAX_NEWTON_ITERATIONS: usize = 100;
const MAX_NEWTON_VOLTAGE_STEP: f64 = 0.25;
const ABSOLUTE_TOLERANCE: f64 = 1.0e-9;
const RELATIVE_TOLERANCE: f64 = 1.0e-6;
const MIN_EXPONENT: f64 = -40.0;
const MAX_EXPONENT: f64 = 40.0;
// The persisted baseline exposes only forward beta. A conservative fixed
// reverse beta closes the Ebers-Moll-style saturation path without pretending
// to provide a configurable reverse-active transistor model.
const NPN_REVERSE_BETA: f64 = 1.0;
const DEFAULT_MAX_DC_DURATION: Duration = Duration::from_secs(10);
const DEFAULT_MAX_DENSE_UNKNOWNS: usize = 512;
const DEFAULT_MAX_DENSE_MATRIX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DcSolveLimits {
    pub max_duration: Duration,
    pub max_unknowns: usize,
    pub max_matrix_bytes: usize,
}

impl Default for DcSolveLimits {
    fn default() -> Self {
        Self {
            max_duration: DEFAULT_MAX_DC_DURATION,
            max_unknowns: DEFAULT_MAX_DENSE_UNKNOWNS,
            max_matrix_bytes: DEFAULT_MAX_DENSE_MATRIX_BYTES,
        }
    }
}

/// Solve the DC operating point using modified nodal analysis.
///
/// This baseline uses a pivoted dense matrix. The circuit and result boundary
/// is backend-independent so a sparse solver can replace it without changing
/// callers.
pub fn solve_dc(circuit: &Circuit) -> Result<DcOperatingPoint, SimulationError> {
    solve_dc_with_control(circuit, || false)
}

/// Solve a DC operating point while periodically consulting a cancellation
/// callback. This keeps the numerical crate independent of any async runtime.
pub fn solve_dc_with_control(
    circuit: &Circuit,
    should_cancel: impl FnMut() -> bool,
) -> Result<DcOperatingPoint, SimulationError> {
    solve_dc_with_limits(circuit, DcSolveLimits::default(), should_cancel)
}

pub fn solve_dc_with_limits(
    circuit: &Circuit,
    limits: DcSolveLimits,
    mut should_cancel: impl FnMut() -> bool,
) -> Result<DcOperatingPoint, SimulationError> {
    let started_at = Instant::now();
    check_execution_control(&mut should_cancel, started_at, limits)?;
    validate(circuit)?;

    let mut components: Vec<_> = circuit.components.iter().collect();
    components.sort_by(|left, right| left.id().cmp(right.id()));

    let mut nodes = BTreeSet::new();
    for component in &components {
        for node in component.nodes() {
            if node != &circuit.reference {
                nodes.insert(node.clone());
            }
        }
    }
    let nodes: Vec<_> = nodes.into_iter().collect();
    let node_indices: BTreeMap<_, _> = nodes
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, node)| (node, index))
        .collect();

    let mut branch_components: Vec<_> = circuit
        .components
        .iter()
        .filter_map(|component| match component {
            Component::VoltageSource { id, .. } | Component::Inductor { id, .. } => {
                Some(id.clone())
            }
            _ => None,
        })
        .collect();
    branch_components.sort();
    let branch_indices: BTreeMap<_, _> = branch_components
        .iter()
        .cloned()
        .enumerate()
        .map(|(index, id)| (id, nodes.len() + index))
        .collect();

    let unknown_count = nodes.len() + branch_components.len();
    if unknown_count > limits.max_unknowns {
        return Err(SimulationError::DenseSolverSizeLimitExceeded {
            unknowns: unknown_count,
            max_unknowns: limits.max_unknowns,
        });
    }
    let required_matrix_bytes = dense_working_set_bytes(unknown_count).unwrap_or(usize::MAX);
    if required_matrix_bytes > limits.max_matrix_bytes {
        return Err(SimulationError::MatrixMemoryLimitExceeded {
            unknowns: unknown_count,
            required_bytes: required_matrix_bytes,
            max_bytes: limits.max_matrix_bytes,
        });
    }
    let nonlinear = components.iter().any(|component| {
        matches!(
            component,
            Component::Diode { .. } | Component::BipolarNpn { .. }
        )
    });
    let limited_voltage_indices = nonlinear_voltage_indices(&components, &node_indices);
    let mut guess = vec![0.0; unknown_count];
    let mut solution = Vec::new();
    let mut iterations = 0;

    for iteration in 1..=if nonlinear { MAX_NEWTON_ITERATIONS } else { 1 } {
        check_execution_control(&mut should_cancel, started_at, limits)?;
        iterations = iteration;
        let (matrix, rhs) = assemble_system(
            &components,
            &node_indices,
            &branch_indices,
            &guess,
            unknown_count,
        );
        let candidate = if unknown_count == 0 {
            Vec::new()
        } else {
            solve_linear_system(matrix, rhs, &mut should_cancel, started_at, limits)?
        };

        if !nonlinear || has_converged(&guess, &candidate) {
            solution = candidate;
            break;
        }

        damp_voltage_update(&mut guess, &candidate, &limited_voltage_indices);
    }

    if nonlinear && solution.is_empty() && unknown_count != 0 {
        return Err(SimulationError::ConvergenceFailed { iterations });
    }

    let mut node_voltages = BTreeMap::from([(circuit.reference.clone(), 0.0)]);
    for (node, index) in &node_indices {
        node_voltages.insert(node.clone(), solution[*index]);
    }

    let voltage_at = |node: &NodeId| node_voltages.get(node).copied().unwrap_or(0.0);
    let mut component_currents = BTreeMap::new();
    let mut component_powers = BTreeMap::new();
    let mut diagnostics = Vec::new();
    for component in &components {
        check_execution_control(&mut should_cancel, started_at, limits)?;
        let current = match component {
            Component::Resistor {
                positive,
                negative,
                resistance_ohms,
                ..
            } => (voltage_at(positive) - voltage_at(negative)) / resistance_ohms,
            Component::Capacitor { .. } => 0.0,
            Component::Inductor { id, .. } => solution[branch_indices[id]],
            Component::Switch {
                positive,
                negative,
                closed,
                closed_resistance_ohms,
                open_resistance_ohms,
                ..
            } => {
                let resistance = if *closed {
                    closed_resistance_ohms
                } else {
                    open_resistance_ohms
                };
                (voltage_at(positive) - voltage_at(negative)) / resistance
            }
            Component::Diode {
                anode,
                cathode,
                saturation_current_amps,
                emission_coefficient,
                thermal_voltage_volts,
                ..
            } => diode_current(
                voltage_at(anode) - voltage_at(cathode),
                *saturation_current_amps,
                *emission_coefficient,
                *thermal_voltage_volts,
            ),
            Component::BipolarNpn {
                base,
                collector,
                emitter,
                saturation_current_amps,
                forward_beta,
                emission_coefficient,
                thermal_voltage_volts,
                ..
            } => {
                let base_current = diode_current(
                    voltage_at(base) - voltage_at(emitter),
                    *saturation_current_amps,
                    *emission_coefficient,
                    *thermal_voltage_volts,
                );
                let reverse_saturation =
                    npn_reverse_saturation(*saturation_current_amps, *forward_beta);
                let base_collector_current = diode_current(
                    voltage_at(base) - voltage_at(collector),
                    reverse_saturation,
                    *emission_coefficient,
                    *thermal_voltage_volts,
                );
                *forward_beta * base_current - (NPN_REVERSE_BETA + 1.0) * base_collector_current
            }
            Component::CurrentSource { current_amps, .. } => *current_amps,
            Component::VoltageSource { id, .. } => solution[branch_indices[id]],
        };
        component_currents.insert(component.id().clone(), current);

        let power = match component {
            Component::Resistor {
                positive, negative, ..
            }
            | Component::Capacitor {
                positive, negative, ..
            }
            | Component::Inductor {
                positive, negative, ..
            }
            | Component::Switch {
                positive, negative, ..
            }
            | Component::CurrentSource {
                positive, negative, ..
            }
            | Component::VoltageSource {
                positive, negative, ..
            } => (voltage_at(positive) - voltage_at(negative)) * current,
            Component::Diode { anode, cathode, .. } => {
                (voltage_at(anode) - voltage_at(cathode)) * current
            }
            Component::BipolarNpn {
                base,
                collector,
                emitter,
                saturation_current_amps,
                forward_beta,
                emission_coefficient,
                thermal_voltage_volts,
                ..
            } => {
                let base_emitter_voltage = voltage_at(base) - voltage_at(emitter);
                let collector_emitter_voltage = voltage_at(collector) - voltage_at(emitter);
                let base_current = diode_current(
                    base_emitter_voltage,
                    *saturation_current_amps,
                    *emission_coefficient,
                    *thermal_voltage_volts,
                );
                let base_collector_current = diode_current(
                    voltage_at(base) - voltage_at(collector),
                    npn_reverse_saturation(*saturation_current_amps, *forward_beta),
                    *emission_coefficient,
                    *thermal_voltage_volts,
                );
                if collector_emitter_voltage < 0.0 {
                    diagnostics.push(DcDiagnostic::NpnOutsideForwardActive {
                        component: component.id().clone(),
                        base_emitter_voltage,
                        collector_emitter_voltage,
                    });
                }
                let terminal_base_current = base_current + base_collector_current;
                collector_emitter_voltage * current + base_emitter_voltage * terminal_base_current
            }
        };
        component_powers.insert(component.id().clone(), power);
    }

    Ok(DcOperatingPoint {
        node_voltages,
        component_currents,
        component_powers,
        diagnostics,
        iterations,
    })
}

fn dense_working_set_bytes(unknown_count: usize) -> Option<usize> {
    let numeric_bytes = unknown_count
        .checked_mul(unknown_count)?
        .checked_add(unknown_count.checked_mul(3)?)?
        .checked_mul(std::mem::size_of::<f64>())?;
    let row_headers = unknown_count.checked_mul(std::mem::size_of::<Vec<f64>>())?;
    numeric_bytes
        .checked_add(row_headers)?
        .checked_add(std::mem::size_of::<Vec<Vec<f64>>>())
}

fn check_execution_control(
    should_cancel: &mut impl FnMut() -> bool,
    started_at: Instant,
    limits: DcSolveLimits,
) -> Result<(), SimulationError> {
    if should_cancel() {
        return Err(SimulationError::Cancelled);
    }
    if started_at.elapsed() >= limits.max_duration {
        return Err(SimulationError::TimeLimitExceeded {
            limit_millis: limits.max_duration.as_millis().min(u64::MAX as u128) as u64,
        });
    }
    Ok(())
}

fn assemble_system(
    components: &[&Component],
    node_indices: &BTreeMap<NodeId, usize>,
    branch_indices: &BTreeMap<ComponentId, usize>,
    guess: &[f64],
    unknown_count: usize,
) -> (Vec<Vec<f64>>, Vec<f64>) {
    let mut matrix = vec![vec![0.0; unknown_count]; unknown_count];
    let mut rhs = vec![0.0; unknown_count];

    for component in components {
        match component {
            Component::Resistor {
                positive,
                negative,
                resistance_ohms,
                ..
            } => stamp_conductance(
                &mut matrix,
                node_indices.get(positive).copied(),
                node_indices.get(negative).copied(),
                1.0 / resistance_ohms,
            ),
            Component::Capacitor { .. } => {}
            Component::Inductor {
                id,
                positive,
                negative,
                ..
            } => stamp_voltage_source(
                &mut matrix,
                &mut rhs,
                node_indices.get(positive).copied(),
                node_indices.get(negative).copied(),
                branch_indices[id],
                0.0,
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
                    closed_resistance_ohms
                } else {
                    open_resistance_ohms
                };
                stamp_conductance(
                    &mut matrix,
                    node_indices.get(positive).copied(),
                    node_indices.get(negative).copied(),
                    1.0 / resistance,
                );
            }
            Component::Diode {
                anode,
                cathode,
                saturation_current_amps,
                emission_coefficient,
                thermal_voltage_volts,
                ..
            } => {
                let anode_index = node_indices.get(anode).copied();
                let cathode_index = node_indices.get(cathode).copied();
                let voltage = value_at(guess, anode_index) - value_at(guess, cathode_index);
                let (conductance, equivalent_current) = diode_linearization(
                    voltage,
                    *saturation_current_amps,
                    *emission_coefficient,
                    *thermal_voltage_volts,
                );
                stamp_conductance(&mut matrix, anode_index, cathode_index, conductance);
                stamp_current_source(&mut rhs, anode_index, cathode_index, equivalent_current);
            }
            Component::BipolarNpn {
                base,
                collector,
                emitter,
                saturation_current_amps,
                forward_beta,
                emission_coefficient,
                thermal_voltage_volts,
                ..
            } => {
                let base_index = node_indices.get(base).copied();
                let collector_index = node_indices.get(collector).copied();
                let emitter_index = node_indices.get(emitter).copied();
                let base_emitter_voltage =
                    value_at(guess, base_index) - value_at(guess, emitter_index);
                let (base_conductance, base_equivalent_current) = diode_linearization(
                    base_emitter_voltage,
                    *saturation_current_amps,
                    *emission_coefficient,
                    *thermal_voltage_volts,
                );
                stamp_conductance(&mut matrix, base_index, emitter_index, base_conductance);
                stamp_current_source(&mut rhs, base_index, emitter_index, base_equivalent_current);
                stamp_voltage_controlled_current_source(
                    &mut matrix,
                    &mut rhs,
                    collector_index,
                    emitter_index,
                    base_index,
                    emitter_index,
                    *forward_beta * base_conductance,
                    *forward_beta * base_equivalent_current,
                );

                let base_collector_voltage =
                    value_at(guess, base_index) - value_at(guess, collector_index);
                let (reverse_conductance, reverse_equivalent_current) = diode_linearization(
                    base_collector_voltage,
                    npn_reverse_saturation(*saturation_current_amps, *forward_beta),
                    *emission_coefficient,
                    *thermal_voltage_volts,
                );
                stamp_conductance(
                    &mut matrix,
                    base_index,
                    collector_index,
                    reverse_conductance,
                );
                stamp_current_source(
                    &mut rhs,
                    base_index,
                    collector_index,
                    reverse_equivalent_current,
                );
                stamp_voltage_controlled_current_source(
                    &mut matrix,
                    &mut rhs,
                    emitter_index,
                    collector_index,
                    base_index,
                    collector_index,
                    NPN_REVERSE_BETA * reverse_conductance,
                    NPN_REVERSE_BETA * reverse_equivalent_current,
                );
            }
            Component::CurrentSource {
                positive,
                negative,
                current_amps,
                ..
            } => stamp_current_source(
                &mut rhs,
                node_indices.get(positive).copied(),
                node_indices.get(negative).copied(),
                *current_amps,
            ),
            Component::VoltageSource {
                id,
                positive,
                negative,
                voltage_volts,
            } => stamp_voltage_source(
                &mut matrix,
                &mut rhs,
                node_indices.get(positive).copied(),
                node_indices.get(negative).copied(),
                branch_indices[id],
                *voltage_volts,
            ),
        }
    }

    (matrix, rhs)
}

fn value_at(values: &[f64], index: Option<usize>) -> f64 {
    index.map(|index| values[index]).unwrap_or(0.0)
}

fn diode_linearization(voltage: f64, saturation: f64, emission: f64, thermal: f64) -> (f64, f64) {
    let exponent = (voltage / (emission * thermal)).clamp(MIN_EXPONENT, MAX_EXPONENT);
    let exponential = exponent.exp();
    let current = saturation * (exponential - 1.0);
    let conductance = saturation * exponential / (emission * thermal);
    (conductance, current - conductance * voltage)
}

fn diode_current(voltage: f64, saturation: f64, emission: f64, thermal: f64) -> f64 {
    let exponent = (voltage / (emission * thermal)).clamp(MIN_EXPONENT, MAX_EXPONENT);
    saturation * (exponent.exp() - 1.0)
}

fn npn_reverse_saturation(saturation: f64, forward_beta: f64) -> f64 {
    saturation * forward_beta / NPN_REVERSE_BETA
}

fn has_converged(previous: &[f64], next: &[f64]) -> bool {
    previous.iter().zip(next).all(|(previous, next)| {
        let tolerance = ABSOLUTE_TOLERANCE + RELATIVE_TOLERANCE * previous.abs().max(next.abs());
        (next - previous).abs() <= tolerance
    })
}

fn nonlinear_voltage_indices(
    components: &[&Component],
    node_indices: &BTreeMap<NodeId, usize>,
) -> BTreeSet<usize> {
    let mut indices = BTreeSet::new();
    for component in components {
        let nonlinear_nodes: &[&NodeId] = match component {
            Component::Diode { anode, cathode, .. } => &[anode, cathode],
            Component::BipolarNpn {
                base,
                collector,
                emitter,
                ..
            } => &[base, collector, emitter],
            _ => &[],
        };
        for node in nonlinear_nodes {
            if let Some(index) = node_indices.get(*node) {
                indices.insert(*index);
            }
        }
    }
    indices
}

fn damp_voltage_update(
    guess: &mut [f64],
    candidate: &[f64],
    limited_voltage_indices: &BTreeSet<usize>,
) {
    for (index, (previous, next)) in guess.iter_mut().zip(candidate).enumerate() {
        let step = *next - *previous;
        *previous += if limited_voltage_indices.contains(&index) {
            step.clamp(-MAX_NEWTON_VOLTAGE_STEP, MAX_NEWTON_VOLTAGE_STEP)
        } else {
            step
        };
    }
}

pub(crate) fn validate(circuit: &Circuit) -> Result<(), SimulationError> {
    if circuit.reference.0.is_empty() {
        return Err(SimulationError::EmptyReference);
    }

    let mut component_ids = BTreeSet::new();
    for component in &circuit.components {
        let id = component.id();
        if id.0.is_empty() {
            return Err(SimulationError::EmptyComponentId(id.clone()));
        }
        if !component_ids.insert(id.clone()) {
            return Err(SimulationError::DuplicateComponentId(id.clone()));
        }
        if component.nodes().iter().any(|node| node.0.is_empty()) {
            return Err(SimulationError::EmptyNodeId {
                component: id.clone(),
            });
        }
        match component {
            Component::Resistor {
                resistance_ohms, ..
            } => {
                ensure_finite(id, "resistance", *resistance_ohms)?;
                if *resistance_ohms <= 0.0 {
                    return Err(SimulationError::InvalidResistance {
                        component: id.clone(),
                    });
                }
            }
            Component::Capacitor {
                capacitance_farads, ..
            } => {
                ensure_finite(id, "capacitance", *capacitance_farads)?;
                if *capacitance_farads <= 0.0 {
                    return Err(SimulationError::InvalidCapacitance {
                        component: id.clone(),
                    });
                }
            }
            Component::Inductor {
                inductance_henries, ..
            } => {
                ensure_finite(id, "inductance", *inductance_henries)?;
                if *inductance_henries <= 0.0 {
                    return Err(SimulationError::InvalidInductance {
                        component: id.clone(),
                    });
                }
            }
            Component::Switch {
                closed_resistance_ohms,
                open_resistance_ohms,
                ..
            } => {
                ensure_finite(id, "closed resistance", *closed_resistance_ohms)?;
                ensure_finite(id, "open resistance", *open_resistance_ohms)?;
                if *closed_resistance_ohms <= 0.0 || *open_resistance_ohms <= 0.0 {
                    return Err(SimulationError::InvalidSwitchResistance {
                        component: id.clone(),
                    });
                }
            }
            Component::Diode {
                saturation_current_amps,
                emission_coefficient,
                thermal_voltage_volts,
                ..
            } => {
                ensure_finite(id, "saturation current", *saturation_current_amps)?;
                ensure_finite(id, "emission coefficient", *emission_coefficient)?;
                ensure_finite(id, "thermal voltage", *thermal_voltage_volts)?;
                if *saturation_current_amps <= 0.0
                    || *emission_coefficient <= 0.0
                    || *thermal_voltage_volts <= 0.0
                {
                    return Err(SimulationError::InvalidDiodeModel {
                        component: id.clone(),
                    });
                }
            }
            Component::BipolarNpn {
                saturation_current_amps,
                forward_beta,
                emission_coefficient,
                thermal_voltage_volts,
                ..
            } => {
                ensure_finite(id, "saturation current", *saturation_current_amps)?;
                ensure_finite(id, "forward beta", *forward_beta)?;
                ensure_finite(id, "emission coefficient", *emission_coefficient)?;
                ensure_finite(id, "thermal voltage", *thermal_voltage_volts)?;
                if *saturation_current_amps <= 0.0
                    || *forward_beta <= 0.0
                    || *emission_coefficient <= 0.0
                    || *thermal_voltage_volts <= 0.0
                {
                    return Err(SimulationError::InvalidBipolarModel {
                        component: id.clone(),
                    });
                }
            }
            Component::CurrentSource { current_amps, .. } => {
                ensure_finite(id, "current", *current_amps)?;
            }
            Component::VoltageSource { voltage_volts, .. } => {
                ensure_finite(id, "voltage", *voltage_volts)?;
            }
        }
    }
    Ok(())
}

fn stamp_current_source(
    rhs: &mut [f64],
    positive: Option<usize>,
    negative: Option<usize>,
    current: f64,
) {
    if let Some(index) = positive {
        rhs[index] -= current;
    }
    if let Some(index) = negative {
        rhs[index] += current;
    }
}

fn stamp_voltage_controlled_current_source(
    matrix: &mut [Vec<f64>],
    rhs: &mut [f64],
    positive: Option<usize>,
    negative: Option<usize>,
    control_positive: Option<usize>,
    control_negative: Option<usize>,
    transconductance: f64,
    equivalent_current: f64,
) {
    if let Some(row) = positive {
        if let Some(column) = control_positive {
            matrix[row][column] += transconductance;
        }
        if let Some(column) = control_negative {
            matrix[row][column] -= transconductance;
        }
        rhs[row] -= equivalent_current;
    }
    if let Some(row) = negative {
        if let Some(column) = control_positive {
            matrix[row][column] -= transconductance;
        }
        if let Some(column) = control_negative {
            matrix[row][column] += transconductance;
        }
        rhs[row] += equivalent_current;
    }
}

fn ensure_finite(
    component: &ComponentId,
    field: &'static str,
    value: f64,
) -> Result<(), SimulationError> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(SimulationError::NonFiniteValue {
            component: component.clone(),
            field,
        })
    }
}

fn stamp_conductance(
    matrix: &mut [Vec<f64>],
    positive: Option<usize>,
    negative: Option<usize>,
    conductance: f64,
) {
    if let Some(index) = positive {
        matrix[index][index] += conductance;
    }
    if let Some(index) = negative {
        matrix[index][index] += conductance;
    }
    if let (Some(positive), Some(negative)) = (positive, negative) {
        matrix[positive][negative] -= conductance;
        matrix[negative][positive] -= conductance;
    }
}

fn stamp_voltage_source(
    matrix: &mut [Vec<f64>],
    rhs: &mut [f64],
    positive: Option<usize>,
    negative: Option<usize>,
    source_index: usize,
    voltage: f64,
) {
    if let Some(index) = positive {
        matrix[index][source_index] += 1.0;
        matrix[source_index][index] += 1.0;
    }
    if let Some(index) = negative {
        matrix[index][source_index] -= 1.0;
        matrix[source_index][index] -= 1.0;
    }
    rhs[source_index] += voltage;
}

fn solve_linear_system(
    mut matrix: Vec<Vec<f64>>,
    mut rhs: Vec<f64>,
    should_cancel: &mut impl FnMut() -> bool,
    started_at: Instant,
    limits: DcSolveLimits,
) -> Result<Vec<f64>, SimulationError> {
    let size = rhs.len();
    for column in 0..size {
        check_execution_control(should_cancel, started_at, limits)?;
        let pivot = (column..size)
            .max_by(|left, right| {
                matrix[*left][column]
                    .abs()
                    .total_cmp(&matrix[*right][column].abs())
            })
            .expect("a non-empty pivot range");
        if matrix[pivot][column] == 0.0 || !matrix[pivot][column].is_finite() {
            return Err(SimulationError::SingularSystem { index: column });
        }
        matrix.swap(column, pivot);
        rhs.swap(column, pivot);

        for row in (column + 1)..size {
            let factor = matrix[row][column] / matrix[column][column];
            matrix[row][column] = 0.0;
            for next_column in (column + 1)..size {
                matrix[row][next_column] -= factor * matrix[column][next_column];
            }
            rhs[row] -= factor * rhs[column];
        }
    }

    let mut solution = vec![0.0; size];
    for row in (0..size).rev() {
        check_execution_control(should_cancel, started_at, limits)?;
        let remainder: f64 = ((row + 1)..size)
            .map(|column| matrix[row][column] * solution[column])
            .sum();
        solution[row] = (rhs[row] - remainder) / matrix[row][row];
    }
    Ok(solution)
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

    fn assert_close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1.0e-9, "{actual} != {expected}");
    }

    #[test]
    fn cancellation_is_checked_before_and_during_dense_solving() {
        let empty = Circuit {
            reference: node("0"),
            components: vec![],
        };
        assert_eq!(
            solve_dc_with_control(&empty, || true),
            Err(SimulationError::Cancelled)
        );

        let circuit = Circuit {
            reference: node("0"),
            components: (0..64)
                .map(|index| Component::Resistor {
                    id: component(&format!("R{index:02}")),
                    positive: node(&format!("n{index:02}")),
                    negative: node("0"),
                    resistance_ohms: 1_000.0 + index as f64,
                })
                .collect(),
        };
        let mut checks = 0;
        assert_eq!(
            solve_dc_with_control(&circuit, || {
                checks += 1;
                checks > 8
            }),
            Err(SimulationError::Cancelled)
        );
        assert!(checks > 8);
    }

    #[test]
    fn execution_limits_reject_expired_and_oversized_dc_jobs() {
        let circuit = Circuit {
            reference: node("0"),
            components: vec![Component::Resistor {
                id: component("R1"),
                positive: node("out"),
                negative: node("0"),
                resistance_ohms: 1_000.0,
            }],
        };

        assert_eq!(
            solve_dc_with_limits(
                &circuit,
                DcSolveLimits {
                    max_unknowns: 0,
                    ..DcSolveLimits::default()
                },
                || false,
            ),
            Err(SimulationError::DenseSolverSizeLimitExceeded {
                unknowns: 1,
                max_unknowns: 0,
            })
        );
        assert_eq!(
            solve_dc_with_limits(
                &circuit,
                DcSolveLimits {
                    max_duration: Duration::ZERO,
                    ..DcSolveLimits::default()
                },
                || false,
            ),
            Err(SimulationError::TimeLimitExceeded { limit_millis: 0 })
        );
        assert_eq!(
            solve_dc_with_limits(
                &circuit,
                DcSolveLimits {
                    max_matrix_bytes: 79,
                    ..DcSolveLimits::default()
                },
                || false,
            ),
            Err(SimulationError::MatrixMemoryLimitExceeded {
                unknowns: 1,
                required_bytes: 80,
                max_bytes: 79,
            })
        );
    }

    #[test]
    fn representative_ladder_system_demonstrates_sparse_backend_value() {
        const NODE_COUNT: usize = 256;
        let components = (0..NODE_COUNT)
            .map(|index| Component::Resistor {
                id: component(&format!("R{index}")),
                positive: node(&format!("n{index}")),
                negative: if index == 0 {
                    node("0")
                } else {
                    node(&format!("n{}", index - 1))
                },
                resistance_ohms: 1_000.0,
            })
            .collect::<Vec<_>>();
        let component_refs = components.iter().collect::<Vec<_>>();
        let node_indices = (0..NODE_COUNT)
            .map(|index| (node(&format!("n{index}")), index))
            .collect::<BTreeMap<_, _>>();
        let (matrix, _) = assemble_system(
            &component_refs,
            &node_indices,
            &BTreeMap::new(),
            &vec![0.0; NODE_COUNT],
            NODE_COUNT,
        );
        let nonzero_entries = matrix
            .iter()
            .flatten()
            .filter(|value| **value != 0.0)
            .count();

        assert_eq!(nonzero_entries, NODE_COUNT * 3 - 2);
        assert!(nonzero_entries * 100 < NODE_COUNT * NODE_COUNT * 2);
    }

    #[test]
    fn solves_a_voltage_divider_and_branch_currents() {
        let circuit = Circuit {
            reference: node("0"),
            components: vec![
                Component::VoltageSource {
                    id: component("V1"),
                    positive: node("vin"),
                    negative: node("0"),
                    voltage_volts: 10.0,
                },
                Component::Resistor {
                    id: component("R1"),
                    positive: node("vin"),
                    negative: node("vout"),
                    resistance_ohms: 1_000.0,
                },
                Component::Resistor {
                    id: component("R2"),
                    positive: node("vout"),
                    negative: node("0"),
                    resistance_ohms: 1_000.0,
                },
            ],
        };

        let result = solve_dc(&circuit).unwrap();
        assert_close(result.node_voltages[&node("vin")], 10.0);
        assert_close(result.node_voltages[&node("vout")], 5.0);
        assert_close(result.component_currents[&component("R1")], 0.005);
        assert_close(result.component_currents[&component("R2")], 0.005);
        assert_close(result.component_currents[&component("V1")], -0.005);
        assert_close(result.component_powers[&component("R1")], 0.025);
        assert_close(result.component_powers[&component("R2")], 0.025);
        assert_close(result.component_powers[&component("V1")], -0.05);
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn solves_a_balanced_wheatstone_bridge_against_the_analytic_midpoint() {
        let circuit = Circuit {
            reference: node("0"),
            components: vec![
                Component::VoltageSource {
                    id: component("V1"),
                    positive: node("vin"),
                    negative: node("0"),
                    voltage_volts: 10.0,
                },
                Component::Resistor {
                    id: component("R1"),
                    positive: node("vin"),
                    negative: node("left"),
                    resistance_ohms: 1_000.0,
                },
                Component::Resistor {
                    id: component("R2"),
                    positive: node("left"),
                    negative: node("0"),
                    resistance_ohms: 1_000.0,
                },
                Component::Resistor {
                    id: component("R3"),
                    positive: node("vin"),
                    negative: node("right"),
                    resistance_ohms: 2_000.0,
                },
                Component::Resistor {
                    id: component("R4"),
                    positive: node("right"),
                    negative: node("0"),
                    resistance_ohms: 2_000.0,
                },
                Component::Resistor {
                    id: component("RB"),
                    positive: node("left"),
                    negative: node("right"),
                    resistance_ohms: 10_000.0,
                },
            ],
        };

        let result = solve_dc(&circuit).unwrap();
        assert_close(result.node_voltages[&node("left")], 5.0);
        assert_close(result.node_voltages[&node("right")], 5.0);
        assert!(result.component_currents[&component("RB")].abs() < 1.0e-12);
        assert_eq!(result.iterations, 1);
    }

    #[test]
    fn solves_a_current_source() {
        let circuit = Circuit {
            reference: node("ground"),
            components: vec![
                Component::CurrentSource {
                    id: component("I1"),
                    positive: node("ground"),
                    negative: node("out"),
                    current_amps: 0.002,
                },
                Component::Resistor {
                    id: component("R1"),
                    positive: node("out"),
                    negative: node("ground"),
                    resistance_ohms: 2_000.0,
                },
            ],
        };

        let result = solve_dc(&circuit).unwrap();
        assert_close(result.node_voltages[&node("out")], 4.0);
        assert_close(result.component_currents[&component("I1")], 0.002);
        assert_close(result.component_currents[&component("R1")], 0.002);
    }

    #[test]
    fn results_are_stable_when_components_are_reordered() {
        let components = vec![
            Component::VoltageSource {
                id: component("source"),
                positive: node("z"),
                negative: node("0"),
                voltage_volts: 6.0,
            },
            Component::Resistor {
                id: component("first"),
                positive: node("z"),
                negative: node("a"),
                resistance_ohms: 2_000.0,
            },
            Component::Resistor {
                id: component("second"),
                positive: node("a"),
                negative: node("0"),
                resistance_ohms: 1_000.0,
            },
        ];
        let mut reversed = components.clone();
        reversed.reverse();

        let first = solve_dc(&Circuit {
            reference: node("0"),
            components,
        })
        .unwrap();
        let second = solve_dc(&Circuit {
            reference: node("0"),
            components: reversed,
        })
        .unwrap();

        assert_eq!(first, second);
    }

    #[test]
    fn rejects_duplicate_and_invalid_components() {
        let duplicate = Circuit {
            reference: node("0"),
            components: vec![
                Component::Resistor {
                    id: component("R1"),
                    positive: node("a"),
                    negative: node("0"),
                    resistance_ohms: 100.0,
                },
                Component::CurrentSource {
                    id: component("R1"),
                    positive: node("0"),
                    negative: node("a"),
                    current_amps: 1.0,
                },
            ],
        };
        assert_eq!(
            solve_dc(&duplicate),
            Err(SimulationError::DuplicateComponentId(component("R1")))
        );

        let invalid = Circuit {
            reference: node("0"),
            components: vec![Component::Resistor {
                id: component("R1"),
                positive: node("a"),
                negative: node("0"),
                resistance_ohms: 0.0,
            }],
        };
        assert_eq!(
            solve_dc(&invalid),
            Err(SimulationError::InvalidResistance {
                component: component("R1")
            })
        );
    }

    #[test]
    fn reports_a_floating_system() {
        let circuit = Circuit {
            reference: node("0"),
            components: vec![Component::Resistor {
                id: component("R1"),
                positive: node("a"),
                negative: node("b"),
                resistance_ohms: 100.0,
            }],
        };

        assert!(matches!(
            solve_dc(&circuit),
            Err(SimulationError::SingularSystem { .. })
        ));
    }

    #[test]
    fn does_not_treat_a_high_resistance_as_a_singular_circuit() {
        let circuit = Circuit {
            reference: node("0"),
            components: vec![
                Component::VoltageSource {
                    id: component("V1"),
                    positive: node("out"),
                    negative: node("0"),
                    voltage_volts: 1.0,
                },
                Component::Resistor {
                    id: component("R1"),
                    positive: node("out"),
                    negative: node("0"),
                    resistance_ohms: 1.0e15,
                },
            ],
        };

        let result = solve_dc(&circuit).unwrap();
        assert_close(result.node_voltages[&node("out")], 1.0);
        assert_close(result.component_currents[&component("R1")], 1.0e-15);
    }

    #[test]
    fn solves_a_diode_bias_point_with_damped_newton_iteration() {
        let circuit = Circuit {
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
                Component::Diode {
                    id: component("D1"),
                    anode: node("out"),
                    cathode: node("0"),
                    saturation_current_amps: 1.0e-12,
                    emission_coefficient: 1.0,
                    thermal_voltage_volts: 0.025_852,
                },
            ],
        };

        let result = solve_dc(&circuit).unwrap();
        let output = result.node_voltages[&node("out")];
        let diode_current = result.component_currents[&component("D1")];
        assert!(
            (0.55..0.65).contains(&output),
            "unexpected diode voltage {output}"
        );
        assert!(
            (0.004..0.0045).contains(&diode_current),
            "unexpected diode current {diode_current}"
        );
        assert!(result.iterations > 1);
    }

    #[test]
    fn converges_a_high_dynamic_range_resistor_limited_diode_bias() {
        let circuit = Circuit {
            reference: node("0"),
            components: vec![
                Component::VoltageSource {
                    id: component("V1"),
                    positive: node("vin"),
                    negative: node("0"),
                    voltage_volts: 100.0,
                },
                Component::Resistor {
                    id: component("R1"),
                    positive: node("vin"),
                    negative: node("out"),
                    resistance_ohms: 1_000_000.0,
                },
                Component::Diode {
                    id: component("D1"),
                    anode: node("out"),
                    cathode: node("0"),
                    saturation_current_amps: 1.0e-12,
                    emission_coefficient: 1.0,
                    thermal_voltage_volts: 0.025_852,
                },
            ],
        };

        let result = solve_dc(&circuit).unwrap();
        let output = result.node_voltages[&node("out")];
        let current = result.component_currents[&component("D1")];
        assert!(
            (0.45..0.52).contains(&output),
            "unexpected diode voltage {output}"
        );
        assert!(
            (99.0e-6..100.0e-6).contains(&current),
            "unexpected diode current {current}"
        );
        assert!(
            result.iterations < 20,
            "unexpected iteration count {}",
            result.iterations
        );
    }

    #[test]
    fn solves_the_builtin_led_parameterization_with_current_limiting() {
        let circuit = Circuit {
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
                Component::Diode {
                    id: component("LED1"),
                    anode: node("out"),
                    cathode: node("0"),
                    saturation_current_amps: 1.0e-18,
                    emission_coefficient: 2.0,
                    thermal_voltage_volts: 0.025_852,
                },
            ],
        };

        let result = solve_dc(&circuit).unwrap();
        let output = result.node_voltages[&node("out")];
        let led_current = result.component_currents[&component("LED1")];
        assert!(
            (1.8..1.9).contains(&output),
            "unexpected LED voltage {output}"
        );
        assert!(
            (0.003..0.0033).contains(&led_current),
            "unexpected LED current {led_current}"
        );
    }

    #[test]
    fn applies_dc_models_for_capacitors_inductors_and_switches() {
        let circuit = Circuit {
            reference: node("0"),
            components: vec![
                Component::VoltageSource {
                    id: component("V1"),
                    positive: node("vin"),
                    negative: node("0"),
                    voltage_volts: 2.0,
                },
                Component::Switch {
                    id: component("S1"),
                    positive: node("vin"),
                    negative: node("mid"),
                    closed: true,
                    closed_resistance_ohms: 1.0e-3,
                    open_resistance_ohms: 1.0e12,
                },
                Component::Inductor {
                    id: component("L1"),
                    positive: node("mid"),
                    negative: node("out"),
                    inductance_henries: 1.0e-3,
                },
                Component::Resistor {
                    id: component("R1"),
                    positive: node("out"),
                    negative: node("0"),
                    resistance_ohms: 1_000.0,
                },
                Component::Capacitor {
                    id: component("C1"),
                    positive: node("out"),
                    negative: node("0"),
                    capacitance_farads: 1.0e-6,
                },
            ],
        };

        let result = solve_dc(&circuit).unwrap();
        assert!((result.node_voltages[&node("out")] - 2.0).abs() < 1.0e-5);
        assert!((result.component_currents[&component("L1")] - 0.002).abs() < 1.0e-8);
        assert_eq!(result.component_currents[&component("C1")], 0.0);
        assert_eq!(result.iterations, 1);

        let mut open = circuit;
        let Component::Switch { closed, .. } = &mut open.components[1] else {
            unreachable!();
        };
        *closed = false;
        let open_result = solve_dc(&open).unwrap();
        assert!(open_result.component_currents[&component("S1")].abs() < 1.0e-10);
    }

    #[test]
    fn solves_a_forward_active_npn_common_emitter_stage() {
        let circuit = Circuit {
            reference: node("0"),
            components: vec![
                Component::VoltageSource {
                    id: component("VCC"),
                    positive: node("vcc"),
                    negative: node("0"),
                    voltage_volts: 5.0,
                },
                Component::VoltageSource {
                    id: component("VB"),
                    positive: node("base"),
                    negative: node("0"),
                    voltage_volts: 0.6,
                },
                Component::Resistor {
                    id: component("RC"),
                    positive: node("vcc"),
                    negative: node("collector"),
                    resistance_ohms: 1_000.0,
                },
                Component::BipolarNpn {
                    id: component("Q1"),
                    base: node("base"),
                    collector: node("collector"),
                    emitter: node("0"),
                    saturation_current_amps: 1.0e-15,
                    forward_beta: 100.0,
                    emission_coefficient: 1.0,
                    thermal_voltage_volts: 0.025_852,
                },
            ],
        };

        let result = solve_dc(&circuit).unwrap();
        let collector_current = result.component_currents[&component("Q1")];
        assert!(
            (0.0011..0.0013).contains(&collector_current),
            "unexpected collector current {collector_current}"
        );
        assert!(
            (3.7..3.9).contains(&result.node_voltages[&node("collector")]),
            "unexpected collector voltage {}",
            result.node_voltages[&node("collector")]
        );
        assert!(result.iterations > 1);
        assert!(result.diagnostics.is_empty());
        assert!(result.component_powers[&component("Q1")] > 0.0);
    }

    #[test]
    fn solves_a_strongly_driven_npn_in_saturation_without_negative_collector_voltage() {
        let circuit = Circuit {
            reference: node("0"),
            components: vec![
                Component::VoltageSource {
                    id: component("VCC"),
                    positive: node("vcc"),
                    negative: node("0"),
                    voltage_volts: 5.0,
                },
                Component::VoltageSource {
                    id: component("VB"),
                    positive: node("base"),
                    negative: node("0"),
                    voltage_volts: 0.72,
                },
                Component::Resistor {
                    id: component("RC"),
                    positive: node("vcc"),
                    negative: node("collector"),
                    resistance_ohms: 1_000.0,
                },
                Component::BipolarNpn {
                    id: component("Q1"),
                    base: node("base"),
                    collector: node("collector"),
                    emitter: node("0"),
                    saturation_current_amps: 1.0e-15,
                    forward_beta: 100.0,
                    emission_coefficient: 1.0,
                    thermal_voltage_volts: 0.025_852,
                },
            ],
        };

        let result = solve_dc(&circuit).unwrap();
        let collector_voltage = result.node_voltages[&node("collector")];
        let collector_current = result.component_currents[&component("Q1")];
        assert!(
            (0.0..0.15).contains(&collector_voltage),
            "unexpected saturated collector voltage {collector_voltage}"
        );
        assert!(
            (0.0048..0.0051).contains(&collector_current),
            "unexpected saturated collector current {collector_current}"
        );
        assert!(result.iterations > 10);
        assert!(result.diagnostics.is_empty());
    }

    #[test]
    fn warns_when_the_npn_enters_unsupported_reverse_active_operation() {
        let circuit = Circuit {
            reference: node("0"),
            components: vec![
                Component::VoltageSource {
                    id: component("VC"),
                    positive: node("collector"),
                    negative: node("0"),
                    voltage_volts: -0.2,
                },
                Component::VoltageSource {
                    id: component("VB"),
                    positive: node("base"),
                    negative: node("0"),
                    voltage_volts: 0.7,
                },
                Component::BipolarNpn {
                    id: component("Q1"),
                    base: node("base"),
                    collector: node("collector"),
                    emitter: node("0"),
                    saturation_current_amps: 1.0e-15,
                    forward_beta: 100.0,
                    emission_coefficient: 1.0,
                    thermal_voltage_volts: 0.025_852,
                },
            ],
        };

        let result = solve_dc(&circuit).unwrap();
        assert_eq!(result.diagnostics.len(), 1);
        assert!(matches!(
            result.diagnostics[0],
            DcDiagnostic::NpnOutsideForwardActive { ref component, .. }
                if component == &ComponentId::new("Q1")
        ));
    }
}
