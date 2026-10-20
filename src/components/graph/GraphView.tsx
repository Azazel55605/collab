import { useEffect, useId, useMemo, useRef, useState } from 'react';

import * as d3 from 'd3';

import type { NoteMetadata } from '../../types/note';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

import {
  createGraphDataBuilder,
  GRAPH_LINK_LIMIT,
  type GraphLink,
  type GraphNode,
} from './graphData';
import type { GraphLayoutRequest } from './graphLayout.worker';

export { buildGraphData } from './graphData';
interface GraphViewProps {
  notes: NoteMetadata[];
  onNodeClick: (path: string, title: string) => void;
}
type Position = { id: string; x: number; y: number };

export default function GraphView({ notes, onNodeClick }: GraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const callback = useRef(onNodeClick);
  callback.current = onNodeClick;
  const [builder] = useState(createGraphDataBuilder);
  const graph = useMemo(() => builder(notes), [builder, notes]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const marker = useId().replace(/:/g, '');
  const worker = useRef<Worker | null>(null);
  const generation = useRef(0);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const update = useRef<() => void>(() => {});
  const positions = useRef(new Map<string, Position>());
  const selected = useRef<string | null>(null);

  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const svg = d3.select(element);
    const group = svg.append('g').attr('transform', d3.zoomTransform(element).toString());
    const linksLayer = group.append('g');
    const nodesLayer = group.append('g');
    const defs = svg.append('defs');
    defs
      .append('marker')
      .attr('id', marker)
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 18)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-5L10,0L0,5')
      .attr('fill', 'var(--muted-foreground)');
    let frame: number | null = null;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let scale = 1;
    const draw = () => {
      frame = null;
      nodesLayer.selectAll<SVGGElement, GraphNode>('g').attr('transform', (node) => {
        const point = positions.current.get(node.id);
        return `translate(${point?.x ?? 0},${point?.y ?? 0})`;
      });
      linksLayer.selectAll<SVGLineElement, GraphLink>('line').each(function (link) {
        const source = positions.current.get(String(link.source));
        const target = positions.current.get(String(link.target));
        d3.select(this)
          .attr('x1', source?.x ?? 0)
          .attr('y1', source?.y ?? 0)
          .attr('x2', target?.x ?? 0)
          .attr('y2', target?.y ?? 0);
      });
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(draw);
    };
    const detail = (interacting = false) => {
      nodesLayer
        .selectAll('text')
        .attr(
          'display',
          interacting || (graphRef.current.nodes.length > 120 && scale < 1.15) ? 'none' : null,
        );
      linksLayer.selectAll('line').attr('marker-end', interacting ? null : `url(#${marker})`);
    };
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('start', () => detail(true))
      .on('zoom', (event) => {
        scale = event.transform.k;
        group.attr('transform', event.transform.toString());
      })
      .on('end', () => detail());
    svg.call(zoom);
    const send = (request: GraphLayoutRequest) => worker.current?.postMessage(request);
    const visibility = () =>
      send({ kind: 'visibility', hidden: document.visibilityState === 'hidden' });
    const size = () => ({ width: element.clientWidth || 800, height: element.clientHeight || 600 });
    const fail = (message: string) => {
      clearTimeout(watchdog);
      worker.current?.terminate();
      worker.current = null;
      if (!disposed) setError(message);
    };
    try {
      worker.current = new Worker(new URL('./graphLayout.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.current.onmessage = (event) => {
        if (disposed || event.data.generation !== generation.current) return;
        clearTimeout(watchdog);
        if (event.data.error) {
          fail(event.data.error);
          return;
        }
        setError(null);
        positions.current = new Map(
          (event.data.positions as Position[]).map((point) => [point.id, point]),
        );
        schedule();
      };
      worker.current.onerror = () => fail('Graph layout failed. Retry to restart it.');
      worker.current.onmessageerror = () => fail('Graph layout returned an unreadable result.');
    } catch {
      fail('Graph layout workers are unavailable. Retry to restart it.');
    }
    update.current = () => {
      const { nodes, links } = graphRef.current;
      const surviving = new Set(nodes.map((node) => node.id));
      for (const id of positions.current.keys())
        if (!surviving.has(id)) positions.current.delete(id);
      if (selected.current && !surviving.has(selected.current)) selected.current = null;
      linksLayer
        .selectAll<SVGLineElement, GraphLink>('line')
        .data(links, (link) => `${link.source}->${link.target}`)
        .join('line')
        .attr('stroke', 'var(--muted-foreground)')
        .attr('stroke-opacity', 0.45)
        .attr('stroke-width', 1);
      const node = nodesLayer
        .selectAll<SVGGElement, GraphNode>('g')
        .data(nodes, (node) => node.id)
        .join((enter) => {
          const group = enter.append('g');
          group.append('circle');
          group.append('text');
          return group;
        })
        .attr('role', 'button')
        .attr('tabindex', 0)
        .attr('aria-label', (node) => node.title)
        .attr('data-path', (node) => node.id)
        .attr('cursor', 'pointer');
      const open = (node: GraphNode) => {
        selected.current = node.id;
        nodesLayer
          .selectAll('circle')
          .attr('stroke-width', (d) => ((d as GraphNode).id === node.id ? 4 : 1));
        callback.current(node.relativePath, node.title);
      };
      node
        .on('click', (_, node) => open(node))
        .on('keydown', (event, node) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open(node);
          }
        });
      node
        .select('circle')
        .attr('r', (node) => 5 + Math.sqrt(Math.min(20, node.linkCount) / 20) * 11)
        .attr('fill', 'var(--primary)')
        .attr('fill-opacity', (node) => (node.tags.length ? 0.95 : 0.72))
        .attr('stroke', 'var(--foreground)')
        .attr('stroke-width', (node) => (selected.current === node.id ? 4 : 1));
      node
        .select('text')
        .text((node) => (node.title.length > 20 ? `${node.title.slice(0, 17)}…` : node.title))
        .attr('x', 22)
        .attr('y', 4)
        .attr('font-size', 11)
        .attr('fill', 'var(--muted-foreground)')
        .attr('pointer-events', 'none');
      node.call(
        d3
          .drag<SVGGElement, GraphNode>()
          .subject((event, node) => ({
            ...node,
            x: positions.current.get(node.id)?.x ?? event.x,
            y: positions.current.get(node.id)?.y ?? event.y,
          }))
          .on('start', () => detail(true))
          .on('drag', (event, node) => {
            positions.current.set(node.id, { id: node.id, x: event.x, y: event.y });
            schedule();
            send({ kind: 'pin', id: node.id, x: event.x, y: event.y });
          })
          .on('end', (_, node) => {
            send({ kind: 'pin', id: node.id, x: null, y: null });
            detail();
          }),
      );
      detail();
      schedule();
      generation.current++;
      if (worker.current) {
        send({ kind: 'update', generation: generation.current, nodes, links, ...size() });
        clearTimeout(watchdog);
        watchdog = setTimeout(() => fail('Graph layout timed out. Retry to restart it.'), 8000);
      }
    };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    const observer = new ResizeObserver(() => send({ kind: 'resize', ...size() }));
    observer.observe(element);
    update.current();
    return () => {
      disposed = true;
      clearTimeout(watchdog);
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      worker.current?.terminate();
      worker.current = null;
      svg.on('.zoom', null);
      group.remove();
      defs.remove();
      update.current = () => {};
    };
  }, [marker, attempt]);
  useEffect(() => {
    update.current();
  }, [graph]);
  useEffect(() => {
    const query = search.trim().toLowerCase();
    d3.select(svgRef.current)
      .selectAll<SVGGElement, GraphNode>('g[role="button"]')
      .attr('opacity', (node) =>
        !query ||
        `${node.title} ${node.relativePath} ${node.tags.join(' ')}`.toLowerCase().includes(query)
          ? 1
          : 0.12,
      );
  }, [search, graph]);
  return (
    <div className="relative h-full w-full bg-background">
      <div className="absolute left-4 top-4 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-background/95 px-2.5 py-2">
        <Input
          aria-label="Filter graph nodes"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter nodes…"
          className="w-56"
        />
        <span
          title={`Showing up to 500 notes and ${GRAPH_LINK_LIMIT} links`}
          className="text-xs text-muted-foreground"
        >
          {graph.nodes.length} of {notes.length} notes · {graph.links.length} links
        </span>
        {error && (
          <>
            <span role="alert" className="text-xs text-destructive">
              {error}
            </span>
            <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              Retry
            </Button>
          </>
        )}
      </div>
      {!graph.nodes.length && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          No notes found. Create some notes to see the graph.
        </p>
      )}
      <svg ref={svgRef} role="group" aria-label="Note graph" className="h-full w-full" />
    </div>
  );
}
