import { useRef, useEffect, useState, useCallback } from 'react';
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
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background/95 border border-primary/40 shadow-xl text-xs text-foreground backdrop-blur-sm">
      <GripVertical size={12} className="text-primary" />
      <span className="max-w-[180px] truncate">{title || 'Cell'}</span>
    </div>
  );
}

// ─── GridView ────────────────────────────────────────────────────────────────
export default function GridView() {
  const store = useGridStore();
  const activeWs = selectActiveWorkspace(store);

  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1000);

  // ── Smooth layout transition ──────────────────────────────────────────────
  const [fading, setFading] = useState(false);
  const [pendingLayout, setPendingLayout] = useState<GridLayoutId | null>(null);

  const handleLayoutChange = useCallback((id: GridLayoutId) => {
    if (id === activeWs.layoutId) return;
    setPendingLayout(id);
    setFading(true);
  }, [activeWs.layoutId]);

  useEffect(() => {
    if (!fading || !pendingLayout) return;
    const t = setTimeout(() => {
      store.setLayout(pendingLayout);
      setPendingLayout(null);
      setFading(false);
    }, 130);
    return () => clearTimeout(t);
  }, [fading, pendingLayout]);

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
          className="flex-1 min-h-0 grid transition-opacity duration-[130ms] ease-out"
          style={{
            gridTemplateColumns: effectiveLayout.colTemplate,
            gridTemplateRows: effectiveLayout.rowTemplate,
            gap: '1px',
            background: 'var(--border)',
            opacity: fading ? 0 : 1,
          }}
        >
          {visibleCells.map((cell) => (
            <GridCell key={cell.id} cell={cell} />
          ))}
        </div>
      </div>

      {/* Floating drag ghost */}
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
        {activeCell ? <DragGhost title={activeCell.content.title || activeCell.content.type} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
