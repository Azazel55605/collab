import { useRef, useEffect, useState, useCallback, useLayoutEffect } from 'react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core';
import { GripVertical } from 'lucide-react';
import { useGridStore, selectActiveWorkspace, GRID_LAYOUTS, LAYOUT_ORDER, type GridLayoutId } from '../store/gridStore';
import { useUiStore } from '../store/uiStore';
import GridCell from '../components/grid/GridCell';
import GridLayoutPicker from '../components/grid/GridLayoutPicker';
import WorkspaceBar from '../components/grid/WorkspaceBar';

// ─── Layout fallback when container is too narrow ────────────────────────────
function resolveLayout(desiredId: GridLayoutId, containerWidth: number): GridLayoutId {
  const desired = GRID_LAYOUTS[desiredId];
  if (containerWidth >= desired.minWidth) return desiredId;
  let best: GridLayoutId = 'single';
  for (const id of LAYOUT_ORDER) {
    const l = GRID_LAYOUTS[id];
    if (containerWidth >= l.minWidth && l.cellCount <= desired.cellCount) best = id;
  }
  return best;
}

// ─── Drag ghost shown in DragOverlay ─────────────────────────────────────────
function DragGhost({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background/95 border border-primary/40 shadow-xl text-xs text-foreground backdrop-blur-sm-webkit">
      <GripVertical size={12} className="text-primary" />
      <span className="max-w-[180px] truncate">{title || 'Cell'}</span>
    </div>
  );
}

// ─── GridView ────────────────────────────────────────────────────────────────
export default function GridView() {
  const store = useGridStore();
  const { animationsEnabled, animationSpeed } = useUiStore();
  const activeWs = selectActiveWorkspace(store);

  const containerRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const layoutAnimationRef = useRef<{
    fromRects: Map<string, DOMRect>;
    targetLayout: GridLayoutId;
  } | null>(null);
  const [containerWidth, setContainerWidth] = useState(1000);

  // ── Smooth layout transition ──────────────────────────────────────────────
  const [fading, setFading] = useState(false);
  const [pendingLayout, setPendingLayout] = useState<GridLayoutId | null>(null);

  const getMotionDuration = useCallback(() => {
    if (!animationsEnabled) return 0;
    if (animationSpeed === 'slow') return 320;
    if (animationSpeed === 'fast') return 170;
    return 240;
  }, [animationsEnabled, animationSpeed]);

  const handleLayoutChange = useCallback((id: GridLayoutId) => {
    if (id === activeWs.layoutId) return;
    if (!animationsEnabled) {
      store.setLayout(id);
      return;
    }

    const currentLayout = GRID_LAYOUTS[resolveLayout(activeWs.layoutId, containerWidth)];
    const fromRects = new Map<string, DOMRect>();
    for (const cell of activeWs.cells.slice(0, currentLayout.cellCount)) {
      const node = cellRefs.current.get(cell.id);
      if (node) fromRects.set(cell.id, node.getBoundingClientRect());
    }

    layoutAnimationRef.current = { fromRects, targetLayout: id };
    setPendingLayout(id);
    setFading(true);
  }, [activeWs.cells, activeWs.layoutId, animationsEnabled, containerWidth, store]);

  useEffect(() => {
    if (!fading || !pendingLayout) return;
    const t = setTimeout(() => {
      store.setLayout(pendingLayout);
      setPendingLayout(null);
      setFading(false);
    }, animationsEnabled ? Math.round(getMotionDuration() * 0.45) : 0);
    return () => clearTimeout(t);
  }, [animationsEnabled, fading, getMotionDuration, pendingLayout, store]);

  useLayoutEffect(() => {
    const animation = layoutAnimationRef.current;
    if (!animation || activeWs.layoutId !== animation.targetLayout) return;

    const duration = getMotionDuration();
    if (duration <= 0) {
      layoutAnimationRef.current = null;
      return;
    }

    const nextLayout = GRID_LAYOUTS[resolveLayout(activeWs.layoutId, containerWidth)];
    for (const cell of activeWs.cells.slice(0, nextLayout.cellCount)) {
      const node = cellRefs.current.get(cell.id);
      if (!node) continue;

      const fromRect = animation.fromRects.get(cell.id);
      const toRect = node.getBoundingClientRect();

      if (!fromRect) {
        node.animate(
          [
            { opacity: 0, transform: 'scale(0.96) translateY(10px)' },
            { opacity: 1, transform: 'scale(1) translateY(0)' },
          ],
          {
            duration: Math.round(duration * 0.8),
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          },
        );
        continue;
      }

      const dx = fromRect.left - toRect.left;
      const dy = fromRect.top - toRect.top;
      const sx = fromRect.width / Math.max(toRect.width, 1);
      const sy = fromRect.height / Math.max(toRect.height, 1);

      node.animate(
        [
          {
            transformOrigin: 'top left',
            transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
          },
          {
            transformOrigin: 'top left',
            transform: 'translate(0px, 0px) scale(1, 1)',
          },
        ],
        {
          duration,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        },
      );
    }

    layoutAnimationRef.current = null;
  }, [activeWs.cells, activeWs.layoutId, containerWidth, getMotionDuration]);

  // ── ResizeObserver for responsive layout ─────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerWidth(Math.floor(entry.contentRect.width));
    });
    ro.observe(el);
    setContainerWidth(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  // ── dnd-kit setup ─────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;

    const sourceId = active.id as string;
    const targetId = (over.data.current as { cellId?: string })?.cellId;
    if (targetId && sourceId !== targetId) {
      store.swapCells(sourceId, targetId);
    }
  };

  // ── Effective layout (responsive fallback) ────────────────────────────────
  const effectiveId = resolveLayout(activeWs.layoutId, containerWidth);
  const effectiveLayout = GRID_LAYOUTS[effectiveId];
  const visibleCells = activeWs.cells.slice(0, effectiveLayout.cellCount);

  const activeCell = activeDragId
    ? activeWs.cells.find((c) => c.id === activeDragId)
    : null;
  const dropDuration = !animationsEnabled ? 0 : animationSpeed === 'slow' ? 240 : animationSpeed === 'fast' ? 140 : 180;
  const registerCellRef = useCallback((cellId: string, node: HTMLDivElement | null) => {
    if (node) cellRefs.current.set(cellId, node);
    else cellRefs.current.delete(cellId);
  }, []);

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div ref={containerRef} className="flex flex-col h-full overflow-hidden bg-background">
        {/* Workspace tabs */}
        <WorkspaceBar />

        {/* Layout picker */}
        <GridLayoutPicker
          currentLayout={activeWs.layoutId}
          containerWidth={containerWidth}
          onChange={handleLayoutChange}
        />

        {/* Grid */}
        <div
          className="flex-1 min-h-0 grid transition-opacity duration-[130ms] ease-out app-motion-base"
          style={{
            gridTemplateColumns: effectiveLayout.colTemplate,
            gridTemplateRows: effectiveLayout.rowTemplate,
            gap: '1px',
            background: 'var(--border)',
            opacity: fading ? 0.94 : 1,
          }}
        >
          {visibleCells.map((cell) => (
            <GridCell key={cell.id} cell={cell} onContainerRef={registerCellRef} />
          ))}
        </div>
      </div>

      {/* Floating drag ghost */}
      <DragOverlay dropAnimation={dropDuration > 0 ? { duration: dropDuration, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' } : null}>
        {activeCell ? <DragGhost title={activeCell.content.title || activeCell.content.type} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
