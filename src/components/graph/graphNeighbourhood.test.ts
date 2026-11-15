import { describe, expect, it } from 'vitest';

import { type GraphLink, graphNeighbourhood, type GraphNode } from './graphData';

const node = (id: string): GraphNode => ({
  id,
  title: id,
  relativePath: id,
  tags: [],
  linkCount: 0,
});
const link = (source: string, target: string): GraphLink => ({ source, target });

const graph = {
  nodes: ['a', 'b', 'c', 'd', 'e'].map(node),
  // a → b → c, d → a, e is isolated
  links: [link('a', 'b'), link('b', 'c'), link('d', 'a')],
};

describe('graphNeighbourhood', () => {
  it('keeps notes linked in either direction, one step out', () => {
    const result = graphNeighbourhood(graph, 'a');
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'd']);
    expect(result.links).toHaveLength(2);
  });

  it('follows further steps when asked', () => {
    const result = graphNeighbourhood(graph, 'a', 2);
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(result.links).toHaveLength(3);
  });

  it('handles links whose endpoints are already resolved to nodes', () => {
    const resolved = {
      nodes: graph.nodes,
      links: [{ source: graph.nodes[0], target: graph.nodes[1] }],
    };
    expect(
      graphNeighbourhood(resolved, 'b')
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('is empty for a note that is not in the graph', () => {
    expect(graphNeighbourhood(graph, 'missing')).toEqual({ nodes: [], links: [] });
  });
});
