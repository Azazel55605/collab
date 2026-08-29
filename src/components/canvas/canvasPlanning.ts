import type {
  CanvasEdge,
  CanvasNode,
  CanvasNodeType,
  CanvasPlanningMetadata,
  CanvasSwimlaneOrientation,
  PlanningCanvasNode,
} from '../../types/canvas';

export type CanvasPlanningPreset =
  | 'flowchart'
  | 'project_workflow'
  | 'responsibility_lanes'
  | 'decision_tree'
  | 'system_process_sketch';

export const PLANNING_NODE_TYPES = [
  'process',
  'decision',
  'terminator',
  'document',
  'milestone',
  'actor',
  'group',
  'swimlane',
  'junction',
  'crossing',
] as const satisfies CanvasNodeType[];

export function isPlanningNodeType(type: CanvasNodeType): type is PlanningCanvasNode['type'] {
  return (PLANNING_NODE_TYPES as readonly string[]).includes(type);
}

export function isPlanningNode(node: CanvasNode): node is PlanningCanvasNode {
  return isPlanningNodeType(node.type);
}

export function getPlanningNodeLabel(type: PlanningCanvasNode['type']) {
  switch (type) {
    case 'process':
      return 'Process';
    case 'decision':
      return 'Decision';
    case 'terminator':
      return 'Start / End';
    case 'document':
      return 'Document';
    case 'milestone':
      return 'Milestone';
    case 'actor':
      return 'Actor';
    case 'group':
      return 'Group';
    case 'swimlane':
      return 'Swimlane';
    case 'junction':
      return 'Junction';
    case 'crossing':
      return 'Crossing';
  }
}

export function getPlanningNodeDefaults(type: PlanningCanvasNode['type']): Pick<
  PlanningCanvasNode,
  'title' | 'body' | 'width' | 'height'
> & {
  orientation?: CanvasSwimlaneOrientation;
  planning?: CanvasPlanningMetadata;
} {
  switch (type) {
    case 'process':
      return {
        title: 'Process step',
        body: 'Describe the action or workflow step.',
        width: 280,
        height: 160,
      };
    case 'decision':
      return {
        title: 'Decision',
        body: 'Capture the branch condition or if/else check.',
        width: 280,
        height: 180,
      };
    case 'terminator':
      return {
        title: 'Start',
        body: 'Entry or exit point for this flow.',
        width: 240,
        height: 120,
      };
    case 'document':
      return {
        title: 'Reference document',
        body: 'Outline what this artifact is for.',
        width: 280,
        height: 170,
      };
    case 'milestone':
      return {
        title: 'Milestone',
        body: 'Key checkpoint or delivery target.',
        width: 260,
        height: 150,
        planning: { status: 'not_started' },
      };
    case 'actor':
      return {
        title: 'Owner / Actor',
        body: 'Person, team, or system responsible here.',
        width: 260,
        height: 150,
      };
    case 'group':
      return { title: 'Group', body: 'Cluster related work or context.', width: 420, height: 260 };
    case 'swimlane':
      return {
        title: 'Swimlane',
        body: 'Phase or owner lane.',
        width: 520,
        height: 260,
        orientation: 'horizontal',
      };
    case 'junction':
      return { title: 'Junction', body: '', width: 90, height: 90 };
    case 'crossing':
      return { title: 'Crossing', body: '', width: 110, height: 70 };
  }
}

function createNode(
  id: string,
  type: PlanningCanvasNode['type'],
  x: number,
  y: number,
  overrides?: Partial<PlanningCanvasNode>,
): PlanningCanvasNode {
  const defaults = getPlanningNodeDefaults(type);
  return {
    id,
    type,
    position: { x, y },
    width: defaults.width,
    height: defaults.height,
    title: defaults.title,
    body: defaults.body,
    planning: defaults.planning,
    ...(defaults.orientation ? { orientation: defaults.orientation } : {}),
    ...overrides,
  } as PlanningCanvasNode;
}

export function buildPlanningPreset(
  preset: CanvasPlanningPreset,
  center: { x: number; y: number },
): { nodes: PlanningCanvasNode[]; edges: CanvasEdge[] } {
  const makeId = () => crypto.randomUUID();
  switch (preset) {
    case 'flowchart': {
      const start = createNode(makeId(), 'terminator', center.x - 340, center.y - 60, {
        title: 'Start',
      });
      const process = createNode(makeId(), 'process', center.x - 40, center.y - 60, {
        title: 'Capture input',
      });
      const decision = createNode(makeId(), 'decision', center.x + 260, center.y - 60, {
        title: 'Valid?',
      });
      const end = createNode(makeId(), 'terminator', center.x + 560, center.y - 60, {
        title: 'Finish',
      });
      return {
        nodes: [start, process, decision, end],
        edges: [
          {
            id: makeId(),
            source: start.id,
            target: process.id,
            markerEnd: true,
            routingStyle: 'orthogonal',
          },
          {
            id: makeId(),
            source: process.id,
            target: decision.id,
            markerEnd: true,
            routingStyle: 'orthogonal',
          },
          {
            id: makeId(),
            source: decision.id,
            target: end.id,
            markerEnd: true,
            label: 'Yes',
            routingStyle: 'orthogonal',
          },
        ],
      };
    }
    case 'project_workflow': {
      const brief = createNode(makeId(), 'process', center.x - 320, center.y - 40, {
        title: 'Define scope',
        planning: { status: 'in_progress', priority: 'high', ownerLabel: 'PM' },
      });
      const milestone = createNode(makeId(), 'milestone', center.x - 10, center.y - 50, {
        title: 'Kickoff',
        planning: { milestoneLabel: 'M1', dueDate: '2026-05-15' },
      });
      const execution = createNode(makeId(), 'process', center.x + 280, center.y - 40, {
        title: 'Execute plan',
        planning: { status: 'not_started', ownerLabel: 'Team' },
      });
      return {
        nodes: [brief, milestone, execution],
        edges: [
          {
            id: makeId(),
            source: brief.id,
            target: milestone.id,
            markerEnd: true,
            routingStyle: 'curved',
          },
          {
            id: makeId(),
            source: milestone.id,
            target: execution.id,
            markerEnd: true,
            routingStyle: 'curved',
          },
        ],
      };
    }
    case 'responsibility_lanes': {
      const laneA = createNode(makeId(), 'swimlane', center.x - 360, center.y - 190, {
        title: 'Product',
        orientation: 'horizontal',
        width: 760,
        height: 160,
      });
      const laneB = createNode(makeId(), 'swimlane', center.x - 360, center.y + 20, {
        title: 'Engineering',
        orientation: 'horizontal',
        width: 760,
        height: 160,
      });
      const actor = createNode(makeId(), 'actor', center.x - 280, center.y - 150, { title: 'PM' });
      const process = createNode(makeId(), 'process', center.x - 10, center.y + 55, {
        title: 'Build feature',
      });
      return { nodes: [laneA, laneB, actor, process], edges: [] };
    }
    case 'decision_tree': {
      const root = createNode(makeId(), 'decision', center.x - 40, center.y - 40, {
        title: 'Choose path',
      });
      const left = createNode(makeId(), 'process', center.x - 340, center.y + 180, {
        title: 'Option A',
      });
      const right = createNode(makeId(), 'process', center.x + 260, center.y + 180, {
        title: 'Option B',
      });
      return {
        nodes: [root, left, right],
        edges: [
          {
            id: makeId(),
            source: root.id,
            target: left.id,
            markerEnd: true,
            label: 'Yes',
            routingStyle: 'orthogonal',
          },
          {
            id: makeId(),
            source: root.id,
            target: right.id,
            markerEnd: true,
            label: 'No',
            routingStyle: 'orthogonal',
          },
        ],
      };
    }
    case 'system_process_sketch': {
      const actor = createNode(makeId(), 'actor', center.x - 340, center.y - 30, { title: 'User' });
      const system = createNode(makeId(), 'process', center.x - 20, center.y - 30, {
        title: 'System action',
      });
      const doc = createNode(makeId(), 'document', center.x + 300, center.y - 30, {
        title: 'Generated artifact',
      });
      return {
        nodes: [actor, system, doc],
        edges: [
          {
            id: makeId(),
            source: actor.id,
            target: system.id,
            markerEnd: true,
            routingStyle: 'curved',
          },
          {
            id: makeId(),
            source: system.id,
            target: doc.id,
            markerEnd: true,
            routingStyle: 'curved',
          },
        ],
      };
    }
  }
}
