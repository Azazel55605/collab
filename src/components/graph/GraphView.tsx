import { useEffect, useId, useMemo, useRef, useState } from 'react';

import * as d3 from 'd3';
import { Search, X } from 'lucide-react';

import type { NoteMetadata } from '../../types/note';
import { FloatingBar, ZoomPill } from '../layout/CanvasChrome';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

import {
  createGraphDataBuilder,
  GRAPH_LINK_LIMIT,
  type GraphLink,
  graphNeighbourhood,
  type GraphNode,
} from './graphData';
import type { GraphLayoutRequest } from './graphLayout.worker';

export { buildGraphData } from './graphData';
interface GraphViewProps {
  notes: NoteMetadata[];
  onNodeClick: (path: string, title: string) => void;
  /** Show only this note and the notes linked to it. */
  focusPath?: string | null;
  /**
   * When set, clicking a node opens a small card (Open / Show neighbours)
   * instead of opening the note straight away.
   */
  onFocus?: (path: string) => void;
}
type Position = { id: string; x: number; y: number };

export default function GraphView({ notes, onNodeClick, focusPath, onFocus }: GraphViewProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const callback = useRef(onNodeClick);
  callback.current = onNodeClick;
  const [builder] = useState(createGraphDataBuilder);
  const fullGraph = useMemo(() => builder(notes), [builder, notes]);
  const graph = useMemo(
    () => (focusPath ? graphNeighbourhood(fullGraph, focusPath) : fullGraph),
    [focusPath, fullGraph],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState<{ node: GraphNode; x: number; y: number } | null>(null);
  const cardEnabled = useRef(Boolean(onFocus));
  cardEnabled.current = Boolean(onFocus);
  const [search, setSearch] = useState('');
  const [zoomPercent, setZoomPercent] = useState(100);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
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
      .on('end', () => {
        detail();
        setZoomPercent(Math.round(scale * 100));
      });
    svg.call(zoom);
    zoomRef.current = zoom;
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
      const open = (node: GraphNode, at?: { clientX: number; clientY: number }) => {
        selected.current = node.id;
        nodesLayer
          .selectAll('circle')
          .attr('stroke-width', (d) => ((d as GraphNode).id === node.id ? 4 : 1));
        const container = containerRef.current;
        if (cardEnabled.current && container) {
          const bounds = container.getBoundingClientRect();
          setCard({
            node,
            x: at ? at.clientX - bounds.left : bounds.width / 2,
            y: at ? at.clientY - bounds.top : bounds.height / 2,
          });
          return;
        }
        callback.current(node.relativePath, node.title);
      };
      node
        .on('click', (event: MouseEvent, node) => open(node, event))
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
      zoomRef.current = null;
      group.remove();
      defs.remove();
      update.current = () => {};
    };
  }, [marker, attempt]);
  useEffect(() => {
    update.current();
    setCard(null);
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
  const zoomBy = (factor: number) => {
    const element = svgRef.current;
    if (!element || !zoomRef.current) return;
    d3.select(element).call(zoomRef.current.scaleBy, factor);
  };
  const resetZoom = () => {
    const element = svgRef.current;
    if (!element || !zoomRef.current) return;
    d3.select(element).call(zoomRef.current.transform, d3.zoomIdentity);
  };
  return (
    <div
      ref={containerRef}
      className="relative h-full w-full bg-background"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setCard(null);
      }}
    >
      <FloatingBar
        role="search"
        aria-label="Filter graph"
        className="top-3 left-3 z-10 gap-2 pr-2.5"
      >
        <Search className="ml-1.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Input
          aria-label="Filter graph nodes"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Filter notes…"
          className="h-8 w-56 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
        <span
          title={`Showing up to 500 notes and ${GRAPH_LINK_LIMIT} links`}
          className="text-xs whitespace-nowrap text-muted-foreground"
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
      </FloatingBar>
      {!graph.nodes.length && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          No notes found. Create some notes to see the graph.
        </p>
      )}
      <svg
        ref={svgRef}
        role="group"
        aria-label="Note graph"
        className="h-full w-full"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) setCard(null);
        }}
      />
      {card && (
        <div
          role="dialog"
          aria-label={card.node.title}
          className="absolute z-20 flex w-60 flex-col gap-1 rounded-xl border border-border/70 bg-popover/95 p-3 text-popover-foreground shadow-lg"
          style={{
            left: Math.max(
              8,
              Math.min(card.x + 12, (containerRef.current?.clientWidth ?? 0) - 248),
            ),
            top: Math.max(
              8,
              Math.min(card.y + 12, (containerRef.current?.clientHeight ?? 0) - 140),
            ),
          }}
        >
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">{card.node.title}</p>
            <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={() => setCard(null)}>
              <X />
            </Button>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {card.node.relativePath} · {card.node.linkCount}{' '}
            {card.node.linkCount === 1 ? 'link' : 'links'}
          </p>
          <div className="mt-2 flex gap-1.5">
            <Button
              size="sm"
              onClick={() => {
                setCard(null);
                callback.current(card.node.relativePath, card.node.title);
              }}
            >
              Open
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCard(null);
                onFocus?.(card.node.relativePath);
              }}
            >
              Show neighbours
            </Button>
          </div>
        </div>
      )}
      {graph.nodes.length > 0 && (
        <ZoomPill
          label={`${zoomPercent}%`}
          onZoomOut={() => zoomBy(1 / 1.25)}
          onZoomIn={() => zoomBy(1.25)}
          onReset={resetZoom}
          className="z-10"
        />
      )}
    </div>
  );
}
