/// <reference lib="webworker" />
import * as d3 from 'd3';

import type { GraphLink, GraphNode } from './graphData';

export type GraphLayoutRequest =
  | {
      kind: 'update';
      generation: number;
      nodes: GraphNode[];
      links: GraphLink[];
      width: number;
      height: number;
    }
  | { kind: 'pin'; id: string; x: number | null; y: number | null }
  | { kind: 'resize'; width: number; height: number }
  | { kind: 'visibility'; hidden: boolean };
let generation = 0;
let hidden = false;
let lastPublish = 0;
let topology = '';
let positions = new Map<string, GraphNode>();
const simulation = d3
  .forceSimulation<GraphNode>()
  .stop()
  .alphaDecay(0.08)
  .velocityDecay(0.45)
  .force('charge', d3.forceManyBody().strength(-150))
  .force(
    'collision',
    d3
      .forceCollide<GraphNode>()
      .radius((node) => Math.min(16, 5 + Math.sqrt(node.linkCount / 20) * 11) + 8),
  );
function publish() {
  lastPublish = performance.now();
  self.postMessage({
    generation,
    positions: simulation.nodes().map((node) => ({ id: node.id, x: node.x, y: node.y })),
  });
}
simulation
  .on('tick', () => {
    if (performance.now() - lastPublish >= 32) publish();
  })
  .on('end', publish);
self.onmessage = (event: MessageEvent<GraphLayoutRequest>) => {
  try {
    const request = event.data;
    if (request.kind === 'update') {
      if (request.nodes.length > 500 || request.links.length > 5000)
        throw new Error('Graph exceeds its layout budget.');
      generation = request.generation;
      const nextTopology = JSON.stringify([
        request.nodes.map((node) => [node.id, node.linkCount]),
        request.links,
      ]);
      if (nextTopology === topology) {
        publish();
        return;
      }
      topology = nextTopology;
      const nodes = request.nodes.map((node) => Object.assign(positions.get(node.id) ?? {}, node));
      positions = new Map(nodes.map((node) => [node.id, node]));
      simulation
        .nodes(nodes)
        .force(
          'link',
          d3
            .forceLink<GraphNode, GraphLink>(request.links)
            .id((node) => node.id)
            .distance(80),
        )
        .force('center', d3.forceCenter(request.width / 2, request.height / 2))
        .alpha(0.7);
      if (!hidden) simulation.restart();
      publish();
    } else if (request.kind === 'pin') {
      const node = positions.get(request.id);
      if (!node) return;
      node.fx = request.x;
      node.fy = request.y;
      simulation.alpha(0.3);
      if (!hidden) simulation.restart();
    } else if (request.kind === 'resize') {
      simulation.force('center', d3.forceCenter(request.width / 2, request.height / 2)).alpha(0.2);
      if (!hidden) simulation.restart();
    } else {
      hidden = request.hidden;
      if (hidden) simulation.stop();
      else if (simulation.alpha() > simulation.alphaMin()) simulation.restart();
    }
  } catch (error) {
    self.postMessage({ generation, error: error instanceof Error ? error.message : String(error) });
    simulation.stop();
  }
};
