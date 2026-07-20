use std::{
    collections::{BTreeMap, BTreeSet},
    f64::consts::TAU,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    solve_dc_with_limits, Circuit, Component, ComponentId, DcSolveLimits, NodeId, ProbeMap,
    ProbeTarget, SimulationError,
};

const DEFAULT_MAX_TRANSIENT_SAMPLES: usize = 4_096;
const DEFAULT_MAX_TRANSIENT_VALUES: usize = 1_048_576;
const DEFAULT_MAX_TRANSIENT_DURATION: Duration = Duration::from_secs(30);
const DEFAULT_TRANSIENT_RELATIVE_TOLERANCE: f64 = 1.0e-3;
const DEFAULT_TRANSIENT_ABSOLUTE_TOLERANCE: f64 = 1.0e-9;
const DEFAULT_MAX_STEP_REJECTIONS: usize = 12;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SourceWaveform {
    Dc,
    Pulse {
        low_value: f64,
        high_value: f64,
        delay_seconds: f64,
        rise_seconds: f64,
        fall_seconds: f64,
        pulse_width_seconds: f64,
        period_seconds: f64,
    },
    Sine {
        offset: f64,
        amplitude: f64,
        frequency_hertz: f64,
        phase_degrees: f64,
        delay_seconds: f64,
        damping_per_second: f64,
    },
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TransientOutput {
    NodeVoltage { node: NodeId },
    ComponentCurrent { component: ComponentId },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransientRequest {
    pub duration_seconds: f64,
    pub max_time_step_seconds: f64,
    pub source_waveforms: BTreeMap<ComponentId, SourceWaveform>,
    pub outputs: Vec<TransientOutput>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransientTrace {
    pub output: TransientOutput,
    pub values: Vec<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransientResult {
    pub time_seconds: Vec<f64>,
    pub traces: Vec<TransientTrace>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TransientLimits {
    pub max_samples: usize,
    pub max_result_values: usize,
    pub max_duration: Duration,
    pub relative_tolerance: f64,
    pub absolute_tolerance: f64,
    pub max_step_rejections: usize,
    pub dc: DcSolveLimits,
}

impl Default for TransientLimits {
    fn default() -> Self {
        Self {
            max_samples: DEFAULT_MAX_TRANSIENT_SAMPLES,
            max_result_values: DEFAULT_MAX_TRANSIENT_VALUES,
            max_duration: DEFAULT_MAX_TRANSIENT_DURATION,
            relative_tolerance: DEFAULT_TRANSIENT_RELATIVE_TOLERANCE,
            absolute_tolerance: DEFAULT_TRANSIENT_ABSOLUTE_TOLERANCE,
            max_step_rejections: DEFAULT_MAX_STEP_REJECTIONS,
            dc: DcSolveLimits::default(),
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
pub enum TransientError {
    #[error("transient duration and maximum timestep must be finite and greater than zero")]
    InvalidTimeRange {
        duration_seconds: f64,
        max_time_step_seconds: f64,
    },
    #[error("the transient analysis requests {sample_count} samples, exceeding the {max_samples} sample limit")]
    SampleLimitExceeded {
        sample_count: usize,
        max_samples: usize,
    },
    #[error("a transient analysis requires at least one output trace")]
    MissingOutputs,
    #[error("the transient output is duplicated")]
    DuplicateOutput { output: TransientOutput },
    #[error("transient voltage output node '{node}' does not exist")]
    UnknownNodeOutput { node: NodeId },
    #[error("transient current output component '{component}' does not exist")]
    UnknownComponentOutput { component: ComponentId },
    #[error("transient waveform source '{source_id}' does not exist")]
    UnknownWaveformSource { source_id: ComponentId },
    #[error("component '{source_id}' is not an independent voltage or current source")]
    UnsupportedWaveformSource { source_id: ComponentId },
    #[error("source '{source_id}' has an invalid {field} waveform value")]
    InvalidWaveform {
        source_id: ComponentId,
        field: &'static str,
    },
    #[error("the transient result requires {required_values} values, exceeding the {max_values} value limit")]
    ResultBufferLimitExceeded {
        required_values: usize,
        max_values: usize,
    },
    #[error("the transient analysis was cancelled")]
    Cancelled,
    #[error("the transient analysis exceeded its {limit_millis} ms execution limit")]
    TimeLimitExceeded { limit_millis: u64 },
    #[error("transient sample {sample_index} at {time_seconds} seconds failed: {error}")]
    SampleFailed {
        sample_index: usize,
        time_seconds: f64,
        error: SimulationError,
    },
}

#[derive(Clone, Copy, Debug)]
enum DynamicState {
    Capacitor { voltage: f64, current: f64 },
    Inductor { voltage: f64, current: f64 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum IntegrationMethod {
    BackwardEuler,
    Trapezoidal,
}

struct SampleCandidate {
    node_voltages: BTreeMap<NodeId, f64>,
    component_currents: BTreeMap<ComponentId, f64>,
    dynamic_states: BTreeMap<ComponentId, DynamicState>,
}

struct ValidatedTransient {
    initial_capacity: usize,
    max_samples: usize,
}

pub fn solve_transient(
    circuit: &Circuit,
    request: &TransientRequest,
) -> Result<TransientResult, TransientError> {
    solve_transient_with_control(circuit, request, TransientLimits::default(), || false)
}

pub fn transient_outputs_for_probes(probes: &[ProbeMap]) -> Vec<TransientOutput> {
    let mut seen = BTreeSet::new();
    probes
        .iter()
        .filter_map(|probe| {
            let output = match &probe.target {
                ProbeTarget::NodeVoltage { electrical_node } => TransientOutput::NodeVoltage {
                    node: electrical_node.clone(),
                },
                ProbeTarget::BranchCurrent { component } => TransientOutput::ComponentCurrent {
                    component: component.clone(),
                },
            };
            seen.insert(output.clone()).then_some(output)
        })
        .collect()
}

pub fn solve_transient_with_control(
    circuit: &Circuit,
    request: &TransientRequest,
    limits: TransientLimits,
    mut should_cancel: impl FnMut() -> bool,
) -> Result<TransientResult, TransientError> {
    let validated = validate_request(circuit, request, limits)?;
    let started_at = Instant::now();
    check_control(&mut should_cancel, started_at, limits.max_duration)?;
    let mut time_seconds = Vec::with_capacity(validated.initial_capacity);
    time_seconds.push(0.0);
    let mut traces = request
        .outputs
        .iter()
        .cloned()
        .map(|output| TransientTrace {
            output,
            values: Vec::with_capacity(validated.initial_capacity),
        })
        .collect::<Vec<_>>();

    let mut initial_circuit = circuit.clone();
    apply_waveforms(&mut initial_circuit, &request.source_waveforms, 0.0);
    let initial = solve_sample(
        &initial_circuit,
        0,
        0.0,
        started_at,
        limits,
        &mut should_cancel,
    )?;
    let mut dynamic_states =
        initial_dynamic_states(circuit, &initial.node_voltages, &initial.component_currents);
    append_outputs(
        &mut traces,
        &initial.node_voltages,
        &initial.component_currents,
    );

    let minimum_step = request.duration_seconds / (validated.max_samples - 1) as f64;
    let mut step_seconds = request.max_time_step_seconds.min(request.duration_seconds);
    let mut time = 0.0;
    while time < request.duration_seconds {
        check_control(&mut should_cancel, started_at, limits.max_duration)?;
        let remaining = request.duration_seconds - time;
        let mut attempted_step = step_seconds.min(remaining);
        if remaining > minimum_step {
            attempted_step = attempted_step.max(minimum_step);
        }
        let mut rejections = 0usize;
        let accepted = loop {
            let sample_index = time_seconds.len();
            let sample_time = if attempted_step >= remaining {
                request.duration_seconds
            } else {
                time + attempted_step
            };
            let backward_euler = solve_candidate(
                circuit,
                &request.source_waveforms,
                &dynamic_states,
                IntegrationMethod::BackwardEuler,
                attempted_step,
                sample_index,
                sample_time,
                started_at,
                limits,
                &mut should_cancel,
            );
            let backward_euler = match backward_euler {
                Ok(candidate) => candidate,
                Err(
                    error @ (TransientError::Cancelled | TransientError::TimeLimitExceeded { .. }),
                ) => {
                    return Err(error);
                }
                Err(_error)
                    if attempted_step > minimum_step && rejections < limits.max_step_rejections =>
                {
                    rejections += 1;
                    attempted_step = (attempted_step * 0.5).max(minimum_step);
                    continue;
                }
                Err(error) => return Err(error),
            };
            let trapezoidal = solve_candidate(
                circuit,
                &request.source_waveforms,
                &dynamic_states,
                IntegrationMethod::Trapezoidal,
                attempted_step,
                sample_index,
                sample_time,
                started_at,
                limits,
                &mut should_cancel,
            );
            let trapezoidal = match trapezoidal {
                Ok(candidate) => candidate,
                Err(
                    error @ (TransientError::Cancelled | TransientError::TimeLimitExceeded { .. }),
                ) => {
                    return Err(error);
                }
                Err(_) => break (backward_euler, true, 1.0),
            };
            let error_ratio = candidate_error_ratio(
                &backward_euler,
                &trapezoidal,
                limits.absolute_tolerance,
                limits.relative_tolerance,
            );
            let oscillating = trapezoidal_oscillates(
                &dynamic_states,
                &backward_euler.dynamic_states,
                &trapezoidal.dynamic_states,
                limits.absolute_tolerance,
            );
            if !oscillating && error_ratio <= 1.0 {
                break (trapezoidal, false, error_ratio);
            }
            if attempted_step > minimum_step && rejections < limits.max_step_rejections {
                rejections += 1;
                let factor = if error_ratio.is_finite() && error_ratio > 0.0 {
                    (0.9 / error_ratio.sqrt()).clamp(0.2, 0.5)
                } else {
                    0.5
                };
                attempted_step = (attempted_step * factor).max(minimum_step);
                continue;
            }
            break (backward_euler, true, error_ratio);
        };
        let (candidate, used_fallback, error_ratio) = accepted;
        time = if attempted_step >= remaining {
            request.duration_seconds
        } else {
            time + attempted_step
        };
        dynamic_states = candidate.dynamic_states;
        time_seconds.push(time);
        append_outputs(
            &mut traces,
            &candidate.node_voltages,
            &candidate.component_currents,
        );
        if time_seconds.len() >= validated.max_samples && time < request.duration_seconds {
            return Err(TransientError::SampleLimitExceeded {
                sample_count: time_seconds.len() + 1,
                max_samples: validated.max_samples,
            });
        }
        step_seconds = next_step_size(
            attempted_step,
            error_ratio,
            used_fallback,
            minimum_step,
            request.max_time_step_seconds,
        );
    }

    Ok(TransientResult {
        time_seconds,
        traces,
    })
}

fn validate_request(
    circuit: &Circuit,
    request: &TransientRequest,
    limits: TransientLimits,
) -> Result<ValidatedTransient, TransientError> {
    if !request.duration_seconds.is_finite()
        || request.duration_seconds <= 0.0
        || !request.max_time_step_seconds.is_finite()
        || request.max_time_step_seconds <= 0.0
    {
        return Err(TransientError::InvalidTimeRange {
            duration_seconds: request.duration_seconds,
            max_time_step_seconds: request.max_time_step_seconds,
        });
    }
    let intervals = (request.duration_seconds / request.max_time_step_seconds).ceil();
    let sample_count = if intervals >= (usize::MAX - 1) as f64 {
        usize::MAX
    } else {
        intervals as usize + 1
    };
    if sample_count > limits.max_samples {
        return Err(TransientError::SampleLimitExceeded {
            sample_count,
            max_samples: limits.max_samples,
        });
    }
    if request.outputs.is_empty() {
        return Err(TransientError::MissingOutputs);
    }
    let required_values = request
        .outputs
        .len()
        .checked_add(1)
        .and_then(|count| count.checked_mul(sample_count))
        .unwrap_or(usize::MAX);
    if required_values > limits.max_result_values {
        return Err(TransientError::ResultBufferLimitExceeded {
            required_values,
            max_values: limits.max_result_values,
        });
    }

    let nodes = circuit
        .components
        .iter()
        .flat_map(Component::nodes)
        .cloned()
        .chain(std::iter::once(circuit.reference.clone()))
        .collect::<BTreeSet<_>>();
    let components = circuit
        .components
        .iter()
        .map(|component| (component.id().clone(), component))
        .collect::<BTreeMap<_, _>>();
    let mut outputs = BTreeSet::new();
    for output in &request.outputs {
        if !outputs.insert(output.clone()) {
            return Err(TransientError::DuplicateOutput {
                output: output.clone(),
            });
        }
        match output {
            TransientOutput::NodeVoltage { node } if !nodes.contains(node) => {
                return Err(TransientError::UnknownNodeOutput { node: node.clone() });
            }
            TransientOutput::ComponentCurrent { component }
                if !components.contains_key(component) =>
            {
                return Err(TransientError::UnknownComponentOutput {
                    component: component.clone(),
                });
            }
            _ => {}
        }
    }
    for (source, waveform) in &request.source_waveforms {
        let component =
            components
                .get(source)
                .ok_or_else(|| TransientError::UnknownWaveformSource {
                    source_id: source.clone(),
                })?;
        if !matches!(
            component,
            Component::VoltageSource { .. } | Component::CurrentSource { .. }
        ) {
            return Err(TransientError::UnsupportedWaveformSource {
                source_id: source.clone(),
            });
        }
        validate_waveform(source, waveform)?;
    }
    let stored_series = request.outputs.len().checked_add(1).unwrap_or(usize::MAX);
    let max_samples_from_values = limits.max_result_values / stored_series;
    Ok(ValidatedTransient {
        initial_capacity: sample_count,
        max_samples: limits.max_samples.min(max_samples_from_values),
    })
}

fn validate_waveform(
    source: &ComponentId,
    waveform: &SourceWaveform,
) -> Result<(), TransientError> {
    let invalid = |field| TransientError::InvalidWaveform {
        source_id: source.clone(),
        field,
    };
    match waveform {
        SourceWaveform::Dc => Ok(()),
        SourceWaveform::Pulse {
            low_value,
            high_value,
            delay_seconds,
            rise_seconds,
            fall_seconds,
            pulse_width_seconds,
            period_seconds,
        } => {
            if !low_value.is_finite() || !high_value.is_finite() {
                return Err(invalid("level"));
            }
            if !delay_seconds.is_finite() || *delay_seconds < 0.0 {
                return Err(invalid("delaySeconds"));
            }
            if !rise_seconds.is_finite() || *rise_seconds < 0.0 {
                return Err(invalid("riseSeconds"));
            }
            if !fall_seconds.is_finite() || *fall_seconds < 0.0 {
                return Err(invalid("fallSeconds"));
            }
            if !pulse_width_seconds.is_finite() || *pulse_width_seconds <= 0.0 {
                return Err(invalid("pulseWidthSeconds"));
            }
            if !period_seconds.is_finite() || *period_seconds <= 0.0 {
                return Err(invalid("periodSeconds"));
            }
            if rise_seconds + pulse_width_seconds + fall_seconds > *period_seconds {
                return Err(invalid("periodSeconds"));
            }
            Ok(())
        }
        SourceWaveform::Sine {
            offset,
            amplitude,
            frequency_hertz,
            phase_degrees,
            delay_seconds,
            damping_per_second,
        } => {
            if !offset.is_finite() || !amplitude.is_finite() || !phase_degrees.is_finite() {
                return Err(invalid("amplitude"));
            }
            if !frequency_hertz.is_finite() || *frequency_hertz <= 0.0 {
                return Err(invalid("frequencyHertz"));
            }
            if !delay_seconds.is_finite() || *delay_seconds < 0.0 {
                return Err(invalid("delaySeconds"));
            }
            if !damping_per_second.is_finite() || *damping_per_second < 0.0 {
                return Err(invalid("dampingPerSecond"));
            }
            Ok(())
        }
    }
}

fn waveform_value(waveform: &SourceWaveform, base_value: f64, time: f64) -> f64 {
    match waveform {
        SourceWaveform::Dc => base_value,
        SourceWaveform::Pulse {
            low_value,
            high_value,
            delay_seconds,
            rise_seconds,
            fall_seconds,
            pulse_width_seconds,
            period_seconds,
        } => {
            if time < *delay_seconds {
                return *low_value;
            }
            let local = (time - delay_seconds) % period_seconds;
            if *rise_seconds > 0.0 && local < *rise_seconds {
                return low_value + (high_value - low_value) * local / rise_seconds;
            }
            if local < rise_seconds + pulse_width_seconds {
                return *high_value;
            }
            if *fall_seconds > 0.0 && local < rise_seconds + pulse_width_seconds + fall_seconds {
                let fraction = (local - rise_seconds - pulse_width_seconds) / fall_seconds;
                return high_value + (low_value - high_value) * fraction;
            }
            *low_value
        }
        SourceWaveform::Sine {
            offset,
            amplitude,
            frequency_hertz,
            phase_degrees,
            delay_seconds,
            damping_per_second,
        } => {
            if time < *delay_seconds {
                return *offset;
            }
            let local = time - delay_seconds;
            offset
                + amplitude
                    * (-damping_per_second * local).exp()
                    * (TAU * frequency_hertz * local + phase_degrees.to_radians()).sin()
        }
    }
}

fn apply_waveforms(
    circuit: &mut Circuit,
    waveforms: &BTreeMap<ComponentId, SourceWaveform>,
    time: f64,
) {
    for component in &mut circuit.components {
        let Some(waveform) = waveforms.get(component.id()) else {
            continue;
        };
        match component {
            Component::VoltageSource { voltage_volts, .. } => {
                *voltage_volts = waveform_value(waveform, *voltage_volts, time);
            }
            Component::CurrentSource { current_amps, .. } => {
                *current_amps = waveform_value(waveform, *current_amps, time);
            }
            _ => {}
        }
    }
}

fn initial_dynamic_states(
    circuit: &Circuit,
    node_voltages: &BTreeMap<NodeId, f64>,
    component_currents: &BTreeMap<ComponentId, f64>,
) -> BTreeMap<ComponentId, DynamicState> {
    let voltage = |positive: &NodeId, negative: &NodeId| {
        node_voltages.get(positive).copied().unwrap_or(0.0)
            - node_voltages.get(negative).copied().unwrap_or(0.0)
    };
    circuit
        .components
        .iter()
        .filter_map(|component| match component {
            Component::Capacitor {
                id,
                positive,
                negative,
                ..
            } => Some((
                id.clone(),
                DynamicState::Capacitor {
                    voltage: voltage(positive, negative),
                    current: component_currents.get(id).copied().unwrap_or(0.0),
                },
            )),
            Component::Inductor {
                id,
                positive,
                negative,
                ..
            } => Some((
                id.clone(),
                DynamicState::Inductor {
                    voltage: voltage(positive, negative),
                    current: component_currents[id],
                },
            )),
            _ => None,
        })
        .collect()
}

fn companion_circuit(
    circuit: &Circuit,
    states: &BTreeMap<ComponentId, DynamicState>,
    step_seconds: f64,
    method: IntegrationMethod,
) -> (Circuit, BTreeMap<ComponentId, f64>) {
    let mut used_ids = circuit
        .components
        .iter()
        .map(|component| component.id().clone())
        .collect::<BTreeSet<_>>();
    let mut components = Vec::with_capacity(circuit.components.len() * 2);
    let mut history_currents = BTreeMap::new();
    for component in &circuit.components {
        match component {
            Component::Capacitor {
                id,
                positive,
                negative,
                capacitance_farads,
            } => {
                let DynamicState::Capacitor { voltage, current } = states[id] else {
                    unreachable!()
                };
                let conductance = match method {
                    IntegrationMethod::BackwardEuler => capacitance_farads / step_seconds,
                    IntegrationMethod::Trapezoidal => 2.0 * capacitance_farads / step_seconds,
                };
                let history_current = match method {
                    IntegrationMethod::BackwardEuler => -conductance * voltage,
                    IntegrationMethod::Trapezoidal => -conductance * voltage - current,
                };
                components.push(Component::Resistor {
                    id: id.clone(),
                    positive: positive.clone(),
                    negative: negative.clone(),
                    resistance_ohms: 1.0 / conductance,
                });
                components.push(Component::CurrentSource {
                    id: companion_id(id, &mut used_ids),
                    positive: positive.clone(),
                    negative: negative.clone(),
                    current_amps: history_current,
                });
                history_currents.insert(id.clone(), history_current);
            }
            Component::Inductor {
                id,
                positive,
                negative,
                inductance_henries,
            } => {
                let DynamicState::Inductor { voltage, current } = states[id] else {
                    unreachable!()
                };
                let conductance = match method {
                    IntegrationMethod::BackwardEuler => step_seconds / inductance_henries,
                    IntegrationMethod::Trapezoidal => step_seconds / (2.0 * inductance_henries),
                };
                let history_current = match method {
                    IntegrationMethod::BackwardEuler => current,
                    IntegrationMethod::Trapezoidal => current + conductance * voltage,
                };
                components.push(Component::Resistor {
                    id: id.clone(),
                    positive: positive.clone(),
                    negative: negative.clone(),
                    resistance_ohms: 1.0 / conductance,
                });
                components.push(Component::CurrentSource {
                    id: companion_id(id, &mut used_ids),
                    positive: positive.clone(),
                    negative: negative.clone(),
                    current_amps: history_current,
                });
                history_currents.insert(id.clone(), history_current);
            }
            _ => components.push(component.clone()),
        }
    }
    (
        Circuit {
            reference: circuit.reference.clone(),
            components,
        },
        history_currents,
    )
}

fn companion_id(component: &ComponentId, used: &mut BTreeSet<ComponentId>) -> ComponentId {
    let mut suffix = 0usize;
    loop {
        let candidate = ComponentId::new(format!(
            "__collab_transient_history_{}_{}",
            component.0, suffix
        ));
        if used.insert(candidate.clone()) {
            return candidate;
        }
        suffix += 1;
    }
}

fn update_dynamic_states(
    circuit: &Circuit,
    node_voltages: &BTreeMap<NodeId, f64>,
    history_currents: &BTreeMap<ComponentId, f64>,
    component_currents: &mut BTreeMap<ComponentId, f64>,
) -> BTreeMap<ComponentId, DynamicState> {
    let mut states = BTreeMap::new();
    for component in &circuit.components {
        let (id, positive, negative) = match component {
            Component::Capacitor {
                id,
                positive,
                negative,
                ..
            }
            | Component::Inductor {
                id,
                positive,
                negative,
                ..
            } => (id, positive, negative),
            _ => continue,
        };
        let voltage = node_voltages.get(positive).copied().unwrap_or(0.0)
            - node_voltages.get(negative).copied().unwrap_or(0.0);
        let resistor_current = component_currents[id];
        let current = resistor_current + history_currents[id];
        match component {
            Component::Capacitor { .. } => {
                states.insert(id.clone(), DynamicState::Capacitor { voltage, current });
            }
            Component::Inductor { .. } => {
                states.insert(id.clone(), DynamicState::Inductor { voltage, current });
            }
            _ => unreachable!(),
        }
        component_currents.insert(id.clone(), current);
    }
    states
}

#[allow(clippy::too_many_arguments)]
fn solve_candidate(
    circuit: &Circuit,
    waveforms: &BTreeMap<ComponentId, SourceWaveform>,
    states: &BTreeMap<ComponentId, DynamicState>,
    method: IntegrationMethod,
    step_seconds: f64,
    sample_index: usize,
    time_seconds: f64,
    started_at: Instant,
    limits: TransientLimits,
    should_cancel: &mut impl FnMut() -> bool,
) -> Result<SampleCandidate, TransientError> {
    let (mut companion, history_currents) =
        companion_circuit(circuit, states, step_seconds, method);
    apply_waveforms(&mut companion, waveforms, time_seconds);
    let operating_point = solve_sample(
        &companion,
        sample_index,
        time_seconds,
        started_at,
        limits,
        should_cancel,
    )?;
    let mut component_currents = operating_point.component_currents;
    let dynamic_states = update_dynamic_states(
        circuit,
        &operating_point.node_voltages,
        &history_currents,
        &mut component_currents,
    );
    Ok(SampleCandidate {
        node_voltages: operating_point.node_voltages,
        component_currents,
        dynamic_states,
    })
}

fn candidate_error_ratio(
    backward_euler: &SampleCandidate,
    trapezoidal: &SampleCandidate,
    absolute_tolerance: f64,
    relative_tolerance: f64,
) -> f64 {
    backward_euler
        .dynamic_states
        .iter()
        .filter_map(|(id, backward_state)| {
            trapezoidal.dynamic_states.get(id).map(|trapezoidal_state| {
                dynamic_state_error_ratio(
                    *backward_state,
                    *trapezoidal_state,
                    absolute_tolerance,
                    relative_tolerance,
                )
            })
        })
        .fold(0.0, f64::max)
}

fn dynamic_state_error_ratio(
    backward_euler: DynamicState,
    trapezoidal: DynamicState,
    absolute_tolerance: f64,
    relative_tolerance: f64,
) -> f64 {
    let normalized = |backward: f64, trapezoidal: f64| {
        let scale = absolute_tolerance + relative_tolerance * backward.abs().max(trapezoidal.abs());
        (trapezoidal - backward).abs() / scale.max(f64::MIN_POSITIVE)
    };
    match (backward_euler, trapezoidal) {
        (
            DynamicState::Capacitor {
                voltage: backward_voltage,
                ..
            },
            DynamicState::Capacitor {
                voltage: trapezoidal_voltage,
                ..
            },
        ) => normalized(backward_voltage, trapezoidal_voltage),
        (
            DynamicState::Inductor {
                current: backward_current,
                ..
            },
            DynamicState::Inductor {
                current: trapezoidal_current,
                ..
            },
        ) => normalized(backward_current, trapezoidal_current),
        _ => f64::INFINITY,
    }
}

fn trapezoidal_oscillates(
    previous: &BTreeMap<ComponentId, DynamicState>,
    backward_euler: &BTreeMap<ComponentId, DynamicState>,
    trapezoidal: &BTreeMap<ComponentId, DynamicState>,
    absolute_tolerance: f64,
) -> bool {
    previous.iter().any(|(id, previous_state)| {
        let (Some(backward_state), Some(trapezoidal_state)) =
            (backward_euler.get(id), trapezoidal.get(id))
        else {
            return true;
        };
        dynamic_state_values(*previous_state)
            .into_iter()
            .zip(dynamic_state_values(*backward_state))
            .zip(dynamic_state_values(*trapezoidal_state))
            .any(|((previous, backward), trapezoidal)| {
                let backward_delta = backward - previous;
                let trapezoidal_delta = trapezoidal - previous;
                backward_delta * trapezoidal_delta < 0.0
                    && trapezoidal_delta.abs() > backward_delta.abs() * 1.25 + absolute_tolerance
            })
    })
}

fn dynamic_state_values(state: DynamicState) -> [f64; 2] {
    match state {
        DynamicState::Capacitor { voltage, current }
        | DynamicState::Inductor { voltage, current } => [voltage, current],
    }
}

fn next_step_size(
    accepted_step: f64,
    error_ratio: f64,
    used_fallback: bool,
    minimum_step: f64,
    maximum_step: f64,
) -> f64 {
    let factor = if used_fallback {
        0.5
    } else if error_ratio <= 0.0625 {
        2.0
    } else if error_ratio <= 0.25 {
        1.5
    } else {
        1.0
    };
    (accepted_step * factor).clamp(minimum_step, maximum_step)
}

fn append_outputs(
    traces: &mut [TransientTrace],
    node_voltages: &BTreeMap<NodeId, f64>,
    component_currents: &BTreeMap<ComponentId, f64>,
) {
    for trace in traces {
        trace.values.push(match &trace.output {
            TransientOutput::NodeVoltage { node } => node_voltages[node],
            TransientOutput::ComponentCurrent { component } => component_currents[component],
        });
    }
}

fn solve_sample(
    circuit: &Circuit,
    sample_index: usize,
    time_seconds: f64,
    started_at: Instant,
    limits: TransientLimits,
    should_cancel: &mut impl FnMut() -> bool,
) -> Result<crate::DcOperatingPoint, TransientError> {
    check_control(should_cancel, started_at, limits.max_duration)?;
    let remaining = limits.max_duration.saturating_sub(started_at.elapsed());
    let dc_limits = DcSolveLimits {
        max_duration: limits.dc.max_duration.min(remaining),
        ..limits.dc
    };
    solve_dc_with_limits(circuit, dc_limits, should_cancel).map_err(|error| match error {
        SimulationError::Cancelled => TransientError::Cancelled,
        error => TransientError::SampleFailed {
            sample_index,
            time_seconds,
            error,
        },
    })
}

fn check_control(
    should_cancel: &mut impl FnMut() -> bool,
    started_at: Instant,
    max_duration: Duration,
) -> Result<(), TransientError> {
    if should_cancel() {
        return Err(TransientError::Cancelled);
    }
    if started_at.elapsed() > max_duration {
        return Err(TransientError::TimeLimitExceeded {
            limit_millis: max_duration.as_millis() as u64,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delayed_step() -> SourceWaveform {
        SourceWaveform::Pulse {
            low_value: 0.0,
            high_value: 5.0,
            delay_seconds: 0.001,
            rise_seconds: 0.0,
            fall_seconds: 0.0,
            pulse_width_seconds: 0.008,
            period_seconds: 0.02,
        }
    }

    #[test]
    fn adaptive_trapezoidal_solver_charges_an_rc_network_without_skipping_the_endpoint() {
        let circuit = Circuit {
            reference: NodeId::new("gnd"),
            components: vec![
                Component::VoltageSource {
                    id: ComponentId::new("source"),
                    positive: NodeId::new("in"),
                    negative: NodeId::new("gnd"),
                    voltage_volts: 0.0,
                },
                Component::Resistor {
                    id: ComponentId::new("r"),
                    positive: NodeId::new("in"),
                    negative: NodeId::new("out"),
                    resistance_ohms: 1_000.0,
                },
                Component::Capacitor {
                    id: ComponentId::new("c"),
                    positive: NodeId::new("out"),
                    negative: NodeId::new("gnd"),
                    capacitance_farads: 1.0e-6,
                },
            ],
        };
        let result = solve_transient(
            &circuit,
            &TransientRequest {
                duration_seconds: 0.006,
                max_time_step_seconds: 0.001,
                source_waveforms: BTreeMap::from([(ComponentId::new("source"), delayed_step())]),
                outputs: vec![TransientOutput::NodeVoltage {
                    node: NodeId::new("out"),
                }],
            },
        )
        .unwrap();
        assert_eq!(result.time_seconds.first(), Some(&0.0));
        assert_eq!(result.time_seconds.last(), Some(&0.006));
        assert!(result.time_seconds.len() > 7);
        assert!(result.time_seconds.len() <= DEFAULT_MAX_TRANSIENT_SAMPLES);
        assert!(result
            .time_seconds
            .windows(2)
            .all(|pair| pair[1] > pair[0] && pair[1] - pair[0] <= 0.001));
        let values = &result.traces[0].values;
        assert_eq!(values[0], 0.0);
        assert!(values.windows(2).all(|pair| pair[1] >= pair[0]));
        assert!(values
            .last()
            .is_some_and(|value| *value > 4.9 && *value < 5.0));
    }

    #[test]
    fn adaptive_trapezoidal_solver_tracks_inductor_branch_current() {
        let circuit = Circuit {
            reference: NodeId::new("gnd"),
            components: vec![
                Component::VoltageSource {
                    id: ComponentId::new("source"),
                    positive: NodeId::new("in"),
                    negative: NodeId::new("gnd"),
                    voltage_volts: 0.0,
                },
                Component::Resistor {
                    id: ComponentId::new("r"),
                    positive: NodeId::new("in"),
                    negative: NodeId::new("out"),
                    resistance_ohms: 10.0,
                },
                Component::Inductor {
                    id: ComponentId::new("l"),
                    positive: NodeId::new("out"),
                    negative: NodeId::new("gnd"),
                    inductance_henries: 0.01,
                },
            ],
        };
        let result = solve_transient(
            &circuit,
            &TransientRequest {
                duration_seconds: 0.004,
                max_time_step_seconds: 0.001,
                source_waveforms: BTreeMap::from([(ComponentId::new("source"), delayed_step())]),
                outputs: vec![TransientOutput::ComponentCurrent {
                    component: ComponentId::new("l"),
                }],
            },
        )
        .unwrap();
        let values = &result.traces[0].values;
        assert_eq!(values[0], 0.0);
        assert!(values.windows(2).all(|pair| pair[1] >= pair[0]));
        assert!(values
            .last()
            .is_some_and(|value| *value > 0.47 && *value < 0.5));
    }

    #[test]
    fn trapezoidal_oscillation_detection_rejects_method_induced_reversal() {
        let id = ComponentId::new("capacitor");
        let previous = BTreeMap::from([(
            id.clone(),
            DynamicState::Capacitor {
                voltage: 1.0,
                current: 0.0,
            },
        )]);
        let backward_euler = BTreeMap::from([(
            id.clone(),
            DynamicState::Capacitor {
                voltage: 1.1,
                current: 0.0,
            },
        )]);
        let ringing = BTreeMap::from([(
            id,
            DynamicState::Capacitor {
                voltage: 0.8,
                current: 0.0,
            },
        )]);
        assert!(trapezoidal_oscillates(
            &previous,
            &backward_euler,
            &ringing,
            DEFAULT_TRANSIENT_ABSOLUTE_TOLERANCE,
        ));
    }

    #[test]
    fn fallback_reduces_the_next_step_without_crossing_explicit_bounds() {
        assert_eq!(next_step_size(0.01, 2.0, true, 0.001, 0.1), 0.005);
        assert_eq!(next_step_size(0.001, 2.0, true, 0.001, 0.1), 0.001);
        assert_eq!(next_step_size(0.08, 0.01, false, 0.001, 0.1), 0.1);
    }

    #[test]
    fn rejects_invalid_waveforms_and_sample_budgets() {
        let circuit = Circuit {
            reference: NodeId::new("gnd"),
            components: vec![Component::VoltageSource {
                id: ComponentId::new("source"),
                positive: NodeId::new("out"),
                negative: NodeId::new("gnd"),
                voltage_volts: 0.0,
            }],
        };
        let mut request = TransientRequest {
            duration_seconds: 1.0,
            max_time_step_seconds: 0.0001,
            source_waveforms: BTreeMap::new(),
            outputs: vec![TransientOutput::NodeVoltage {
                node: NodeId::new("out"),
            }],
        };
        assert!(matches!(
            solve_transient(&circuit, &request),
            Err(TransientError::SampleLimitExceeded { .. })
        ));
        request.max_time_step_seconds = 0.1;
        request.source_waveforms.insert(
            ComponentId::new("source"),
            SourceWaveform::Sine {
                offset: 0.0,
                amplitude: 1.0,
                frequency_hertz: 0.0,
                phase_degrees: 0.0,
                delay_seconds: 0.0,
                damping_per_second: 0.0,
            },
        );
        assert!(matches!(
            solve_transient(&circuit, &request),
            Err(TransientError::InvalidWaveform {
                field: "frequencyHertz",
                ..
            })
        ));
    }

    #[test]
    fn serializes_explicit_waveform_trace_and_error_shapes() {
        let waveform = serde_json::to_value(delayed_step()).unwrap();
        assert_eq!(waveform["kind"], "pulse");
        assert_eq!(waveform["highValue"], 5.0);
        let error = serde_json::to_value(TransientError::UnknownWaveformSource {
            source_id: ComponentId::new("missing"),
        })
        .unwrap();
        assert_eq!(error["code"], "unknownWaveformSource");
        assert_eq!(error["context"]["sourceId"], "missing");
    }
}
