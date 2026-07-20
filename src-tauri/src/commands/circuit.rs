use collab_circuit::{
    compile_schematic, dc_sweep_outputs_for_probes, solve_dc, solve_dc_with_control,
    solve_transient_with_control, sweep_dc_with_control, transient_outputs_for_probes,
    CompilationError, ComponentId, DcOperatingPoint, DcSweepError, DcSweepLimits, DcSweepOutput,
    DcSweepRequest, DcSweepResult, DcSweepTrace, ProbeTarget, SchematicDocument,
    SchematicSourceMap, SchematicSourceWaveform, SimulationError, SourceWaveform, TransientError,
    TransientLimits, TransientOutput, TransientRequest, TransientResult, TransientTrace,
};
use parking_lot::Mutex;
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Instant,
};
use tauri::State;
use thiserror::Error;

use crate::state::AppState;

const MAX_ACTIVE_CIRCUIT_JOBS: usize = 4;
const MAX_RETAINED_CIRCUIT_JOBS: usize = 32;
const MAX_SWEEP_CHUNK_SAMPLES: usize = 512;
const MAX_TRANSIENT_CHUNK_SAMPLES: usize = 512;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitDcResult {
    pub operating_point: DcOperatingPoint,
    pub source_map: SchematicSourceMap,
    pub probe_values: Vec<CircuitProbeValue>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum CircuitProbeValue {
    NodeVoltage {
        probe_id: String,
        label: Option<String>,
        value_volts: f64,
    },
    BranchCurrent {
        probe_id: String,
        label: Option<String>,
        value_amps: f64,
    },
}

#[derive(Clone, Debug, Error, PartialEq, Serialize)]
#[serde(tag = "stage", content = "detail", rename_all = "camelCase")]
pub enum CircuitCommandError {
    #[error(transparent)]
    Compilation(#[from] CompilationError),
    #[error(transparent)]
    Simulation(#[from] SimulationError),
    #[error(transparent)]
    Sweep(#[from] DcSweepError),
    #[error(transparent)]
    Transient(#[from] TransientError),
    #[error("invalid simulation configuration: {message}")]
    Configuration { message: String },
    #[error("circuit worker failed: {message}")]
    Runtime { message: String },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CircuitJobPhase {
    Queued,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CircuitJobStage {
    Queued,
    Compiling,
    Solving,
    Finalizing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitJobStatus {
    pub phase: CircuitJobPhase,
    pub stage: Option<CircuitJobStage>,
    pub elapsed_millis: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum CircuitJobOutcome {
    Completed { result: CircuitDcResult },
    SweepCompleted { summary: CircuitSweepSummary },
    TransientCompleted { summary: CircuitTransientSummary },
    Failed { error: CircuitCommandError },
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitSweepSummary {
    pub source: ComponentId,
    pub sample_count: usize,
    pub outputs: Vec<DcSweepOutput>,
    pub source_map: SchematicSourceMap,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitSweepChunk {
    pub offset: usize,
    pub source_values: Vec<f64>,
    pub traces: Vec<DcSweepTrace>,
    pub done: bool,
}

#[derive(Clone, Debug)]
struct CircuitSweepData {
    result: DcSweepResult,
    source_map: SchematicSourceMap,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitTransientSummary {
    pub sample_count: usize,
    pub outputs: Vec<TransientOutput>,
    pub source_map: SchematicSourceMap,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitTransientChunk {
    pub offset: usize,
    pub time_seconds: Vec<f64>,
    pub traces: Vec<TransientTrace>,
    pub done: bool,
}

#[derive(Clone, Debug)]
struct CircuitTransientData {
    result: TransientResult,
    source_map: SchematicSourceMap,
}

#[derive(Clone, Debug)]
enum CircuitJobState {
    Queued,
    Running(CircuitJobStage),
    Cancelling(CircuitJobStage),
    Terminal {
        outcome: CircuitJobOutcome,
        elapsed_millis: u64,
    },
}

impl CircuitJobState {
    fn phase(&self) -> CircuitJobPhase {
        match self {
            Self::Queued => CircuitJobPhase::Queued,
            Self::Running(_) => CircuitJobPhase::Running,
            Self::Cancelling(_) => CircuitJobPhase::Cancelling,
            Self::Terminal {
                outcome: CircuitJobOutcome::Completed { .. },
                ..
            } => CircuitJobPhase::Completed,
            Self::Terminal {
                outcome: CircuitJobOutcome::SweepCompleted { .. },
                ..
            } => CircuitJobPhase::Completed,
            Self::Terminal {
                outcome: CircuitJobOutcome::TransientCompleted { .. },
                ..
            } => CircuitJobPhase::Completed,
            Self::Terminal {
                outcome: CircuitJobOutcome::Failed { .. },
                ..
            } => CircuitJobPhase::Failed,
            Self::Terminal {
                outcome: CircuitJobOutcome::Cancelled,
                ..
            } => CircuitJobPhase::Cancelled,
        }
    }

    fn stage(&self) -> Option<CircuitJobStage> {
        match self {
            Self::Queued => Some(CircuitJobStage::Queued),
            Self::Running(stage) | Self::Cancelling(stage) => Some(*stage),
            Self::Terminal { .. } => None,
        }
    }

    fn is_terminal(&self) -> bool {
        matches!(self, Self::Terminal { .. })
    }
}

#[derive(Debug)]
struct CircuitJob {
    cancelled: AtomicBool,
    created_at: Instant,
    state: Mutex<CircuitJobState>,
    sweep_data: Mutex<Option<CircuitSweepData>>,
    transient_data: Mutex<Option<CircuitTransientData>>,
}

#[derive(Debug, Default)]
pub struct CircuitJobRegistry {
    jobs: Mutex<HashMap<String, Arc<CircuitJob>>>,
}

impl CircuitJobRegistry {
    fn reserve_job(&self) -> Result<(String, Arc<CircuitJob>), String> {
        let mut jobs = self.jobs.lock();
        if jobs.len() >= MAX_RETAINED_CIRCUIT_JOBS {
            jobs.retain(|_, job| !job.state.lock().is_terminal());
        }
        let active = jobs
            .values()
            .filter(|job| !job.state.lock().is_terminal())
            .count();
        if active >= MAX_ACTIVE_CIRCUIT_JOBS {
            return Err(format!(
                "At most {MAX_ACTIVE_CIRCUIT_JOBS} circuit simulations may run at once."
            ));
        }
        if jobs.len() >= MAX_RETAINED_CIRCUIT_JOBS {
            return Err(
                "Collect an existing circuit result before starting another simulation."
                    .to_string(),
            );
        }

        let job_id = uuid::Uuid::new_v4().to_string();
        let job = Arc::new(CircuitJob {
            cancelled: AtomicBool::new(false),
            created_at: Instant::now(),
            state: Mutex::new(CircuitJobState::Queued),
            sweep_data: Mutex::new(None),
            transient_data: Mutex::new(None),
        });
        jobs.insert(job_id.clone(), Arc::clone(&job));
        Ok((job_id, job))
    }

    fn start(&self, document: SchematicDocument) -> Result<String, String> {
        let (job_id, job) = self.reserve_job()?;

        let worker_id = job_id.clone();
        let spawn_result = thread::Builder::new()
            .name(format!("collab-circuit-{worker_id}"))
            .spawn(move || {
                if job.cancelled.load(Ordering::Acquire) {
                    set_terminal(&job, CircuitJobOutcome::Cancelled);
                    return;
                }
                {
                    let mut state = job.state.lock();
                    if matches!(*state, CircuitJobState::Cancelling(_)) {
                        drop(state);
                        set_terminal(&job, CircuitJobOutcome::Cancelled);
                        return;
                    }
                    *state = CircuitJobState::Running(CircuitJobStage::Compiling);
                }

                let solved = catch_unwind(AssertUnwindSafe(|| {
                    solve_document_with_control(
                        document,
                        || job.cancelled.load(Ordering::Acquire),
                        |stage| set_job_stage(&job, stage),
                    )
                }));
                let outcome = match solved {
                    Ok(Ok(result)) => CircuitJobOutcome::Completed { result },
                    Ok(Err(CircuitCommandError::Simulation(SimulationError::Cancelled))) => {
                        CircuitJobOutcome::Cancelled
                    }
                    Ok(Err(error)) => CircuitJobOutcome::Failed { error },
                    Err(_) => CircuitJobOutcome::Failed {
                        error: CircuitCommandError::Runtime {
                            message: "the worker panicked".to_string(),
                        },
                    },
                };
                set_terminal(&job, outcome);
            });
        if let Err(error) = spawn_result {
            self.jobs.lock().remove(&job_id);
            return Err(format!("Could not start the circuit worker: {error}"));
        }
        Ok(job_id)
    }

    fn start_sweep(&self, document: SchematicDocument) -> Result<String, String> {
        let (job_id, job) = self.reserve_job()?;
        let worker_id = job_id.clone();
        let spawn_result = thread::Builder::new()
            .name(format!("collab-circuit-sweep-{worker_id}"))
            .spawn(move || {
                if !begin_job(&job) {
                    return;
                }
                let solved = catch_unwind(AssertUnwindSafe(|| {
                    sweep_document_with_control(
                        document,
                        || job.cancelled.load(Ordering::Acquire),
                        |stage| set_job_stage(&job, stage),
                    )
                }));
                let outcome = match solved {
                    Ok(Ok(data)) => {
                        let summary = CircuitSweepSummary {
                            source: data.result.source.clone(),
                            sample_count: data.result.source_values.len(),
                            outputs: data
                                .result
                                .traces
                                .iter()
                                .map(|trace| trace.output.clone())
                                .collect(),
                            source_map: data.source_map.clone(),
                        };
                        *job.sweep_data.lock() = Some(data);
                        CircuitJobOutcome::SweepCompleted { summary }
                    }
                    Ok(Err(CircuitCommandError::Sweep(DcSweepError::Cancelled))) => {
                        CircuitJobOutcome::Cancelled
                    }
                    Ok(Err(error)) => CircuitJobOutcome::Failed { error },
                    Err(_) => CircuitJobOutcome::Failed {
                        error: CircuitCommandError::Runtime {
                            message: "the worker panicked".to_string(),
                        },
                    },
                };
                set_terminal(&job, outcome);
            });
        if let Err(error) = spawn_result {
            self.jobs.lock().remove(&job_id);
            return Err(format!("Could not start the circuit sweep worker: {error}"));
        }
        Ok(job_id)
    }

    fn start_transient(&self, document: SchematicDocument) -> Result<String, String> {
        let (job_id, job) = self.reserve_job()?;
        let worker_id = job_id.clone();
        let spawn_result = thread::Builder::new()
            .name(format!("collab-circuit-transient-{worker_id}"))
            .spawn(move || {
                if !begin_job(&job) {
                    return;
                }
                let solved = catch_unwind(AssertUnwindSafe(|| {
                    transient_document_with_control(
                        document,
                        || job.cancelled.load(Ordering::Acquire),
                        |stage| set_job_stage(&job, stage),
                    )
                }));
                let outcome = match solved {
                    Ok(Ok(data)) => {
                        let summary = CircuitTransientSummary {
                            sample_count: data.result.time_seconds.len(),
                            outputs: data
                                .result
                                .traces
                                .iter()
                                .map(|trace| trace.output.clone())
                                .collect(),
                            source_map: data.source_map.clone(),
                        };
                        *job.transient_data.lock() = Some(data);
                        CircuitJobOutcome::TransientCompleted { summary }
                    }
                    Ok(Err(CircuitCommandError::Transient(TransientError::Cancelled))) => {
                        CircuitJobOutcome::Cancelled
                    }
                    Ok(Err(error)) => CircuitJobOutcome::Failed { error },
                    Err(_) => CircuitJobOutcome::Failed {
                        error: CircuitCommandError::Runtime {
                            message: "the worker panicked".to_string(),
                        },
                    },
                };
                set_terminal(&job, outcome);
            });
        if let Err(error) = spawn_result {
            self.jobs.lock().remove(&job_id);
            return Err(format!(
                "Could not start the circuit transient worker: {error}"
            ));
        }
        Ok(job_id)
    }

    fn status(&self, job_id: &str) -> Result<CircuitJobStatus, String> {
        let job = self
            .jobs
            .lock()
            .get(job_id)
            .cloned()
            .ok_or_else(|| format!("Unknown circuit job '{job_id}'."))?;
        let state = job.state.lock();
        let elapsed_millis = match &*state {
            CircuitJobState::Terminal { elapsed_millis, .. } => *elapsed_millis,
            _ => elapsed_millis(job.created_at),
        };
        Ok(CircuitJobStatus {
            phase: state.phase(),
            stage: state.stage(),
            elapsed_millis,
        })
    }

    fn cancel(&self, job_id: &str) -> Result<CircuitJobPhase, String> {
        let job = self
            .jobs
            .lock()
            .get(job_id)
            .cloned()
            .ok_or_else(|| format!("Unknown circuit job '{job_id}'."))?;
        job.cancelled.store(true, Ordering::Release);
        let mut state = job.state.lock();
        *state = match *state {
            CircuitJobState::Queued => CircuitJobState::Cancelling(CircuitJobStage::Queued),
            CircuitJobState::Running(stage) => CircuitJobState::Cancelling(stage),
            _ => return Ok(state.phase()),
        };
        Ok(state.phase())
    }

    fn take_outcome(&self, job_id: &str) -> Result<Option<CircuitJobOutcome>, String> {
        let job = self
            .jobs
            .lock()
            .get(job_id)
            .cloned()
            .ok_or_else(|| format!("Unknown circuit job '{job_id}'."))?;
        let outcome = match &*job.state.lock() {
            CircuitJobState::Terminal { outcome, .. } => Some(outcome.clone()),
            _ => None,
        };
        if outcome.as_ref().is_some_and(|outcome| {
            !matches!(
                outcome,
                CircuitJobOutcome::SweepCompleted { .. }
                    | CircuitJobOutcome::TransientCompleted { .. }
            )
        }) {
            self.jobs.lock().remove(job_id);
        }
        Ok(outcome)
    }

    fn read_sweep_chunk(
        &self,
        job_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<CircuitSweepChunk, String> {
        if limit == 0 || limit > MAX_SWEEP_CHUNK_SAMPLES {
            return Err(format!(
                "Sweep chunks must request between 1 and {MAX_SWEEP_CHUNK_SAMPLES} samples."
            ));
        }
        let job = self
            .jobs
            .lock()
            .get(job_id)
            .cloned()
            .ok_or_else(|| format!("Unknown circuit job '{job_id}'."))?;
        if !matches!(
            &*job.state.lock(),
            CircuitJobState::Terminal {
                outcome: CircuitJobOutcome::SweepCompleted { .. },
                ..
            }
        ) {
            return Err("The circuit sweep result is not ready.".to_string());
        }
        let data = job.sweep_data.lock();
        let data = data
            .as_ref()
            .ok_or_else(|| "The circuit sweep result is unavailable.".to_string())?;
        let sample_count = data.result.source_values.len();
        if offset > sample_count {
            return Err(format!(
                "Sweep chunk offset {offset} exceeds the {sample_count}-sample result."
            ));
        }
        let end = offset.saturating_add(limit).min(sample_count);
        Ok(CircuitSweepChunk {
            offset,
            source_values: data.result.source_values[offset..end].to_vec(),
            traces: data
                .result
                .traces
                .iter()
                .map(|trace| DcSweepTrace {
                    output: trace.output.clone(),
                    values: trace.values[offset..end].to_vec(),
                })
                .collect(),
            done: end == sample_count,
        })
    }

    fn read_transient_chunk(
        &self,
        job_id: &str,
        offset: usize,
        limit: usize,
    ) -> Result<CircuitTransientChunk, String> {
        if limit == 0 || limit > MAX_TRANSIENT_CHUNK_SAMPLES {
            return Err(format!(
                "Transient chunks must request between 1 and {MAX_TRANSIENT_CHUNK_SAMPLES} samples."
            ));
        }
        let job = self
            .jobs
            .lock()
            .get(job_id)
            .cloned()
            .ok_or_else(|| format!("Unknown circuit job '{job_id}'."))?;
        if !matches!(
            &*job.state.lock(),
            CircuitJobState::Terminal {
                outcome: CircuitJobOutcome::TransientCompleted { .. },
                ..
            }
        ) {
            return Err("The circuit transient result is not ready.".to_string());
        }
        let data = job.transient_data.lock();
        let data = data
            .as_ref()
            .ok_or_else(|| "The circuit transient result is unavailable.".to_string())?;
        let sample_count = data.result.time_seconds.len();
        if offset > sample_count {
            return Err(format!(
                "Transient chunk offset {offset} exceeds the {sample_count}-sample result."
            ));
        }
        let end = offset.saturating_add(limit).min(sample_count);
        Ok(CircuitTransientChunk {
            offset,
            time_seconds: data.result.time_seconds[offset..end].to_vec(),
            traces: data
                .result
                .traces
                .iter()
                .map(|trace| TransientTrace {
                    output: trace.output.clone(),
                    values: trace.values[offset..end].to_vec(),
                })
                .collect(),
            done: end == sample_count,
        })
    }

    fn discard(&self, job_id: &str) -> Result<(), String> {
        let mut jobs = self.jobs.lock();
        let job = jobs
            .get(job_id)
            .ok_or_else(|| format!("Unknown circuit job '{job_id}'."))?;
        if !job.state.lock().is_terminal() {
            return Err(
                "A running circuit job must be cancelled before it is discarded.".to_string(),
            );
        }
        jobs.remove(job_id);
        Ok(())
    }
}

fn begin_job(job: &CircuitJob) -> bool {
    if job.cancelled.load(Ordering::Acquire) {
        set_terminal(job, CircuitJobOutcome::Cancelled);
        return false;
    }
    let mut state = job.state.lock();
    if matches!(*state, CircuitJobState::Cancelling(_)) {
        drop(state);
        set_terminal(job, CircuitJobOutcome::Cancelled);
        return false;
    }
    *state = CircuitJobState::Running(CircuitJobStage::Compiling);
    true
}

fn elapsed_millis(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn set_job_stage(job: &CircuitJob, stage: CircuitJobStage) {
    let mut state = job.state.lock();
    *state = match *state {
        CircuitJobState::Running(_) => CircuitJobState::Running(stage),
        CircuitJobState::Cancelling(_) => CircuitJobState::Cancelling(stage),
        _ => return,
    };
}

fn set_terminal(job: &CircuitJob, outcome: CircuitJobOutcome) {
    *job.state.lock() = CircuitJobState::Terminal {
        outcome,
        elapsed_millis: elapsed_millis(job.created_at),
    };
}

fn solve_document_with_control(
    document: SchematicDocument,
    mut should_cancel: impl FnMut() -> bool,
    mut on_stage: impl FnMut(CircuitJobStage),
) -> Result<CircuitDcResult, CircuitCommandError> {
    let compiled = compile_schematic(&document)?;
    if should_cancel() {
        return Err(SimulationError::Cancelled.into());
    }
    on_stage(CircuitJobStage::Solving);
    let operating_point = solve_dc_with_control(&compiled.circuit, &mut should_cancel)?;
    if should_cancel() {
        return Err(SimulationError::Cancelled.into());
    }
    on_stage(CircuitJobStage::Finalizing);
    let result = build_dc_result(operating_point, compiled.source_map);
    if should_cancel() {
        return Err(SimulationError::Cancelled.into());
    }
    Ok(result)
}

fn sweep_document_with_control(
    document: SchematicDocument,
    mut should_cancel: impl FnMut() -> bool,
    mut on_stage: impl FnMut(CircuitJobStage),
) -> Result<CircuitSweepData, CircuitCommandError> {
    let config = document
        .simulation
        .as_ref()
        .and_then(|simulation| simulation.dc_sweep.clone())
        .ok_or_else(|| CircuitCommandError::Configuration {
            message: "the document has no DC sweep configuration".to_string(),
        })?;
    let compiled = compile_schematic(&document)?;
    if should_cancel() {
        return Err(DcSweepError::Cancelled.into());
    }
    on_stage(CircuitJobStage::Solving);
    let request = DcSweepRequest {
        source: ComponentId::new(config.source_node_id),
        start: config.start,
        stop: config.stop,
        sample_count: config.sample_count,
        outputs: dc_sweep_outputs_for_probes(&compiled.source_map.probes),
    };
    let result = sweep_dc_with_control(
        &compiled.circuit,
        &request,
        DcSweepLimits::default(),
        &mut should_cancel,
    )?;
    if should_cancel() {
        return Err(DcSweepError::Cancelled.into());
    }
    on_stage(CircuitJobStage::Finalizing);
    Ok(CircuitSweepData {
        result,
        source_map: compiled.source_map,
    })
}

fn transient_document_with_control(
    document: SchematicDocument,
    mut should_cancel: impl FnMut() -> bool,
    mut on_stage: impl FnMut(CircuitJobStage),
) -> Result<CircuitTransientData, CircuitCommandError> {
    let config = document
        .simulation
        .as_ref()
        .and_then(|simulation| simulation.transient.clone())
        .ok_or_else(|| CircuitCommandError::Configuration {
            message: "the document has no transient configuration".to_string(),
        })?;
    let compiled = compile_schematic(&document)?;
    if should_cancel() {
        return Err(TransientError::Cancelled.into());
    }
    on_stage(CircuitJobStage::Solving);
    let source_waveforms = config
        .source_waveforms
        .into_iter()
        .map(|(source_node_id, waveform)| {
            (
                ComponentId::new(source_node_id),
                source_waveform_from_schematic(waveform),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let request = TransientRequest {
        duration_seconds: config.duration_seconds,
        max_time_step_seconds: config.max_time_step_seconds,
        source_waveforms,
        outputs: transient_outputs_for_probes(&compiled.source_map.probes),
    };
    let result = solve_transient_with_control(
        &compiled.circuit,
        &request,
        TransientLimits::default(),
        &mut should_cancel,
    )?;
    if should_cancel() {
        return Err(TransientError::Cancelled.into());
    }
    on_stage(CircuitJobStage::Finalizing);
    Ok(CircuitTransientData {
        result,
        source_map: compiled.source_map,
    })
}

fn source_waveform_from_schematic(waveform: SchematicSourceWaveform) -> SourceWaveform {
    match waveform {
        SchematicSourceWaveform::Dc => SourceWaveform::Dc,
        SchematicSourceWaveform::Pulse {
            low_value,
            high_value,
            delay_seconds,
            rise_seconds,
            fall_seconds,
            pulse_width_seconds,
            period_seconds,
        } => SourceWaveform::Pulse {
            low_value,
            high_value,
            delay_seconds,
            rise_seconds,
            fall_seconds,
            pulse_width_seconds,
            period_seconds,
        },
        SchematicSourceWaveform::Sine {
            offset,
            amplitude,
            frequency_hertz,
            phase_degrees,
            delay_seconds,
            damping_per_second,
        } => SourceWaveform::Sine {
            offset,
            amplitude,
            frequency_hertz,
            phase_degrees,
            delay_seconds,
            damping_per_second,
        },
    }
}

fn build_dc_result(
    operating_point: DcOperatingPoint,
    source_map: SchematicSourceMap,
) -> CircuitDcResult {
    let probe_values = source_map
        .probes
        .iter()
        .map(|probe| match &probe.target {
            ProbeTarget::NodeVoltage { electrical_node } => CircuitProbeValue::NodeVoltage {
                probe_id: probe.probe_id.clone(),
                label: probe.label.clone(),
                value_volts: operating_point.node_voltages[electrical_node],
            },
            ProbeTarget::BranchCurrent { component } => CircuitProbeValue::BranchCurrent {
                probe_id: probe.probe_id.clone(),
                label: probe.label.clone(),
                value_amps: operating_point.component_currents[component],
            },
        })
        .collect();
    CircuitDcResult {
        operating_point,
        source_map,
        probe_values,
    }
}

/// Compile and solve a bounded DC schematic using the shared first-party
/// simulation crate. This synchronous command remains for compatibility;
/// interactive callers should use the cancellable job commands below.
#[tauri::command]
pub fn circuit_solve_dc(
    document: SchematicDocument,
) -> Result<CircuitDcResult, CircuitCommandError> {
    let compiled = compile_schematic(&document)?;
    let operating_point = solve_dc(&compiled.circuit)?;
    Ok(build_dc_result(operating_point, compiled.source_map))
}

#[tauri::command]
pub fn circuit_start_dc(
    document: SchematicDocument,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.circuit_jobs.start(document)
}

#[tauri::command]
pub fn circuit_start_dc_sweep(
    document: SchematicDocument,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.circuit_jobs.start_sweep(document)
}

#[tauri::command]
pub fn circuit_start_transient(
    document: SchematicDocument,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.circuit_jobs.start_transient(document)
}

#[tauri::command]
pub fn circuit_job_status(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<CircuitJobStatus, String> {
    state.circuit_jobs.status(&job_id)
}

#[tauri::command]
pub fn circuit_cancel_job(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<CircuitJobPhase, String> {
    state.circuit_jobs.cancel(&job_id)
}

#[tauri::command]
pub fn circuit_take_job_result(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<Option<CircuitJobOutcome>, String> {
    state.circuit_jobs.take_outcome(&job_id)
}

#[tauri::command]
pub fn circuit_read_sweep_chunk(
    job_id: String,
    offset: usize,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<CircuitSweepChunk, String> {
    state.circuit_jobs.read_sweep_chunk(&job_id, offset, limit)
}

#[tauri::command]
pub fn circuit_read_transient_chunk(
    job_id: String,
    offset: usize,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<CircuitTransientChunk, String> {
    state
        .circuit_jobs
        .read_transient_chunk(&job_id, offset, limit)
}

#[tauri::command]
pub fn circuit_discard_job(job_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.circuit_jobs.discard(&job_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use collab_circuit::{
        ComponentId, DcDiagnostic, DiagramMode, SchematicComponentKind, SchematicDcSweepConfig,
        SchematicElectricalParameters, SchematicNode, SchematicProbe, SchematicProbeKind,
        SchematicSimulationConfig, SchematicSourceWaveform, SchematicTransientConfig,
        SchematicWire,
    };
    use std::time::Duration;

    fn ground_document() -> SchematicDocument {
        SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![SchematicNode {
                id: "ground".to_string(),
                kind: SchematicComponentKind::Ground,
                rotation: None,
                electrical: None,
            }],
            wires: vec![],
            simulation: None,
        }
    }

    fn sweep_document() -> SchematicDocument {
        let node =
            |id: &str,
             kind: SchematicComponentKind,
             electrical: Option<SchematicElectricalParameters>| SchematicNode {
                id: id.to_string(),
                kind,
                rotation: None,
                electrical,
            };
        let wire =
            |id: &str, source: &str, source_handle: &str, target: &str, target_handle: &str| {
                SchematicWire {
                    id: id.to_string(),
                    source: source.to_string(),
                    target: target.to_string(),
                    source_handle: Some(source_handle.to_string()),
                    target_handle: Some(target_handle.to_string()),
                }
            };
        SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![
                node(
                    "source",
                    SchematicComponentKind::VoltageSource,
                    Some(SchematicElectricalParameters {
                        voltage_volts: Some(10.0),
                        ..Default::default()
                    }),
                ),
                node(
                    "r1",
                    SchematicComponentKind::Resistor,
                    Some(SchematicElectricalParameters {
                        resistance_ohms: Some(1_000.0),
                        ..Default::default()
                    }),
                ),
                node(
                    "r2",
                    SchematicComponentKind::Resistor,
                    Some(SchematicElectricalParameters {
                        resistance_ohms: Some(1_000.0),
                        ..Default::default()
                    }),
                ),
                node("ground", SchematicComponentKind::Ground, None),
            ],
            wires: vec![
                wire("w1", "source", "positive", "r1", "terminal-a"),
                wire("w2", "r1", "terminal-b", "r2", "terminal-a"),
                wire("w3", "r2", "terminal-b", "ground", "terminal"),
                wire("w4", "source", "negative", "ground", "terminal"),
            ],
            simulation: Some(SchematicSimulationConfig {
                probes: vec![SchematicProbe {
                    id: "output".to_string(),
                    kind: SchematicProbeKind::NodeVoltage,
                    node_id: "r2".to_string(),
                    handle_id: Some("terminal-a".to_string()),
                    label: Some("Output".to_string()),
                }],
                dc_sweep: Some(SchematicDcSweepConfig {
                    source_node_id: "source".to_string(),
                    start: 0.0,
                    stop: 10.0,
                    sample_count: 3,
                }),
                transient: None,
            }),
        }
    }

    fn transient_document() -> SchematicDocument {
        let node =
            |id: &str,
             kind: SchematicComponentKind,
             electrical: Option<SchematicElectricalParameters>| SchematicNode {
                id: id.to_string(),
                kind,
                rotation: None,
                electrical,
            };
        let wire =
            |id: &str, source: &str, source_handle: &str, target: &str, target_handle: &str| {
                SchematicWire {
                    id: id.to_string(),
                    source: source.to_string(),
                    target: target.to_string(),
                    source_handle: Some(source_handle.to_string()),
                    target_handle: Some(target_handle.to_string()),
                }
            };
        SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![
                node(
                    "source",
                    SchematicComponentKind::VoltageSource,
                    Some(SchematicElectricalParameters {
                        voltage_volts: Some(0.0),
                        ..Default::default()
                    }),
                ),
                node(
                    "resistor",
                    SchematicComponentKind::Resistor,
                    Some(SchematicElectricalParameters {
                        resistance_ohms: Some(1_000.0),
                        ..Default::default()
                    }),
                ),
                node(
                    "capacitor",
                    SchematicComponentKind::Capacitor,
                    Some(SchematicElectricalParameters {
                        capacitance_farads: Some(1.0e-6),
                        ..Default::default()
                    }),
                ),
                node("ground", SchematicComponentKind::Ground, None),
            ],
            wires: vec![
                wire("w1", "source", "positive", "resistor", "terminal-a"),
                wire("w2", "resistor", "terminal-b", "capacitor", "terminal-a"),
                wire("w3", "capacitor", "terminal-b", "ground", "terminal"),
                wire("w4", "source", "negative", "ground", "terminal"),
            ],
            simulation: Some(SchematicSimulationConfig {
                probes: vec![SchematicProbe {
                    id: "output".to_string(),
                    kind: SchematicProbeKind::NodeVoltage,
                    node_id: "capacitor".to_string(),
                    handle_id: Some("terminal-a".to_string()),
                    label: Some("Output".to_string()),
                }],
                dc_sweep: None,
                transient: Some(SchematicTransientConfig {
                    duration_seconds: 0.003,
                    max_time_step_seconds: 0.001,
                    source_waveforms: BTreeMap::from([(
                        "source".to_string(),
                        SchematicSourceWaveform::Pulse {
                            low_value: 0.0,
                            high_value: 5.0,
                            delay_seconds: 0.001,
                            rise_seconds: 0.0,
                            fall_seconds: 0.0,
                            pulse_width_seconds: 0.008,
                            period_seconds: 0.02,
                        },
                    )]),
                }),
            }),
        }
    }

    #[test]
    fn command_result_and_errors_have_stable_typed_json_shapes() {
        let result = circuit_solve_dc(SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![SchematicNode {
                id: "ground".to_string(),
                kind: SchematicComponentKind::Ground,
                rotation: Some(90),
                electrical: None,
            }],
            wires: Vec::<SchematicWire>::new(),
            simulation: None,
        })
        .unwrap();
        let serialized = serde_json::to_value(result).unwrap();
        assert_eq!(serialized["operatingPoint"]["nodeVoltages"]["0"], 0.0);
        assert_eq!(
            serialized["operatingPoint"]["componentPowers"],
            serde_json::json!({})
        );
        assert_eq!(
            serialized["operatingPoint"]["diagnostics"],
            serde_json::json!([])
        );
        assert_eq!(serialized["probeValues"], serde_json::json!([]));
        assert_eq!(serialized["operatingPoint"]["iterations"], 1);
        assert_eq!(
            serialized["sourceMap"]["terminals"][0]["terminal"]["handleId"],
            "terminal"
        );

        let error = CircuitCommandError::Compilation(CompilationError::MissingGround);
        let serialized = serde_json::to_value(error).unwrap();
        assert_eq!(serialized["stage"], "compilation");
        assert_eq!(serialized["detail"]["code"], "missingGround");

        let diagnostic = serde_json::to_value(DcDiagnostic::NpnOutsideForwardActive {
            component: ComponentId::new("q1"),
            base_emitter_voltage: 0.7,
            collector_emitter_voltage: -0.2,
        })
        .unwrap();
        assert_eq!(diagnostic["context"]["baseEmitterVoltage"], 0.7);
        assert_eq!(diagnostic["context"]["collectorEmitterVoltage"], -0.2);

        let error = CircuitCommandError::Compilation(CompilationError::UnknownProbeNode {
            probe_id: "p1".to_string(),
            node_id: "removed".to_string(),
        });
        let serialized = serde_json::to_value(error).unwrap();
        assert_eq!(serialized["detail"]["context"]["probeId"], "p1");
        assert_eq!(serialized["detail"]["context"]["nodeId"], "removed");

        let error = CircuitCommandError::Compilation(CompilationError::DisconnectedTerminal {
            node_id: "r1".to_string(),
            handle_id: "terminal-b".to_string(),
        });
        let serialized = serde_json::to_value(error).unwrap();
        assert_eq!(serialized["detail"]["context"]["nodeId"], "r1");
        assert_eq!(serialized["detail"]["context"]["handleId"], "terminal-b");

        let error = CircuitCommandError::Simulation(SimulationError::TimeLimitExceeded {
            limit_millis: 10_000,
        });
        let serialized = serde_json::to_value(error).unwrap();
        assert_eq!(serialized["stage"], "simulation");
        assert_eq!(serialized["detail"]["code"], "timeLimitExceeded");
        assert_eq!(serialized["detail"]["context"]["limitMillis"], 10_000);

        let error =
            CircuitCommandError::Simulation(SimulationError::DenseSolverSizeLimitExceeded {
                unknowns: 640,
                max_unknowns: 512,
            });
        let serialized = serde_json::to_value(error).unwrap();
        assert_eq!(serialized["detail"]["code"], "denseSolverSizeLimitExceeded");
        assert_eq!(serialized["detail"]["context"]["unknowns"], 640);
        assert_eq!(serialized["detail"]["context"]["maxUnknowns"], 512);

        let error =
            CircuitCommandError::Sweep(DcSweepError::InvalidSampleCount { sample_count: 1 });
        let serialized = serde_json::to_value(error).unwrap();
        assert_eq!(serialized["stage"], "sweep");
        assert_eq!(serialized["detail"]["code"], "invalidSampleCount");
        assert_eq!(serialized["detail"]["context"]["sampleCount"], 1);

        let error = CircuitCommandError::Transient(TransientError::InvalidTimeRange {
            duration_seconds: 0.0,
            max_time_step_seconds: 0.001,
        });
        let serialized = serde_json::to_value(error).unwrap();
        assert_eq!(serialized["stage"], "transient");
        assert_eq!(serialized["detail"]["code"], "invalidTimeRange");
        assert_eq!(serialized["detail"]["context"]["durationSeconds"], 0.0);
    }

    #[test]
    fn command_returns_typed_probe_values() {
        let result = circuit_solve_dc(SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![
                SchematicNode {
                    id: "r1".to_string(),
                    kind: SchematicComponentKind::Resistor,
                    rotation: None,
                    electrical: Some(SchematicElectricalParameters {
                        resistance_ohms: Some(1_000.0),
                        ..Default::default()
                    }),
                },
                SchematicNode {
                    id: "ground".to_string(),
                    kind: SchematicComponentKind::Ground,
                    rotation: None,
                    electrical: None,
                },
            ],
            wires: vec![
                SchematicWire {
                    id: "a-ground".to_string(),
                    source: "r1".to_string(),
                    target: "ground".to_string(),
                    source_handle: Some("terminal-a".to_string()),
                    target_handle: Some("terminal".to_string()),
                },
                SchematicWire {
                    id: "b-ground".to_string(),
                    source: "r1".to_string(),
                    target: "ground".to_string(),
                    source_handle: Some("terminal-b".to_string()),
                    target_handle: Some("terminal".to_string()),
                },
            ],
            simulation: Some(SchematicSimulationConfig {
                probes: vec![SchematicProbe {
                    id: "load-current".to_string(),
                    kind: SchematicProbeKind::BranchCurrent,
                    node_id: "r1".to_string(),
                    handle_id: None,
                    label: Some("Load current".to_string()),
                }],
                dc_sweep: None,
                transient: None,
            }),
        })
        .unwrap();

        let serialized = serde_json::to_value(result).unwrap();
        assert_eq!(serialized["probeValues"][0]["kind"], "branch-current");
        assert_eq!(serialized["probeValues"][0]["probeId"], "load-current");
        assert_eq!(serialized["probeValues"][0]["valueAmps"], 0.0);
        assert_eq!(
            serialized["sourceMap"]["probes"][0]["kind"],
            "branch-current"
        );
        assert_eq!(serialized["sourceMap"]["probes"][0]["component"], "r1");
    }

    #[test]
    fn job_registry_runs_on_a_worker_and_consumes_terminal_results() {
        let registry = CircuitJobRegistry::default();
        let job_id = registry.start(ground_document()).unwrap();
        let status = (0..100)
            .find_map(|_| {
                let status = registry.status(&job_id).unwrap();
                if matches!(
                    status.phase,
                    CircuitJobPhase::Completed
                        | CircuitJobPhase::Failed
                        | CircuitJobPhase::Cancelled
                ) {
                    Some(status)
                } else {
                    thread::sleep(Duration::from_millis(5));
                    None
                }
            })
            .expect("worker should finish within the test timeout");
        assert_eq!(status.phase, CircuitJobPhase::Completed);
        assert_eq!(status.stage, None);

        let outcome = registry.take_outcome(&job_id).unwrap().unwrap();
        assert!(matches!(outcome, CircuitJobOutcome::Completed { .. }));
        assert!(registry.status(&job_id).is_err());
    }

    #[test]
    fn sweep_jobs_retain_bounded_chunks_until_explicitly_discarded() {
        let registry = CircuitJobRegistry::default();
        let job_id = registry.start_sweep(sweep_document()).unwrap();
        let status = (0..100)
            .find_map(|_| {
                let status = registry.status(&job_id).unwrap();
                if status.phase == CircuitJobPhase::Completed {
                    Some(status)
                } else if matches!(
                    status.phase,
                    CircuitJobPhase::Failed | CircuitJobPhase::Cancelled
                ) {
                    panic!("sweep did not complete: {status:?}");
                } else {
                    thread::sleep(Duration::from_millis(5));
                    None
                }
            })
            .expect("sweep worker should finish within the test timeout");
        assert_eq!(status.stage, None);

        let outcome = registry.take_outcome(&job_id).unwrap().unwrap();
        let CircuitJobOutcome::SweepCompleted { summary } = outcome else {
            panic!("expected a completed sweep");
        };
        assert_eq!(summary.source, ComponentId::new("source"));
        assert_eq!(summary.sample_count, 3);
        assert_eq!(summary.outputs.len(), 1);
        assert_eq!(summary.source_map.probes[0].probe_id, "output");
        let serialized = serde_json::to_value(CircuitJobOutcome::SweepCompleted {
            summary: summary.clone(),
        })
        .unwrap();
        assert_eq!(serialized["state"], "sweep-completed");
        assert_eq!(serialized["summary"]["sampleCount"], 3);
        assert_eq!(
            registry.status(&job_id).unwrap().phase,
            CircuitJobPhase::Completed
        );

        let first = registry.read_sweep_chunk(&job_id, 0, 2).unwrap();
        assert_eq!(first.source_values, vec![0.0, 5.0]);
        assert_eq!(first.traces[0].values, vec![0.0, 2.5]);
        assert!(!first.done);

        let final_chunk = registry.read_sweep_chunk(&job_id, 2, 2).unwrap();
        assert_eq!(final_chunk.source_values, vec![10.0]);
        assert_eq!(final_chunk.traces[0].values, vec![5.0]);
        assert!(final_chunk.done);
        assert!(registry
            .read_sweep_chunk(&job_id, 0, MAX_SWEEP_CHUNK_SAMPLES + 1)
            .is_err());

        registry.discard(&job_id).unwrap();
        assert!(registry.status(&job_id).is_err());
    }

    #[test]
    fn transient_jobs_retain_aligned_chunks_until_explicitly_discarded() {
        let registry = CircuitJobRegistry::default();
        let job_id = registry.start_transient(transient_document()).unwrap();
        let status = (0..100)
            .find_map(|_| {
                let status = registry.status(&job_id).unwrap();
                if status.phase == CircuitJobPhase::Completed {
                    Some(status)
                } else if matches!(
                    status.phase,
                    CircuitJobPhase::Failed | CircuitJobPhase::Cancelled
                ) {
                    panic!("transient analysis did not complete: {status:?}");
                } else {
                    thread::sleep(Duration::from_millis(5));
                    None
                }
            })
            .expect("transient worker should finish within the test timeout");
        assert_eq!(status.stage, None);

        let outcome = registry.take_outcome(&job_id).unwrap().unwrap();
        let CircuitJobOutcome::TransientCompleted { summary } = outcome else {
            panic!("expected a completed transient analysis");
        };
        assert!(summary.sample_count > 4);
        assert!(summary.sample_count <= 4_096);
        assert_eq!(summary.outputs.len(), 1);
        assert_eq!(summary.source_map.probes[0].probe_id, "output");
        let serialized = serde_json::to_value(CircuitJobOutcome::TransientCompleted {
            summary: summary.clone(),
        })
        .unwrap();
        assert_eq!(serialized["state"], "transient-completed");
        assert_eq!(serialized["summary"]["sampleCount"], summary.sample_count);

        let first = registry.read_transient_chunk(&job_id, 0, 2).unwrap();
        assert_eq!(first.time_seconds.first(), Some(&0.0));
        assert_eq!(first.time_seconds.len(), 2);
        assert_eq!(first.traces[0].values.len(), 2);
        assert!(!first.done);
        let final_chunk = registry.read_transient_chunk(&job_id, 2, 512).unwrap();
        assert_eq!(final_chunk.time_seconds.len(), summary.sample_count - 2);
        assert_eq!(final_chunk.time_seconds.last(), Some(&0.003));
        assert!(final_chunk
            .time_seconds
            .windows(2)
            .all(|pair| pair[1] > pair[0]));
        assert!(final_chunk.traces[0]
            .values
            .windows(2)
            .all(|pair| pair[1] >= pair[0]));
        assert!(final_chunk.done);
        assert!(registry
            .read_transient_chunk(&job_id, 0, MAX_TRANSIENT_CHUNK_SAMPLES + 1)
            .is_err());

        registry.discard(&job_id).unwrap();
        assert!(registry.status(&job_id).is_err());
    }

    #[test]
    fn job_registry_exposes_cancelling_and_stable_wire_shapes() {
        let registry = CircuitJobRegistry::default();
        let job_id = "queued-job".to_string();
        let job = Arc::new(CircuitJob {
            cancelled: AtomicBool::new(false),
            created_at: Instant::now(),
            state: Mutex::new(CircuitJobState::Queued),
            sweep_data: Mutex::new(None),
            transient_data: Mutex::new(None),
        });
        registry
            .jobs
            .lock()
            .insert(job_id.clone(), Arc::clone(&job));

        assert_eq!(
            registry.cancel(&job_id).unwrap(),
            CircuitJobPhase::Cancelling
        );
        assert!(job.cancelled.load(Ordering::Acquire));
        let status = registry.status(&job_id).unwrap();
        assert_eq!(status.phase, CircuitJobPhase::Cancelling);
        assert_eq!(status.stage, Some(CircuitJobStage::Queued));
        assert_eq!(
            serde_json::to_value(CircuitJobOutcome::Cancelled).unwrap(),
            serde_json::json!({ "state": "cancelled" })
        );
        assert_eq!(
            serde_json::to_value(CircuitJobPhase::Running).unwrap(),
            serde_json::json!("running")
        );
        assert_eq!(
            serde_json::to_value(CircuitJobStage::Finalizing).unwrap(),
            serde_json::json!("finalizing")
        );
        let serialized_status = serde_json::to_value(status).unwrap();
        assert_eq!(serialized_status["phase"], "cancelling");
        assert_eq!(serialized_status["stage"], "queued");
        assert!(serialized_status["elapsedMillis"].is_u64());
    }

    #[test]
    fn job_registry_rejects_more_than_the_active_job_limit() {
        let registry = CircuitJobRegistry::default();
        for index in 0..MAX_ACTIVE_CIRCUIT_JOBS {
            registry.jobs.lock().insert(
                format!("queued-{index}"),
                Arc::new(CircuitJob {
                    cancelled: AtomicBool::new(false),
                    created_at: Instant::now(),
                    state: Mutex::new(CircuitJobState::Queued),
                    sweep_data: Mutex::new(None),
                    transient_data: Mutex::new(None),
                }),
            );
        }

        let error = registry.start(ground_document()).unwrap_err();
        assert_eq!(
            error,
            format!("At most {MAX_ACTIVE_CIRCUIT_JOBS} circuit simulations may run at once.")
        );
    }
}
