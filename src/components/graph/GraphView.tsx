import { useEffect, useMemo, useRef, useState } from 'react';

import * as d3 from 'd3';

import type { NoteMetadata } from '../../types/note';
import { Input } from '../ui/input';

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

const LABEL_ALWAYS_VISIBLE_NODE_LIMIT = 120;
const LABEL_DETAIL_SCALE_THRESHOLD = 1.15;
const GRAPH_COLORS = {
  emptyState: 'var(--muted-foreground)',
  linkStroke: 'color-mix(in oklch, var(--primary) 22%, var(--muted-foreground) 78%)',
  nodeFill: 'var(--primary)',
  taggedNodeFill: 'var(--primary)',
  nodeStroke: 'var(--primary)',
  labelFill: 'var(--muted-foreground)',
  nodeGlow: 'color-mix(in oklch, var(--primary) 26%, transparent)',
} as const;

function normalizeGraphLinkTarget(value: string) {
  return value.trim().split(/[?#]/, 1)[0]?.replace(/\\/g, '/').toLowerCase() ?? '';
}

function stripMarkdownExtension(relativePath: string) {
  return relativePath.replace(/\.md$/i, '');
}

function buildUniqueLookup(entries: Array<readonly [string, string]>) {
  const counts = new Map<string, { path: string; count: number }>();

  for (const [rawKey, path] of entries) {
    const key = normalizeGraphLinkTarget(rawKey);
    if (!key) continue;
    const existing = counts.get(key);
    if (!existing) {
      counts.set(key, { path, count: 1 });
      continue;
    }
    if (existing.path !== path) existing.count += 1;
  }

  return new Map(
    Array.from(counts.entries())
      .filter(([, value]) => value.count === 1)
      .map(([key, value]) => [key, value.path] as const),
  );
}

export function buildGraphData(notes: NoteMetadata[]) {
  const visibleNotes = notes.slice(0, 500);
  const exactRelativePathToPath = new Map<string, string>();
  const exactRelativeStemToPath = new Map<string, string>();

  for (const note of visibleNotes) {
    exactRelativePathToPath.set(normalizeGraphLinkTarget(note.relativePath), note.relativePath);
    exactRelativeStemToPath.set(
      normalizeGraphLinkTarget(stripMarkdownExtension(note.relativePath)),
      note.relativePath,
    );
  }

  const basenameToPath = buildUniqueLookup(
    visibleNotes.map(
      (note) => [note.relativePath.split('/').pop() ?? '', note.relativePath] as const,
    ),
  );
  const stemToPath = buildUniqueLookup(
    visibleNotes.map(
      (note) =>
        [
          stripMarkdownExtension(note.relativePath.split('/').pop() ?? ''),
          note.relativePath,
        ] as const,
    ),
  );
  const titleToPath = buildUniqueLookup(
    visibleNotes.map((note) => [note.title, note.relativePath] as const),
  );

  const nodes: GraphNode[] = visibleNotes.map((n) => ({
    id: n.relativePath,
    title: n.title,
    relativePath: n.relativePath,
    tags: n.tags,
    linkCount: n.wikilinksOut.length,
  }));

  const nodeIds = new Set(nodes.map((node) => node.id));
  const linkKeys = new Set<string>();
  const links: GraphLink[] = [];

  for (const note of visibleNotes) {
    for (const wikilink of note.wikilinksOut) {
      const normalizedTarget = normalizeGraphLinkTarget(wikilink);
      if (!normalizedTarget) continue;

      const targetPath =
        exactRelativePathToPath.get(normalizedTarget) ??
        exactRelativeStemToPath.get(normalizedTarget) ??
        basenameToPath.get(normalizedTarget) ??
        stemToPath.get(normalizedTarget) ??
        titleToPath.get(normalizedTarget);

      if (targetPath && targetPath !== note.relativePath && nodeIds.has(targetPath)) {
        const linkKey = `${note.relativePath}->${targetPath}`;
        if (linkKeys.has(linkKey)) continue;
        linkKeys.add(linkKey);
        links.push({ source: note.relativePath, target: targetPath });
      }
    }
  }

  return { nodes, links };
}

export default function GraphView({ notes, onNodeClick }: GraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const graphData = useMemo(() => buildGraphData(notes), [notes]);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();

    const { width, height } = svgRef.current.getBoundingClientRect();
    const { nodes, links } = graphData;

    if (nodes.length === 0) {
      svg
        .append('text')
        .attr('x', width / 2)
        .attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .style('fill', GRAPH_COLORS.emptyState)
        .attr('font-size', 14)
        .text('No notes found. Create some notes to see the graph.');
      return;
    }

    // Setup zoom
    const g = svg.append('g');
    const shouldAlwaysShowLabels = nodes.length <= LABEL_ALWAYS_VISIBLE_NODE_LIMIT;
    let currentScale = 1;

    const nodeRadius = d3.scaleSqrt().domain([0, 20]).range([5, 16]).clamp(true);

    const linkLayer = g.append('g');
    const nodeLayer = g.append('g');

    // Links
    const link = linkLayer
      .selectAll('line')
      .data(links)
      .join('line')
      .style('stroke', GRAPH_COLORS.linkStroke)
      .attr('stroke-opacity', links.length > 300 ? 0.5 : 0.8)
      .attr('stroke-width', links.length > 300 ? 0.8 : 1);

    const applyInteractionDetail = (interacting: boolean, scale = currentScale) => {
      const showLabels =
        !interacting && (shouldAlwaysShowLabels || scale >= LABEL_DETAIL_SCALE_THRESHOLD);
      label.attr('display', showLabels ? null : 'none');

      link.attr('marker-end', interacting ? null : 'url(#arrowhead)');
    };

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('start', () => applyInteractionDetail(true))
      .on('zoom', (event) => {
        currentScale = event.transform.k;
        g.attr('transform', event.transform);
      })
      .on('end', (event) => {
        currentScale = event.transform.k;
        applyInteractionDetail(false, currentScale);
      });
    svg.call(zoom);

    // Arrow marker
    svg
      .append('defs')
      .append('marker')
      .attr('id', 'arrowhead')
      .attr('viewBox', '-0 -5 10 10')
      .attr('refX', 10)
      .attr('refY', 0)
      .attr('orient', 'auto')
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .append('path')
      .attr('d', 'M 0,-5 L 10,0 L 0,5')
      .style('fill', GRAPH_COLORS.linkStroke);

    // Nodes
    const node = nodeLayer
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
      .attr('r', (d) => nodeRadius(d.linkCount))
      .style('fill', (d) =>
        d.tags.length > 0 ? GRAPH_COLORS.taggedNodeFill : GRAPH_COLORS.nodeFill,
      )
      .style('fill-opacity', (d) => (d.tags.length > 0 ? 0.95 : 0.72))
      .style('stroke', GRAPH_COLORS.nodeStroke)
      .style('stroke-opacity', 0.42)
      .style('filter', `drop-shadow(0 0 8px ${GRAPH_COLORS.nodeGlow})`)
      .attr('stroke-width', 4);

    const label = node
      .append('text')
      .text((d) => (d.title.length > 20 ? d.title.slice(0, 17) + '\u2026' : d.title))
      .attr('x', (d) => nodeRadius(d.linkCount) + 4)
      .attr('y', 4)
      .attr('font-size', 11)
      .style('fill', GRAPH_COLORS.labelFill)
      .attr('pointer-events', 'none');

    applyInteractionDetail(false);

    // Drag behaviour
    const drag = d3
      .drag<SVGGElement, GraphNode>()
      .on('start', (event, d) => {
        applyInteractionDetail(true);
        if (!event.active) simulation.alphaTarget(0.12).restart();
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
        applyInteractionDetail(false);
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node.call(drag as any);

    let frameId: number | null = null;
    const renderPositions = () => {
      frameId = null;
      link
        .attr('x1', (d) => {
          const source = d.source as GraphNode;
          const target = d.target as GraphNode;
          const sx = source.x ?? 0;
          const sy = source.y ?? 0;
          const tx = target.x ?? 0;
          const ty = target.y ?? 0;
          const dx = tx - sx;
          const dy = ty - sy;
          const distance = Math.hypot(dx, dy) || 1;
          const sourceOffset = nodeRadius(source.linkCount) + 2;
          return sx + (dx / distance) * sourceOffset;
        })
        .attr('y1', (d) => {
          const source = d.source as GraphNode;
          const target = d.target as GraphNode;
          const sx = source.x ?? 0;
          const sy = source.y ?? 0;
          const tx = target.x ?? 0;
          const ty = target.y ?? 0;
          const dx = tx - sx;
          const dy = ty - sy;
          const distance = Math.hypot(dx, dy) || 1;
          const sourceOffset = nodeRadius(source.linkCount) + 2;
          return sy + (dy / distance) * sourceOffset;
        })
        .attr('x2', (d) => {
          const source = d.source as GraphNode;
          const target = d.target as GraphNode;
          const sx = source.x ?? 0;
          const sy = source.y ?? 0;
          const tx = target.x ?? 0;
          const ty = target.y ?? 0;
          const dx = tx - sx;
          const dy = ty - sy;
          const distance = Math.hypot(dx, dy) || 1;
          const targetOffset = nodeRadius(target.linkCount) + 1;
          return tx - (dx / distance) * targetOffset;
        })
        .attr('y2', (d) => {
          const source = d.source as GraphNode;
          const target = d.target as GraphNode;
          const sx = source.x ?? 0;
          const sy = source.y ?? 0;
          const tx = target.x ?? 0;
          const ty = target.y ?? 0;
          const dx = tx - sx;
          const dy = ty - sy;
          const distance = Math.hypot(dx, dy) || 1;
          const targetOffset = nodeRadius(target.linkCount) + 1;
          return ty - (dy / distance) * targetOffset;
        });
      node.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    };

    const scheduleRender = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(renderPositions);
    };

    // Force simulation
    const simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .alphaDecay(0.08)
      .velocityDecay(0.45)
      .force(
        'link',
        d3
          .forceLink<GraphNode, GraphLink>(links)
          .id((d) => d.id)
          .distance(80),
      )
      .force('charge', d3.forceManyBody().strength(-150))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force(
        'collision',
        d3.forceCollide<GraphNode>().radius((d) => nodeRadius(d.linkCount) + 8),
      )
      .on('tick', scheduleRender);

    scheduleRender();

    simulationRef.current = simulation;

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      simulation.stop();
    };
  }, [graphData, onNodeClick]);

  // Suppress unused-variable warning for selectedNode — kept for future highlight logic
  void selectedNode;

  return (
    <div className="relative w-full h-full bg-background">
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2 rounded-xl border border-border/60 bg-background/88 px-2.5 py-2 shadow-lg shadow-black/5 backdrop-blur-xs-webkit app-panel-enter">
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter nodes..."
          className="w-56 bg-background/80"
        />
        <span className="rounded-md border border-border/50 bg-card/40 px-2 py-1 text-xs text-muted-foreground">
          {notes.length} notes
        </span>
      </div>
      <svg ref={svgRef} className="w-full h-full" />
    </div>
  );
}
