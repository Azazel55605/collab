import { useEffect, useRef, useState, useCallback } from 'react';
import * as d3 from 'd3';
import type { NoteMetadata } from '../../types/note';

interface GraphViewProps {
  notes: NoteMetadata[];
  onNodeClick: (relativePath: string, title: string) => void;
}

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  title: string;
  relativePath: string;
  tags: string[];
  linkCount: number;
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
}

export default function GraphView({ notes, onNodeClick }: GraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const buildGraph = useCallback(() => {
    const nameToPath = new Map<string, string>();
    for (const note of notes) {
      nameToPath.set(note.title.toLowerCase(), note.relativePath);
      const fname =
        note.relativePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
      nameToPath.set(fname.toLowerCase(), note.relativePath);
    }

    const nodes: GraphNode[] = notes.slice(0, 500).map((n) => ({
      id: n.relativePath,
      title: n.title,
      relativePath: n.relativePath,
      tags: n.tags,
      linkCount: n.wikilinksOut.length,
    }));

    const nodeIds = new Set(nodes.map((n) => n.id));
    const links: GraphLink[] = [];

    for (const note of notes.slice(0, 500)) {
      for (const wikilink of note.wikilinksOut) {
        const targetPath = nameToPath.get(wikilink.toLowerCase());
        if (
          targetPath &&
          targetPath !== note.relativePath &&
          nodeIds.has(targetPath)
        ) {
          links.push({ source: note.relativePath, target: targetPath });
        }
      }
    }

    return { nodes, links };
  }, [notes]);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const { width, height } = svgRef.current.getBoundingClientRect();
    const { nodes, links } = buildGraph();

    if (nodes.length === 0) {
      svg
        .append('text')
        .attr('x', width / 2)
        .attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', '#64748b')
        .attr('font-size', 14)
        .text('No notes found. Create some notes to see the graph.');
      return;
    }

    // Setup zoom
    const g = svg.append('g');
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (event) => g.attr('transform', event.transform));
    svg.call(zoom);

    // Arrow marker
    svg
      .append('defs')
      .append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '-0 -5 10 10')
      .attr('refX', 20)
      .attr('refY', 0)
      .attr('orient', 'auto')
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .append('path')
      .attr('d', 'M 0,-5 L 10,0 L 0,5')
      .attr('fill', '#334155');

    // Links
    const link = g
      .append('g')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', '#334155')
      .attr('stroke-width', 1)
      .attr('marker-end', 'url(#arrowhead)');

    // Node radius based on link count
    const radiusScale = d3
      .scaleSqrt()
      .domain([0, 20])
      .range([5, 16])
      .clamp(true);

    // Nodes
    const node = g
      .append('g')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .on('click', (_, d) => {
        setSelectedNode(d.id);
        onNodeClick(d.relativePath, d.title);
      });

    node
      .append('circle')
      .attr('r', (d) => radiusScale(d.linkCount))
      .attr('fill', (d) => (d.tags.length > 0 ? '#8b5cf6' : '#3b82f6'))
      .attr('stroke', '#1e293b')
      .attr('stroke-width', 2);

    node
      .append('text')
      .text((d) =>
        d.title.length > 20 ? d.title.slice(0, 17) + '\u2026' : d.title
      )
      .attr('x', (d) => radiusScale(d.linkCount) + 4)
      .attr('y', 4)
      .attr('font-size', 11)
      .attr('fill', '#94a3b8')
      .attr('pointer-events', 'none');

    // Drag behaviour
    const drag = d3
      .drag<SVGGElement, GraphNode>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node.call(drag as any);

    // Force simulation
    const simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .force(
        'link',
        d3
          .forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance(80)
      )
      .force('charge', d3.forceManyBody().strength(-150))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force(
        'collision',
        d3
          .forceCollide<GraphNode>()
          .radius((d) => radiusScale(d.linkCount) + 8)
      )
      .on('tick', () => {
        link
          .attr('x1', (d) => (d.source as GraphNode).x ?? 0)
          .attr('y1', (d) => (d.source as GraphNode).y ?? 0)
          .attr('x2', (d) => (d.target as GraphNode).x ?? 0)
          .attr('y2', (d) => (d.target as GraphNode).y ?? 0);
        node.attr(
          'transform',
          (d) => `translate(${d.x ?? 0},${d.y ?? 0})`
        );
      });

    simulationRef.current = simulation;

    return () => {
      simulation.stop();
    };
  }, [notes, buildGraph, onNodeClick]);

  // Suppress unused-variable warning for selectedNode — kept for future highlight logic
  void selectedNode;

  return (
    <div className="relative w-full h-full bg-background">
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2">
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter nodes..."
          className="h-8 px-3 text-sm rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground outline-none focus:ring-1 focus:ring-ring"
        />
        <span className="text-xs text-muted-foreground">
          {notes.length} notes
        </span>
      </div>
      <svg ref={svgRef} className="w-full h-full" />
    </div>
  );
}
