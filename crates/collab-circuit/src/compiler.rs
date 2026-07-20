use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{Circuit, Component, ComponentId, NodeId};

const MAX_SCHEMATIC_COMPONENTS: usize = 512;
const MAX_SCHEMATIC_WIRES: usize = 4_096;
const MAX_SCHEMATIC_PROBES: usize = 2_048;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagramMode {
    Logic,
    Schematic,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SchematicComponentKind {
    Resistor,
    Capacitor,
    Inductor,
    Diode,
    Led,
    Transistor,
    Switch,
    Ground,
    Junction,
    VoltageSource,
}

impl fmt::Display for SchematicComponentKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::Resistor => "resistor",
            Self::Capacitor => "capacitor",
            Self::Inductor => "inductor",
            Self::Diode => "diode",
            Self::Led => "led",
            Self::Transistor => "transistor",
            Self::Switch => "switch",
            Self::Ground => "ground",
            Self::Junction => "junction",
            Self::VoltageSource => "voltage-source",
        };
        formatter.write_str(value)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchematicElectricalParameters {
    pub resistance_ohms: Option<f64>,
    pub capacitance_farads: Option<f64>,
    pub inductance_henries: Option<f64>,
    pub voltage_volts: Option<f64>,
    pub switch_closed: Option<bool>,
    pub model_ref: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchematicNode {
    pub id: String,
    pub kind: SchematicComponentKind,
    #[serde(default)]
    pub rotation: Option<u16>,
    #[serde(default)]
    pub electrical: Option<SchematicElectricalParameters>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchematicWire {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub source_handle: Option<String>,
    #[serde(default)]
    pub target_handle: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SchematicProbeKind {
    NodeVoltage,
    BranchCurrent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchematicProbe {
    pub id: String,
    pub kind: SchematicProbeKind,
    pub node_id: String,
    #[serde(default)]
    pub handle_id: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchematicSimulationConfig {
    #[serde(default)]
    pub probes: Vec<SchematicProbe>,
    #[serde(default)]
    pub dc_sweep: Option<SchematicDcSweepConfig>,
    #[serde(default)]
    pub transient: Option<SchematicTransientConfig>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchematicDcSweepConfig {
    pub source_node_id: String,
    pub start: f64,
    pub stop: f64,
    pub sample_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchematicTransientConfig {
    pub duration_seconds: f64,
    pub max_time_step_seconds: f64,
    #[serde(default)]
    pub source_waveforms: BTreeMap<String, SchematicSourceWaveform>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SchematicSourceWaveform {
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchematicDocument {
    pub diagram_mode: DiagramMode,
    pub nodes: Vec<SchematicNode>,
    pub wires: Vec<SchematicWire>,
    #[serde(default)]
    pub simulation: Option<SchematicSimulationConfig>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRef {
    pub node_id: String,
    pub handle_id: String,
}

impl TerminalRef {
    fn new(node_id: impl Into<String>, handle_id: impl Into<String>) -> Self {
        Self {
            node_id: node_id.into(),
            handle_id: handle_id.into(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalNet {
    pub terminal: TerminalRef,
    pub electrical_node: NodeId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireNet {
    pub wire_id: String,
    pub electrical_node: NodeId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ProbeTarget {
    NodeVoltage { electrical_node: NodeId },
    BranchCurrent { component: ComponentId },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeMap {
    pub probe_id: String,
    pub label: Option<String>,
    #[serde(flatten)]
    pub target: ProbeTarget,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchematicSourceMap {
    pub terminals: Vec<TerminalNet>,
    pub wires: Vec<WireNet>,
    pub probes: Vec<ProbeMap>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledCircuit {
    pub circuit: Circuit,
    pub source_map: SchematicSourceMap,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WireEndpointRole {
    Source,
    Target,
}

impl fmt::Display for WireEndpointRole {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Source => "source",
            Self::Target => "target",
        })
    }
}

#[derive(Clone, Debug, Error, PartialEq, Serialize)]
#[serde(
    tag = "code",
    content = "context",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CompilationError {
    #[error("only schematic logic documents can be compiled as circuits")]
    NotSchematic,
    #[error("schematic node id '{node_id}' is duplicated")]
    DuplicateNodeId { node_id: String },
    #[error("schematic wire id '{wire_id}' is duplicated")]
    DuplicateWireId { wire_id: String },
    #[error("the schematic needs exactly one ground component")]
    MissingGround,
    #[error("the schematic has {count} ground components; exactly one is required")]
    MultipleGrounds { count: usize },
    #[error("component '{node_id}' ({kind}) is not supported by the current DC compiler")]
    UnsupportedComponent {
        node_id: String,
        kind: SchematicComponentKind,
    },
    #[error("component '{node_id}' references unsupported model '{model_ref}'")]
    UnsupportedModel { node_id: String, model_ref: String },
    #[error("component '{node_id}' is missing its {field} electrical value")]
    MissingElectricalValue {
        node_id: String,
        field: &'static str,
    },
    #[error("wire '{wire_id}' has no {role} terminal handle")]
    MissingWireHandle {
        wire_id: String,
        role: WireEndpointRole,
    },
    #[error("wire '{wire_id}' references unknown {role} node '{node_id}'")]
    UnknownWireNode {
        wire_id: String,
        role: WireEndpointRole,
        node_id: String,
    },
    #[error("wire '{wire_id}' references unknown terminal '{handle_id}' on node '{node_id}'")]
    UnknownTerminal {
        wire_id: String,
        node_id: String,
        handle_id: String,
    },
    #[error("probe id '{probe_id}' is duplicated")]
    DuplicateProbeId { probe_id: String },
    #[error("probe '{probe_id}' references unknown component '{node_id}'")]
    UnknownProbeNode { probe_id: String, node_id: String },
    #[error("voltage probe '{probe_id}' has no terminal handle")]
    MissingProbeHandle { probe_id: String },
    #[error("voltage probe '{probe_id}' references unknown terminal '{handle_id}' on component '{node_id}'")]
    UnknownProbeTerminal {
        probe_id: String,
        node_id: String,
        handle_id: String,
    },
    #[error("branch-current probe '{probe_id}' cannot target ground or a junction")]
    InvalidBranchProbeTarget { probe_id: String },
    #[error("component '{node_id}' has disconnected terminal '{handle_id}'")]
    DisconnectedTerminal { node_id: String, handle_id: String },
    #[error("junction '{node_id}' needs at least two connected wires, found {connections}")]
    InvalidJunctionDegree { node_id: String, connections: usize },
    #[error("components {node_ids:?} form a floating DC island without a ground reference path")]
    FloatingDcIsland { node_ids: Vec<String> },
    #[error(
        "ideal voltage source '{node_id}' connects both terminals to the same electrical node"
    )]
    InvalidIdealVoltageSource { node_id: String },
    #[error("ideal voltage sources '{first_node_id}' and '{second_node_id}' impose conflicting voltages on the same nodes")]
    ConflictingIdealVoltageSources {
        first_node_id: String,
        second_node_id: String,
    },
    #[error("ideal voltage sources '{first_node_id}' and '{second_node_id}' redundantly constrain the same nodes")]
    RedundantIdealVoltageSources {
        first_node_id: String,
        second_node_id: String,
    },
    #[error("schematic exceeds the DC baseline limit ({components} components, {wires} wires, {probes} probes)")]
    OversizedCircuit {
        components: usize,
        wires: usize,
        probes: usize,
        max_components: usize,
        max_wires: usize,
        max_probes: usize,
    },
}

/// Compile a persisted schematic into a deterministic solver circuit.
///
/// Connectivity is derived only from stable terminal handles and wires. Node
/// position and rotation are intentionally ignored.
pub fn compile_schematic(
    document: &SchematicDocument,
) -> Result<CompiledCircuit, CompilationError> {
    if document.diagram_mode != DiagramMode::Schematic {
        return Err(CompilationError::NotSchematic);
    }
    let probe_count = document
        .simulation
        .as_ref()
        .map(|simulation| simulation.probes.len())
        .unwrap_or_default();
    if document.nodes.len() > MAX_SCHEMATIC_COMPONENTS
        || document.wires.len() > MAX_SCHEMATIC_WIRES
        || probe_count > MAX_SCHEMATIC_PROBES
    {
        return Err(CompilationError::OversizedCircuit {
            components: document.nodes.len(),
            wires: document.wires.len(),
            probes: probe_count,
            max_components: MAX_SCHEMATIC_COMPONENTS,
            max_wires: MAX_SCHEMATIC_WIRES,
            max_probes: MAX_SCHEMATIC_PROBES,
        });
    }

    let mut nodes: Vec<_> = document.nodes.iter().collect();
    nodes.sort_by(|left, right| left.id.cmp(&right.id));
    ensure_unique_node_ids(&nodes)?;

    let grounds = nodes
        .iter()
        .filter(|node| node.kind == SchematicComponentKind::Ground)
        .count();
    match grounds {
        0 => return Err(CompilationError::MissingGround),
        1 => {}
        count => return Err(CompilationError::MultipleGrounds { count }),
    }

    for node in &nodes {
        validate_supported_node(node)?;
    }

    let mut terminals = BTreeSet::new();
    for node in &nodes {
        for handle_id in terminals_for(node.kind) {
            terminals.insert(TerminalRef::new(&node.id, *handle_id));
        }
    }
    let mut nets = DisjointSet::new(terminals.iter().cloned());

    let nodes_by_id: BTreeMap<_, _> = nodes.iter().map(|node| (node.id.as_str(), *node)).collect();
    let mut wires: Vec<_> = document.wires.iter().collect();
    wires.sort_by(|left, right| left.id.cmp(&right.id));
    ensure_unique_wire_ids(&wires)?;

    let mut wire_terminals = Vec::with_capacity(wires.len());
    let mut terminal_connections = BTreeMap::<TerminalRef, BTreeSet<String>>::new();
    for wire in &wires {
        let source =
            resolve_wire_terminal(wire, WireEndpointRole::Source, &nodes_by_id, &terminals)?;
        let target =
            resolve_wire_terminal(wire, WireEndpointRole::Target, &nodes_by_id, &terminals)?;
        nets.union(&source, &target);
        terminal_connections
            .entry(source.clone())
            .or_default()
            .insert(wire.id.clone());
        terminal_connections
            .entry(target)
            .or_default()
            .insert(wire.id.clone());
        wire_terminals.push((wire.id.clone(), source));
    }
    for node in &nodes {
        if node.kind == SchematicComponentKind::Ground {
            continue;
        }
        for handle_id in terminals_for(node.kind) {
            let terminal = TerminalRef::new(&node.id, *handle_id);
            let connections = terminal_connections
                .get(&terminal)
                .map(BTreeSet::len)
                .unwrap_or_default();
            if node.kind == SchematicComponentKind::Junction && connections < 2 {
                return Err(CompilationError::InvalidJunctionDegree {
                    node_id: node.id.clone(),
                    connections,
                });
            }
            if connections == 0 {
                return Err(CompilationError::DisconnectedTerminal {
                    node_id: node.id.clone(),
                    handle_id: (*handle_id).to_string(),
                });
            }
        }
    }

    let ground = nodes
        .iter()
        .find(|node| node.kind == SchematicComponentKind::Ground)
        .expect("ground count was validated");
    let ground_terminal = TerminalRef::new(&ground.id, "terminal");
    let reference_root = nets.find(&ground_terminal);

    let mut root_nodes = BTreeMap::new();
    for terminal in &terminals {
        let root = nets.find(terminal);
        root_nodes.entry(root.clone()).or_insert_with(|| {
            if root == reference_root {
                NodeId::new("0")
            } else {
                NodeId::new(electrical_node_id(&root))
            }
        });
    }

    let node_for_terminal = |nets: &mut DisjointSet, terminal: &TerminalRef| {
        let root = nets.find(terminal);
        root_nodes[&root].clone()
    };

    let mut components = Vec::new();
    for node in &nodes {
        let component = match node.kind {
            SchematicComponentKind::Resistor => {
                let electrical = node
                    .electrical
                    .as_ref()
                    .expect("validated electrical values");
                Component::Resistor {
                    id: ComponentId::new(&node.id),
                    positive: node_for_terminal(
                        &mut nets,
                        &TerminalRef::new(&node.id, "terminal-a"),
                    ),
                    negative: node_for_terminal(
                        &mut nets,
                        &TerminalRef::new(&node.id, "terminal-b"),
                    ),
                    resistance_ohms: electrical.resistance_ohms.expect("validated resistance"),
                }
            }
            SchematicComponentKind::Capacitor => {
                let electrical = node
                    .electrical
                    .as_ref()
                    .expect("validated electrical values");
                Component::Capacitor {
                    id: ComponentId::new(&node.id),
                    positive: node_for_terminal(
                        &mut nets,
                        &TerminalRef::new(&node.id, "terminal-a"),
                    ),
                    negative: node_for_terminal(
                        &mut nets,
                        &TerminalRef::new(&node.id, "terminal-b"),
                    ),
                    capacitance_farads: electrical
                        .capacitance_farads
                        .expect("validated capacitance"),
                }
            }
            SchematicComponentKind::Inductor => {
                let electrical = node
                    .electrical
                    .as_ref()
                    .expect("validated electrical values");
                Component::Inductor {
                    id: ComponentId::new(&node.id),
                    positive: node_for_terminal(
                        &mut nets,
                        &TerminalRef::new(&node.id, "terminal-a"),
                    ),
                    negative: node_for_terminal(
                        &mut nets,
                        &TerminalRef::new(&node.id, "terminal-b"),
                    ),
                    inductance_henries: electrical
                        .inductance_henries
                        .expect("validated inductance"),
                }
            }
            SchematicComponentKind::Switch => {
                let electrical = node
                    .electrical
                    .as_ref()
                    .expect("validated electrical values");
                Component::Switch {
                    id: ComponentId::new(&node.id),
                    positive: node_for_terminal(
                        &mut nets,
                        &TerminalRef::new(&node.id, "terminal-a"),
                    ),
                    negative: node_for_terminal(
                        &mut nets,
                        &TerminalRef::new(&node.id, "terminal-b"),
                    ),
                    closed: electrical.switch_closed.expect("validated switch state"),
                    closed_resistance_ohms: 1.0e-3,
                    open_resistance_ohms: 1.0e12,
                }
            }
            SchematicComponentKind::Diode | SchematicComponentKind::Led => {
                let electrical = node
                    .electrical
                    .as_ref()
                    .expect("validated electrical values");
                let model_ref = electrical.model_ref.as_deref().expect("validated model");
                let (saturation_current_amps, emission_coefficient) = match model_ref {
                    "builtin:diode" => (1.0e-12, 1.0),
                    "builtin:led" => (1.0e-18, 2.0),
                    _ => unreachable!("supported model references were validated"),
                };
                Component::Diode {
                    id: ComponentId::new(&node.id),
                    anode: node_for_terminal(&mut nets, &TerminalRef::new(&node.id, "anode")),
                    cathode: node_for_terminal(&mut nets, &TerminalRef::new(&node.id, "cathode")),
                    saturation_current_amps,
                    emission_coefficient,
                    thermal_voltage_volts: 0.025_852,
                }
            }
            SchematicComponentKind::Transistor => {
                let electrical = node
                    .electrical
                    .as_ref()
                    .expect("validated electrical values");
                debug_assert_eq!(electrical.model_ref.as_deref(), Some("builtin:npn"));
                Component::BipolarNpn {
                    id: ComponentId::new(&node.id),
                    base: node_for_terminal(&mut nets, &TerminalRef::new(&node.id, "base")),
                    collector: node_for_terminal(
                        &mut nets,
                        &TerminalRef::new(&node.id, "collector"),
                    ),
                    emitter: node_for_terminal(&mut nets, &TerminalRef::new(&node.id, "emitter")),
                    saturation_current_amps: 1.0e-15,
                    forward_beta: 100.0,
                    emission_coefficient: 1.0,
                    thermal_voltage_volts: 0.025_852,
                }
            }
            SchematicComponentKind::VoltageSource => {
                let electrical = node
                    .electrical
                    .as_ref()
                    .expect("validated electrical values");
                Component::VoltageSource {
                    id: ComponentId::new(&node.id),
                    positive: node_for_terminal(&mut nets, &TerminalRef::new(&node.id, "positive")),
                    negative: node_for_terminal(&mut nets, &TerminalRef::new(&node.id, "negative")),
                    voltage_volts: electrical.voltage_volts.expect("validated voltage"),
                }
            }
            SchematicComponentKind::Ground | SchematicComponentKind::Junction => continue,
        };
        components.push(component);
    }
    validate_dc_topology(&components, &NodeId::new("0"))?;

    let terminal_nets = terminals
        .iter()
        .map(|terminal| TerminalNet {
            terminal: terminal.clone(),
            electrical_node: node_for_terminal(&mut nets, terminal),
        })
        .collect();
    let wire_nets = wire_terminals
        .into_iter()
        .map(|(wire_id, terminal)| WireNet {
            wire_id,
            electrical_node: node_for_terminal(&mut nets, &terminal),
        })
        .collect();
    let probe_maps = compile_probes(
        document
            .simulation
            .as_ref()
            .map(|simulation| simulation.probes.as_slice())
            .unwrap_or_default(),
        &nodes_by_id,
        &terminals,
        &mut nets,
        &node_for_terminal,
    )?;

    Ok(CompiledCircuit {
        circuit: Circuit {
            reference: NodeId::new("0"),
            components,
        },
        source_map: SchematicSourceMap {
            terminals: terminal_nets,
            wires: wire_nets,
            probes: probe_maps,
        },
    })
}

fn validate_dc_topology(
    components: &[Component],
    reference: &NodeId,
) -> Result<(), CompilationError> {
    let mut voltage_graph = BTreeMap::<NodeId, Vec<(NodeId, f64, ComponentId)>>::new();
    for component in components {
        let Component::VoltageSource {
            id,
            positive,
            negative,
            voltage_volts,
        } = component
        else {
            continue;
        };
        if positive == negative {
            return Err(CompilationError::InvalidIdealVoltageSource {
                node_id: id.0.clone(),
            });
        }
        if let Some((implied_voltage, first_id)) =
            implied_voltage_between(&voltage_graph, positive, negative)
        {
            let tolerance = 1.0e-12 * implied_voltage.abs().max(voltage_volts.abs()).max(1.0);
            if (implied_voltage - voltage_volts).abs() > tolerance {
                return Err(CompilationError::ConflictingIdealVoltageSources {
                    first_node_id: first_id.0.clone(),
                    second_node_id: id.0.clone(),
                });
            }
            return Err(CompilationError::RedundantIdealVoltageSources {
                first_node_id: first_id.0.clone(),
                second_node_id: id.0.clone(),
            });
        }
        voltage_graph.entry(positive.clone()).or_default().push((
            negative.clone(),
            -*voltage_volts,
            id.clone(),
        ));
        voltage_graph.entry(negative.clone()).or_default().push((
            positive.clone(),
            *voltage_volts,
            id.clone(),
        ));
    }

    let mut adjacency = BTreeMap::<NodeId, BTreeSet<NodeId>>::new();
    for component in components {
        for node in component.nodes() {
            adjacency.entry(node.clone()).or_default();
        }
        match component {
            Component::Capacitor { .. } | Component::CurrentSource { .. } => {}
            Component::BipolarNpn { base, emitter, .. } => {
                connect_nodes(&mut adjacency, base, emitter)
            }
            _ => {
                let nodes = component.nodes();
                if let Some(first) = nodes.first() {
                    for node in nodes.iter().skip(1) {
                        connect_nodes(&mut adjacency, first, node);
                    }
                }
            }
        }
    }

    let mut reachable = BTreeSet::from([reference.clone()]);
    let mut pending = vec![reference.clone()];
    while let Some(node) = pending.pop() {
        for neighbor in adjacency.get(&node).into_iter().flatten() {
            if reachable.insert(neighbor.clone()) {
                pending.push(neighbor.clone());
            }
        }
    }
    let node_ids: Vec<_> = components
        .iter()
        .filter(|component| {
            component
                .nodes()
                .iter()
                .any(|node| !reachable.contains(*node))
        })
        .map(|component| component.id().0.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if !node_ids.is_empty() {
        return Err(CompilationError::FloatingDcIsland { node_ids });
    }
    Ok(())
}

fn implied_voltage_between(
    graph: &BTreeMap<NodeId, Vec<(NodeId, f64, ComponentId)>>,
    positive: &NodeId,
    negative: &NodeId,
) -> Option<(f64, ComponentId)> {
    let mut visited = BTreeSet::from([positive.clone()]);
    let mut pending = vec![(positive.clone(), 0.0, None::<ComponentId>)];
    while let Some((node, voltage_from_positive, first_source)) = pending.pop() {
        for (neighbor, neighbor_delta, source_id) in graph.get(&node).into_iter().flatten() {
            if !visited.insert(neighbor.clone()) {
                continue;
            }
            let voltage_from_positive = voltage_from_positive + neighbor_delta;
            let first_source = first_source.clone().unwrap_or_else(|| source_id.clone());
            if neighbor == negative {
                return Some((-voltage_from_positive, first_source));
            }
            pending.push((neighbor.clone(), voltage_from_positive, Some(first_source)));
        }
    }
    None
}

fn connect_nodes(
    adjacency: &mut BTreeMap<NodeId, BTreeSet<NodeId>>,
    left: &NodeId,
    right: &NodeId,
) {
    adjacency
        .entry(left.clone())
        .or_default()
        .insert(right.clone());
    adjacency
        .entry(right.clone())
        .or_default()
        .insert(left.clone());
}

fn compile_probes(
    probes: &[SchematicProbe],
    nodes: &BTreeMap<&str, &SchematicNode>,
    terminals: &BTreeSet<TerminalRef>,
    nets: &mut DisjointSet,
    node_for_terminal: &impl Fn(&mut DisjointSet, &TerminalRef) -> NodeId,
) -> Result<Vec<ProbeMap>, CompilationError> {
    let mut probes: Vec<_> = probes.iter().collect();
    probes.sort_by(|left, right| left.id.cmp(&right.id));
    for pair in probes.windows(2) {
        if pair[0].id == pair[1].id {
            return Err(CompilationError::DuplicateProbeId {
                probe_id: pair[0].id.clone(),
            });
        }
    }

    probes
        .into_iter()
        .map(|probe| {
            let node = nodes.get(probe.node_id.as_str()).ok_or_else(|| {
                CompilationError::UnknownProbeNode {
                    probe_id: probe.id.clone(),
                    node_id: probe.node_id.clone(),
                }
            })?;
            let target = match probe.kind {
                SchematicProbeKind::NodeVoltage => {
                    let handle_id = probe.handle_id.as_ref().ok_or_else(|| {
                        CompilationError::MissingProbeHandle {
                            probe_id: probe.id.clone(),
                        }
                    })?;
                    let terminal = TerminalRef::new(&probe.node_id, handle_id);
                    if !terminals.contains(&terminal) {
                        return Err(CompilationError::UnknownProbeTerminal {
                            probe_id: probe.id.clone(),
                            node_id: probe.node_id.clone(),
                            handle_id: handle_id.clone(),
                        });
                    }
                    ProbeTarget::NodeVoltage {
                        electrical_node: node_for_terminal(nets, &terminal),
                    }
                }
                SchematicProbeKind::BranchCurrent => {
                    if matches!(
                        node.kind,
                        SchematicComponentKind::Ground | SchematicComponentKind::Junction
                    ) {
                        return Err(CompilationError::InvalidBranchProbeTarget {
                            probe_id: probe.id.clone(),
                        });
                    }
                    ProbeTarget::BranchCurrent {
                        component: ComponentId::new(&probe.node_id),
                    }
                }
            };
            Ok(ProbeMap {
                probe_id: probe.id.clone(),
                label: probe.label.clone(),
                target,
            })
        })
        .collect()
}

fn ensure_unique_node_ids(nodes: &[&SchematicNode]) -> Result<(), CompilationError> {
    for pair in nodes.windows(2) {
        if pair[0].id == pair[1].id {
            return Err(CompilationError::DuplicateNodeId {
                node_id: pair[0].id.clone(),
            });
        }
    }
    Ok(())
}

fn ensure_unique_wire_ids(wires: &[&SchematicWire]) -> Result<(), CompilationError> {
    for pair in wires.windows(2) {
        if pair[0].id == pair[1].id {
            return Err(CompilationError::DuplicateWireId {
                wire_id: pair[0].id.clone(),
            });
        }
    }
    Ok(())
}

fn validate_supported_node(node: &SchematicNode) -> Result<(), CompilationError> {
    match node.kind {
        SchematicComponentKind::Ground | SchematicComponentKind::Junction => Ok(()),
        SchematicComponentKind::Resistor => require_value(node, "resistanceOhms", |value| {
            value.resistance_ohms.is_some()
        }),
        SchematicComponentKind::Capacitor => require_value(node, "capacitanceFarads", |value| {
            value.capacitance_farads.is_some()
        }),
        SchematicComponentKind::Inductor => require_value(node, "inductanceHenries", |value| {
            value.inductance_henries.is_some()
        }),
        SchematicComponentKind::Switch => {
            require_value(node, "switchClosed", |value| value.switch_closed.is_some())
        }
        SchematicComponentKind::VoltageSource => {
            require_value(node, "voltageVolts", |value| value.voltage_volts.is_some())
        }
        SchematicComponentKind::Diode
        | SchematicComponentKind::Led
        | SchematicComponentKind::Transistor => {
            let model_ref = node
                .electrical
                .as_ref()
                .and_then(|value| value.model_ref.as_deref())
                .ok_or_else(|| CompilationError::MissingElectricalValue {
                    node_id: node.id.clone(),
                    field: "modelRef",
                })?;
            let expected = match node.kind {
                SchematicComponentKind::Diode => "builtin:diode",
                SchematicComponentKind::Led => "builtin:led",
                SchematicComponentKind::Transistor => "builtin:npn",
                _ => unreachable!(),
            };
            if model_ref == expected {
                Ok(())
            } else {
                Err(CompilationError::UnsupportedModel {
                    node_id: node.id.clone(),
                    model_ref: model_ref.to_string(),
                })
            }
        }
    }
}

fn require_value(
    node: &SchematicNode,
    field: &'static str,
    is_present: impl FnOnce(&SchematicElectricalParameters) -> bool,
) -> Result<(), CompilationError> {
    if node.electrical.as_ref().is_some_and(is_present) {
        Ok(())
    } else {
        Err(CompilationError::MissingElectricalValue {
            node_id: node.id.clone(),
            field,
        })
    }
}

fn terminals_for(kind: SchematicComponentKind) -> &'static [&'static str] {
    match kind {
        SchematicComponentKind::Resistor
        | SchematicComponentKind::Capacitor
        | SchematicComponentKind::Inductor
        | SchematicComponentKind::Switch => &["terminal-a", "terminal-b"],
        SchematicComponentKind::Diode | SchematicComponentKind::Led => &["anode", "cathode"],
        SchematicComponentKind::Transistor => &["base", "collector", "emitter"],
        SchematicComponentKind::Ground | SchematicComponentKind::Junction => &["terminal"],
        SchematicComponentKind::VoltageSource => &["negative", "positive"],
    }
}

fn resolve_wire_terminal(
    wire: &SchematicWire,
    role: WireEndpointRole,
    nodes: &BTreeMap<&str, &SchematicNode>,
    terminals: &BTreeSet<TerminalRef>,
) -> Result<TerminalRef, CompilationError> {
    let (node_id, handle_id) = match role {
        WireEndpointRole::Source => (&wire.source, wire.source_handle.as_ref()),
        WireEndpointRole::Target => (&wire.target, wire.target_handle.as_ref()),
    };
    if !nodes.contains_key(node_id.as_str()) {
        return Err(CompilationError::UnknownWireNode {
            wire_id: wire.id.clone(),
            role,
            node_id: node_id.clone(),
        });
    }
    let handle_id = handle_id.ok_or_else(|| CompilationError::MissingWireHandle {
        wire_id: wire.id.clone(),
        role,
    })?;
    let terminal = TerminalRef::new(node_id, handle_id);
    if !terminals.contains(&terminal) {
        return Err(CompilationError::UnknownTerminal {
            wire_id: wire.id.clone(),
            node_id: node_id.clone(),
            handle_id: handle_id.clone(),
        });
    }
    Ok(terminal)
}

fn electrical_node_id(root: &TerminalRef) -> String {
    format!(
        "net:{}:{}:{}",
        root.node_id.len(),
        root.node_id,
        root.handle_id
    )
}

struct DisjointSet {
    parents: BTreeMap<TerminalRef, TerminalRef>,
}

impl DisjointSet {
    fn new(items: impl IntoIterator<Item = TerminalRef>) -> Self {
        Self {
            parents: items.into_iter().map(|item| (item.clone(), item)).collect(),
        }
    }

    fn find(&mut self, item: &TerminalRef) -> TerminalRef {
        let parent = self.parents[item].clone();
        if parent == *item {
            return parent;
        }
        let root = self.find(&parent);
        self.parents.insert(item.clone(), root.clone());
        root
    }

    fn union(&mut self, left: &TerminalRef, right: &TerminalRef) {
        let left_root = self.find(left);
        let right_root = self.find(right);
        if left_root == right_root {
            return;
        }
        let (root, child) = if left_root < right_root {
            (left_root, right_root)
        } else {
            (right_root, left_root)
        };
        self.parents.insert(child, root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solve_dc;

    fn electrical(
        resistance_ohms: Option<f64>,
        voltage_volts: Option<f64>,
    ) -> SchematicElectricalParameters {
        SchematicElectricalParameters {
            resistance_ohms,
            voltage_volts,
            ..Default::default()
        }
    }

    fn node(
        id: &str,
        kind: SchematicComponentKind,
        electrical: Option<SchematicElectricalParameters>,
    ) -> SchematicNode {
        SchematicNode {
            id: id.to_string(),
            kind,
            rotation: None,
            electrical,
        }
    }

    fn wire(
        id: &str,
        source: &str,
        source_handle: &str,
        target: &str,
        target_handle: &str,
    ) -> SchematicWire {
        SchematicWire {
            id: id.to_string(),
            source: source.to_string(),
            target: target.to_string(),
            source_handle: Some(source_handle.to_string()),
            target_handle: Some(target_handle.to_string()),
        }
    }

    fn divider() -> SchematicDocument {
        SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![
                node(
                    "source",
                    SchematicComponentKind::VoltageSource,
                    Some(electrical(None, Some(10.0))),
                ),
                node(
                    "r1",
                    SchematicComponentKind::Resistor,
                    Some(electrical(Some(1_000.0), None)),
                ),
                node(
                    "r2",
                    SchematicComponentKind::Resistor,
                    Some(electrical(Some(1_000.0), None)),
                ),
                node("ground", SchematicComponentKind::Ground, None),
            ],
            wires: vec![
                wire("w1", "source", "positive", "r1", "terminal-a"),
                wire("w2", "r1", "terminal-b", "r2", "terminal-a"),
                wire("w3", "r2", "terminal-b", "ground", "terminal"),
                wire("w4", "source", "negative", "ground", "terminal"),
            ],
            simulation: None,
        }
    }

    #[test]
    fn compiles_and_solves_a_voltage_divider() {
        let compiled = compile_schematic(&divider()).unwrap();
        let operating_point = solve_dc(&compiled.circuit).unwrap();
        let output_terminal = compiled
            .source_map
            .terminals
            .iter()
            .find(|mapping| mapping.terminal == TerminalRef::new("r2", "terminal-a"))
            .unwrap();

        assert_eq!(
            operating_point.node_voltages[&output_terminal.electrical_node],
            5.0
        );
        assert_eq!(compiled.source_map.wires.len(), 4);
    }

    #[test]
    fn compiles_voltage_and_branch_current_probes_to_stable_targets() {
        let mut document = divider();
        document.simulation = Some(SchematicSimulationConfig {
            probes: vec![
                SchematicProbe {
                    id: "voltage-out".to_string(),
                    kind: SchematicProbeKind::NodeVoltage,
                    node_id: "r2".to_string(),
                    handle_id: Some("terminal-a".to_string()),
                    label: Some("Output".to_string()),
                },
                SchematicProbe {
                    id: "current-r1".to_string(),
                    kind: SchematicProbeKind::BranchCurrent,
                    node_id: "r1".to_string(),
                    handle_id: None,
                    label: Some("Load current".to_string()),
                },
            ],
            dc_sweep: None,
            transient: None,
        });

        let compiled = compile_schematic(&document).unwrap();
        let result = solve_dc(&compiled.circuit).unwrap();
        assert_eq!(compiled.source_map.probes.len(), 2);
        assert_eq!(compiled.source_map.probes[0].probe_id, "current-r1");
        assert!(matches!(
            &compiled.source_map.probes[0].target,
            ProbeTarget::BranchCurrent { component } if component == &ComponentId::new("r1")
        ));
        let ProbeTarget::NodeVoltage { electrical_node } = &compiled.source_map.probes[1].target
        else {
            panic!("expected voltage probe target");
        };
        assert_eq!(result.node_voltages[electrical_node], 5.0);
        assert_eq!(result.component_currents[&ComponentId::new("r1")], 0.005);
    }

    #[test]
    fn rejects_stale_and_ambiguous_probe_targets() {
        let mut document = divider();
        document.simulation = Some(SchematicSimulationConfig {
            probes: vec![SchematicProbe {
                id: "probe".to_string(),
                kind: SchematicProbeKind::NodeVoltage,
                node_id: "r2".to_string(),
                handle_id: None,
                label: None,
            }],
            dc_sweep: None,
            transient: None,
        });
        assert_eq!(
            compile_schematic(&document),
            Err(CompilationError::MissingProbeHandle {
                probe_id: "probe".to_string(),
            })
        );

        document.simulation.as_mut().unwrap().probes[0].handle_id =
            Some("removed-terminal".to_string());
        assert!(matches!(
            compile_schematic(&document),
            Err(CompilationError::UnknownProbeTerminal { .. })
        ));

        let probe = &mut document.simulation.as_mut().unwrap().probes[0];
        probe.kind = SchematicProbeKind::BranchCurrent;
        probe.node_id = "ground".to_string();
        probe.handle_id = None;
        assert_eq!(
            compile_schematic(&document),
            Err(CompilationError::InvalidBranchProbeTarget {
                probe_id: "probe".to_string(),
            })
        );
    }

    #[test]
    fn shared_terminals_support_wire_fan_out() {
        let document = SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![
                node(
                    "source",
                    SchematicComponentKind::VoltageSource,
                    Some(electrical(None, Some(5.0))),
                ),
                node(
                    "r1",
                    SchematicComponentKind::Resistor,
                    Some(electrical(Some(1_000.0), None)),
                ),
                node(
                    "r2",
                    SchematicComponentKind::Resistor,
                    Some(electrical(Some(2_000.0), None)),
                ),
                node("ground", SchematicComponentKind::Ground, None),
            ],
            wires: vec![
                wire("positive-r1", "source", "positive", "r1", "terminal-a"),
                wire("positive-r2", "source", "positive", "r2", "terminal-a"),
                wire(
                    "negative-ground",
                    "source",
                    "negative",
                    "ground",
                    "terminal",
                ),
                wire("r1-ground", "r1", "terminal-b", "ground", "terminal"),
                wire("r2-ground", "r2", "terminal-b", "ground", "terminal"),
            ],
            simulation: None,
        };

        let compiled = compile_schematic(&document).unwrap();
        let result = solve_dc(&compiled.circuit).unwrap();
        assert_eq!(result.component_currents[&ComponentId::new("r1")], 0.005);
        assert_eq!(result.component_currents[&ComponentId::new("r2")], 0.0025);

        let positive_wire_nodes: BTreeSet<_> = compiled
            .source_map
            .wires
            .iter()
            .filter(|mapping| mapping.wire_id.starts_with("positive"))
            .map(|mapping| mapping.electrical_node.clone())
            .collect();
        assert_eq!(positive_wire_nodes.len(), 1);
    }

    #[test]
    fn explicit_junction_connects_every_attached_wire() {
        let document = SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![
                node(
                    "source",
                    SchematicComponentKind::VoltageSource,
                    Some(electrical(None, Some(5.0))),
                ),
                node(
                    "r1",
                    SchematicComponentKind::Resistor,
                    Some(electrical(Some(1_000.0), None)),
                ),
                node(
                    "r2",
                    SchematicComponentKind::Resistor,
                    Some(electrical(Some(2_000.0), None)),
                ),
                node("junction", SchematicComponentKind::Junction, None),
                node("ground", SchematicComponentKind::Ground, None),
            ],
            wires: vec![
                wire(
                    "source-junction",
                    "source",
                    "positive",
                    "junction",
                    "terminal",
                ),
                wire("junction-r1", "junction", "terminal", "r1", "terminal-a"),
                wire("junction-r2", "junction", "terminal", "r2", "terminal-a"),
                wire("source-ground", "source", "negative", "ground", "terminal"),
                wire("r1-ground", "r1", "terminal-b", "ground", "terminal"),
                wire("r2-ground", "r2", "terminal-b", "ground", "terminal"),
            ],
            simulation: None,
        };

        let compiled = compile_schematic(&document).unwrap();
        let result = solve_dc(&compiled.circuit).unwrap();
        let junction_wire_nodes: BTreeSet<_> = compiled
            .source_map
            .wires
            .iter()
            .filter(|mapping| mapping.wire_id.contains("junction"))
            .map(|mapping| mapping.electrical_node.clone())
            .collect();

        assert_eq!(junction_wire_nodes.len(), 1);
        assert_eq!(result.component_currents[&ComponentId::new("r1")], 0.005);
        assert_eq!(result.component_currents[&ComponentId::new("r2")], 0.0025);
        assert!(!compiled
            .circuit
            .components
            .iter()
            .any(|component| component.id() == &ComponentId::new("junction")));
    }

    #[test]
    fn independent_wires_do_not_connect_without_a_junction() {
        let document = SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![
                node(
                    "source-a",
                    SchematicComponentKind::VoltageSource,
                    Some(electrical(None, Some(5.0))),
                ),
                node(
                    "source-b",
                    SchematicComponentKind::VoltageSource,
                    Some(electrical(None, Some(3.0))),
                ),
                node(
                    "r1",
                    SchematicComponentKind::Resistor,
                    Some(electrical(Some(1_000.0), None)),
                ),
                node(
                    "r2",
                    SchematicComponentKind::Resistor,
                    Some(electrical(Some(1_000.0), None)),
                ),
                node("ground", SchematicComponentKind::Ground, None),
            ],
            wires: vec![
                wire("crossing-a", "source-a", "positive", "r1", "terminal-a"),
                wire("crossing-b", "source-b", "positive", "r2", "terminal-a"),
                wire(
                    "source-a-ground",
                    "source-a",
                    "negative",
                    "ground",
                    "terminal",
                ),
                wire(
                    "source-b-ground",
                    "source-b",
                    "negative",
                    "ground",
                    "terminal",
                ),
                wire("r1-ground", "r1", "terminal-b", "ground", "terminal"),
                wire("r2-ground", "r2", "terminal-b", "ground", "terminal"),
            ],
            simulation: None,
        };

        let compiled = compile_schematic(&document).unwrap();
        let crossing_nodes: BTreeMap<_, _> = compiled
            .source_map
            .wires
            .iter()
            .filter(|mapping| mapping.wire_id.starts_with("crossing"))
            .map(|mapping| (mapping.wire_id.as_str(), mapping.electrical_node.clone()))
            .collect();

        assert_ne!(crossing_nodes["crossing-a"], crossing_nodes["crossing-b"]);
    }

    #[test]
    fn rejects_a_junction_with_fewer_than_two_wires() {
        let mut document = divider();
        document
            .nodes
            .push(node("junction", SchematicComponentKind::Junction, None));
        document.wires.push(wire(
            "dangling-junction",
            "source",
            "positive",
            "junction",
            "terminal",
        ));

        assert_eq!(
            compile_schematic(&document),
            Err(CompilationError::InvalidJunctionDegree {
                node_id: "junction".to_string(),
                connections: 1,
            })
        );
    }

    #[test]
    fn compilation_is_independent_of_order_and_rotation() {
        let first = divider();
        let mut second = first.clone();
        second.nodes.reverse();
        second.wires.reverse();
        for node in &mut second.nodes {
            node.rotation = Some(270);
        }

        assert_eq!(compile_schematic(&first), compile_schematic(&second));
    }

    #[test]
    fn reports_missing_values_and_invalid_wire_handles() {
        let missing_value = SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![
                node("r1", SchematicComponentKind::Resistor, None),
                node("ground", SchematicComponentKind::Ground, None),
            ],
            wires: vec![],
            simulation: None,
        };
        assert_eq!(
            compile_schematic(&missing_value),
            Err(CompilationError::MissingElectricalValue {
                node_id: "r1".to_string(),
                field: "resistanceOhms",
            })
        );

        let mut invalid_wire = divider();
        invalid_wire.wires[0].source_handle = Some("not-a-terminal".to_string());
        assert!(matches!(
            compile_schematic(&invalid_wire),
            Err(CompilationError::UnknownTerminal { .. })
        ));
    }

    #[test]
    fn reports_disconnected_terminals_and_floating_dc_islands() {
        let mut disconnected = divider();
        disconnected.wires.retain(|wire| wire.id != "w2");
        assert_eq!(
            compile_schematic(&disconnected),
            Err(CompilationError::DisconnectedTerminal {
                node_id: "r1".to_string(),
                handle_id: "terminal-b".to_string(),
            })
        );

        let mut floating = divider();
        floating.nodes.push(node(
            "isolated",
            SchematicComponentKind::Resistor,
            Some(electrical(Some(1_000.0), None)),
        ));
        floating.wires.push(wire(
            "isolated-loop",
            "isolated",
            "terminal-a",
            "isolated",
            "terminal-b",
        ));
        assert_eq!(
            compile_schematic(&floating),
            Err(CompilationError::FloatingDcIsland {
                node_ids: vec!["isolated".to_string()],
            })
        );
    }

    #[test]
    fn rejects_invalid_parallel_ideal_voltage_sources() {
        let mut invalid = divider();
        invalid.wires.push(wire(
            "source-short",
            "source",
            "positive",
            "ground",
            "terminal",
        ));
        assert_eq!(
            compile_schematic(&invalid),
            Err(CompilationError::InvalidIdealVoltageSource {
                node_id: "source".to_string(),
            })
        );

        let mut parallel = divider();
        parallel.nodes.push(node(
            "source2",
            SchematicComponentKind::VoltageSource,
            Some(electrical(None, Some(5.0))),
        ));
        parallel.wires.extend([
            wire(
                "source2-positive",
                "source2",
                "positive",
                "r1",
                "terminal-a",
            ),
            wire(
                "source2-negative",
                "source2",
                "negative",
                "ground",
                "terminal",
            ),
        ]);
        assert_eq!(
            compile_schematic(&parallel),
            Err(CompilationError::ConflictingIdealVoltageSources {
                first_node_id: "source".to_string(),
                second_node_id: "source2".to_string(),
            })
        );

        parallel.nodes.last_mut().unwrap().electrical = Some(electrical(None, Some(10.0)));
        assert_eq!(
            compile_schematic(&parallel),
            Err(CompilationError::RedundantIdealVoltageSources {
                first_node_id: "source".to_string(),
                second_node_id: "source2".to_string(),
            })
        );

        let mut looped = SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![
                node(
                    "s1",
                    SchematicComponentKind::VoltageSource,
                    Some(electrical(None, Some(10.0))),
                ),
                node(
                    "s2",
                    SchematicComponentKind::VoltageSource,
                    Some(electrical(None, Some(4.0))),
                ),
                node(
                    "s3",
                    SchematicComponentKind::VoltageSource,
                    Some(electrical(None, Some(5.0))),
                ),
                node("ground", SchematicComponentKind::Ground, None),
            ],
            wires: vec![
                wire("net-a", "s1", "positive", "s2", "positive"),
                wire("net-b", "s2", "negative", "s3", "positive"),
                wire("s1-ground", "s1", "negative", "ground", "terminal"),
                wire("s3-ground", "s3", "negative", "ground", "terminal"),
            ],
            simulation: None,
        };
        assert_eq!(
            compile_schematic(&looped),
            Err(CompilationError::ConflictingIdealVoltageSources {
                first_node_id: "s2".to_string(),
                second_node_id: "s3".to_string(),
            })
        );

        looped.nodes[2].electrical = Some(electrical(None, Some(6.0)));
        assert_eq!(
            compile_schematic(&looped),
            Err(CompilationError::RedundantIdealVoltageSources {
                first_node_id: "s2".to_string(),
                second_node_id: "s3".to_string(),
            })
        );
    }

    #[test]
    fn rejects_schematics_above_the_bounded_dc_baseline() {
        let document = SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: (0..=MAX_SCHEMATIC_COMPONENTS)
                .map(|index| {
                    node(
                        &format!("ground-{index}"),
                        SchematicComponentKind::Ground,
                        None,
                    )
                })
                .collect(),
            wires: vec![],
            simulation: None,
        };
        assert_eq!(
            compile_schematic(&document),
            Err(CompilationError::OversizedCircuit {
                components: MAX_SCHEMATIC_COMPONENTS + 1,
                wires: 0,
                probes: 0,
                max_components: MAX_SCHEMATIC_COMPONENTS,
                max_wires: MAX_SCHEMATIC_WIRES,
                max_probes: MAX_SCHEMATIC_PROBES,
            })
        );
    }

    #[test]
    fn compiles_supported_reactive_switch_and_diode_components() {
        let document = SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![
                node(
                    "c1",
                    SchematicComponentKind::Capacitor,
                    Some(SchematicElectricalParameters {
                        capacitance_farads: Some(1e-6),
                        ..Default::default()
                    }),
                ),
                node(
                    "l1",
                    SchematicComponentKind::Inductor,
                    Some(SchematicElectricalParameters {
                        inductance_henries: Some(1e-3),
                        ..Default::default()
                    }),
                ),
                node(
                    "s1",
                    SchematicComponentKind::Switch,
                    Some(SchematicElectricalParameters {
                        switch_closed: Some(true),
                        ..Default::default()
                    }),
                ),
                node(
                    "d1",
                    SchematicComponentKind::Diode,
                    Some(SchematicElectricalParameters {
                        model_ref: Some("builtin:diode".to_string()),
                        ..Default::default()
                    }),
                ),
                node(
                    "led1",
                    SchematicComponentKind::Led,
                    Some(SchematicElectricalParameters {
                        model_ref: Some("builtin:led".to_string()),
                        ..Default::default()
                    }),
                ),
                node(
                    "q1",
                    SchematicComponentKind::Transistor,
                    Some(SchematicElectricalParameters {
                        model_ref: Some("builtin:npn".to_string()),
                        ..Default::default()
                    }),
                ),
                node("ground", SchematicComponentKind::Ground, None),
            ],
            wires: vec![
                wire("c1-a", "c1", "terminal-a", "ground", "terminal"),
                wire("c1-b", "c1", "terminal-b", "ground", "terminal"),
                wire("l1-a", "l1", "terminal-a", "ground", "terminal"),
                wire("l1-b", "l1", "terminal-b", "ground", "terminal"),
                wire("s1-a", "s1", "terminal-a", "ground", "terminal"),
                wire("s1-b", "s1", "terminal-b", "ground", "terminal"),
                wire("d1-a", "d1", "anode", "ground", "terminal"),
                wire("d1-c", "d1", "cathode", "ground", "terminal"),
                wire("led1-a", "led1", "anode", "ground", "terminal"),
                wire("led1-c", "led1", "cathode", "ground", "terminal"),
                wire("q1-b", "q1", "base", "ground", "terminal"),
                wire("q1-c", "q1", "collector", "ground", "terminal"),
                wire("q1-e", "q1", "emitter", "ground", "terminal"),
            ],
            simulation: None,
        };

        let compiled = compile_schematic(&document).unwrap();
        assert!(matches!(
            compiled.circuit.components[0],
            Component::Capacitor { .. }
        ));
        assert!(matches!(
            compiled.circuit.components[1],
            Component::Diode { .. }
        ));
        assert!(matches!(
            compiled.circuit.components[2],
            Component::Inductor { .. }
        ));
        assert!(matches!(
            compiled.circuit.components[3],
            Component::Diode { .. }
        ));
        assert!(matches!(
            compiled.circuit.components[4],
            Component::BipolarNpn { .. }
        ));
        assert!(matches!(
            compiled.circuit.components[5],
            Component::Switch { .. }
        ));
    }

    #[test]
    fn rejects_unsupported_models_and_multiple_grounds() {
        let unsupported_model = SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![
                node(
                    "q1",
                    SchematicComponentKind::Transistor,
                    Some(SchematicElectricalParameters {
                        model_ref: Some("custom:npn".to_string()),
                        ..Default::default()
                    }),
                ),
                node("ground", SchematicComponentKind::Ground, None),
            ],
            wires: vec![],
            simulation: None,
        };
        assert!(matches!(
            compile_schematic(&unsupported_model),
            Err(CompilationError::UnsupportedModel { .. })
        ));

        let multiple_grounds = SchematicDocument {
            diagram_mode: DiagramMode::Schematic,
            nodes: vec![
                node("ground-a", SchematicComponentKind::Ground, None),
                node("ground-b", SchematicComponentKind::Ground, None),
            ],
            wires: vec![],
            simulation: None,
        };
        assert_eq!(
            compile_schematic(&multiple_grounds),
            Err(CompilationError::MultipleGrounds { count: 2 })
        );
    }
}
