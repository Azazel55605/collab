import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  addNode,
  createNode,
  nodeBounds,
  resizeNodeToBounds,
  serializeNode,
  setLineEndpoint,
  translateNode,
  updateNode,
} from '../../lib/svgDocument';
import type { SvgNode, SvgPrimitiveType, SvgRect, SvgScene } from '../../types/svg';

import type { Dimensions } from './ImageViewUtils';

export type SvgTool = 'select' | SvgPrimitiveType;

interface Props {
  scene: SvgScene;
  displayDimensions: Dimensions;
  tool: SvgTool;
  selectedId: string | null;
  readOnly: boolean;
  onSelect: (id: string | null) => void;
  onSceneChange: (updater: (scene: SvgScene) => SvgScene) => void;
  /** Called after a create-drag so the caller can switch back to the select tool. */
  onCreated: (id: string) => void;
}

type BoxHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type Drag =
  | { kind: 'move'; id: string; origin: SvgNode; startX: number; startY: number }
  | { kind: 'resize'; id: string; origin: SvgNode; handle: BoxHandle; startBox: SvgRect }
  | { kind: 'line'; id: string; end: 'start' | 'end' }
  | { kind: 'create'; type: SvgPrimitiveType; startX: number; startY: number };

const HANDLE_POSITIONS: Record<BoxHandle, { fx: number; fy: number; cursor: string }> = {
  nw: { fx: 0, fy: 0, cursor: 'nwse-resize' },
  n: { fx: 0.5, fy: 0, cursor: 'ns-resize' },
  ne: { fx: 1, fy: 0, cursor: 'nesw-resize' },
  e: { fx: 1, fy: 0.5, cursor: 'ew-resize' },
  se: { fx: 1, fy: 1, cursor: 'nwse-resize' },
  s: { fx: 0.5, fy: 1, cursor: 'ns-resize' },
  sw: { fx: 0, fy: 1, cursor: 'nesw-resize' },
  w: { fx: 0, fy: 0.5, cursor: 'ew-resize' },
};

function applyHandle(box: SvgRect, handle: BoxHandle, ux: number, uy: number): SvgRect {
  let { x, y, width, height } = box;
  let left = x;
  let top = y;
  let right = x + width;
  let bottom = y + height;
  if (handle.includes('w')) left = ux;
  if (handle.includes('e')) right = ux;
  if (handle.includes('n')) top = uy;
  if (handle.includes('s')) bottom = uy;
  x = Math.min(left, right);
  y = Math.min(top, bottom);
  width = Math.max(1, Math.abs(right - left));
  height = Math.max(1, Math.abs(bottom - top));
  return { x, y, width, height };
}

export function SvgEditStage({
  scene,
  displayDimensions,
  tool,
  selectedId,
  readOnly,
  onSelect,
  onSceneChange,
  onCreated,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [draftBox, setDraftBox] = useState<SvgRect | null>(null);
  // Measured user-unit bounds for text/path/poly (opaque geometry).
  const [measuredBox, setMeasuredBox] = useState<SvgRect | null>(null);

  const { viewBox } = scene;
  const scale = displayDimensions.width / viewBox.width;

  const clientToUser = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const s = rect.width / viewBox.width;
      return {
        x: viewBox.x + (clientX - rect.left) / s,
        y: viewBox.y + (clientY - rect.top) / s,
      };
    },
    [viewBox.x, viewBox.y, viewBox.width],
  );

  const selectedNode = selectedId
    ? scene.slots.find((slot) => slot.kind === 'node' && slot.node.id === selectedId)?.kind ===
      'node'
      ? (
          scene.slots.find((slot) => slot.kind === 'node' && slot.node.id === selectedId) as {
            node: SvgNode;
          }
        ).node
      : null
    : null;

  // Bounds shown for the selection: model-derived for shapes with known
  // geometry, measured from the DOM for text/path/polyline/polygon.
  const modelBounds = selectedNode ? nodeBounds(selectedNode) : null;

  useLayoutEffect(() => {
    if (!selectedNode || modelBounds || selectedNode.type === 'line') {
      setMeasuredBox(null);
      return;
    }
    const el = svgRef.current?.querySelector(
      `[data-cid="${selectedNode.id}"]`,
    ) as SVGGraphicsElement | null;
    const rect = el?.getBoundingClientRect();
    const svgRect = svgRef.current?.getBoundingClientRect();
    if (!rect || !svgRect) {
      setMeasuredBox(null);
      return;
    }
    const s = svgRect.width / viewBox.width;
    setMeasuredBox({
      x: viewBox.x + (rect.left - svgRect.left) / s,
      y: viewBox.y + (rect.top - svgRect.top) / s,
      width: rect.width / s,
      height: rect.height / s,
    });
  }, [selectedNode, modelBounds, viewBox.x, viewBox.y, viewBox.width, displayDimensions.width]);

  const selectionBox = modelBounds ?? measuredBox;

  const handleWindowUp = useCallback(() => {
    const drag = dragRef.current;
    if (drag?.kind === 'create' && draftBox) {
      if (draftBox.width >= 2 || draftBox.height >= 2 || drag.type === 'text') {
        const node = createNode(
          drag.type,
          draftBox.width < 2 && draftBox.height < 2
            ? {
                ...draftBox,
                width: drag.type === 'text' ? 80 : 40,
                height: drag.type === 'text' ? 24 : 40,
              }
            : draftBox,
        );
        onSceneChange((s) => addNode(s, node));
        onCreated(node.id);
      }
    }
    dragRef.current = null;
    setDraftBox(null);
  }, [draftBox, onCreated, onSceneChange]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const { x, y } = clientToUser(e.clientX, e.clientY);
      if (drag.kind === 'move') {
        const dx = x - drag.startX;
        const dy = y - drag.startY;
        onSceneChange((s) => updateNode(s, drag.id, () => translateNode(drag.origin, dx, dy)));
      } else if (drag.kind === 'resize') {
        const box = applyHandle(drag.startBox, drag.handle, x, y);
        onSceneChange((s) => updateNode(s, drag.id, () => resizeNodeToBounds(drag.origin, box)));
      } else if (drag.kind === 'line') {
        onSceneChange((s) => updateNode(s, drag.id, (n) => setLineEndpoint(n, drag.end, x, y)));
      } else if (drag.kind === 'create') {
        setDraftBox({
          x: Math.min(drag.startX, x),
          y: Math.min(drag.startY, y),
          width: Math.abs(x - drag.startX),
          height: Math.abs(y - drag.startY),
        });
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', handleWindowUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', handleWindowUp);
    };
  }, [clientToUser, handleWindowUp, onSceneChange]);

  const startCreateOrDeselect = (e: React.PointerEvent) => {
    if (readOnly) return;
    if (tool === 'select') {
      onSelect(null);
      return;
    }
    const { x, y } = clientToUser(e.clientX, e.clientY);
    dragRef.current = { kind: 'create', type: tool, startX: x, startY: y };
    setDraftBox({ x, y, width: 0, height: 0 });
  };

  const startMove = (e: React.PointerEvent, node: SvgNode) => {
    e.stopPropagation();
    onSelect(node.id);
    if (readOnly || tool !== 'select') return;
    const { x, y } = clientToUser(e.clientX, e.clientY);
    dragRef.current = { kind: 'move', id: node.id, origin: node, startX: x, startY: y };
  };

  const startResize = (e: React.PointerEvent, handle: BoxHandle) => {
    e.stopPropagation();
    if (readOnly || !selectedNode || !modelBounds) return;
    dragRef.current = {
      kind: 'resize',
      id: selectedNode.id,
      origin: selectedNode,
      handle,
      startBox: modelBounds,
    };
  };

  const startLineEndpoint = (e: React.PointerEvent, end: 'start' | 'end') => {
    e.stopPropagation();
    if (readOnly || !selectedNode || selectedNode.type !== 'line') return;
    dragRef.current = { kind: 'line', id: selectedNode.id, end };
  };

  const handleSize = 7 / scale;
  const strokeW = 1.5 / scale;

  return (
    <svg
      ref={svgRef}
      width={displayDimensions.width}
      height={displayDimensions.height}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      className="touch-none rounded-md shadow-lg shadow-black/30 ring-1 ring-border/40"
      style={{ background: '#ffffff', cursor: tool === 'select' ? 'default' : 'crosshair' }}
      onPointerDown={startCreateOrDeselect}
    >
      {scene.slots.map((slot, index) => {
        if (slot.kind === 'raw') {
          return <g key={`raw-${index}`} dangerouslySetInnerHTML={{ __html: slot.markup }} />;
        }
        const node = slot.node;
        return (
          <g
            key={node.id}
            data-cid={node.id}
            style={{
              cursor: readOnly ? 'default' : tool === 'select' ? 'move' : 'crosshair',
              pointerEvents: 'visiblePainted',
            }}
            onPointerDown={(e) => startMove(e, node)}
            dangerouslySetInnerHTML={{ __html: serializeNode(node, '') }}
          />
        );
      })}

      {/* Selection chrome */}
      {!readOnly && selectionBox && selectedNode?.type !== 'line' && (
        <g pointerEvents="none">
          <rect
            x={selectionBox.x}
            y={selectionBox.y}
            width={selectionBox.width}
            height={selectionBox.height}
            fill="none"
            stroke="#38bdf8"
            strokeWidth={strokeW}
            strokeDasharray={`${4 / scale} ${3 / scale}`}
          />
          {modelBounds &&
            (Object.keys(HANDLE_POSITIONS) as BoxHandle[]).map((handle) => {
              const pos = HANDLE_POSITIONS[handle];
              const hx = selectionBox.x + selectionBox.width * pos.fx;
              const hy = selectionBox.y + selectionBox.height * pos.fy;
              return (
                <rect
                  key={handle}
                  x={hx - handleSize / 2}
                  y={hy - handleSize / 2}
                  width={handleSize}
                  height={handleSize}
                  fill="#38bdf8"
                  stroke="#ffffff"
                  strokeWidth={strokeW}
                  style={{ cursor: pos.cursor, pointerEvents: 'all' }}
                  onPointerDown={(e) => startResize(e, handle)}
                />
              );
            })}
        </g>
      )}

      {/* Line endpoint handles */}
      {!readOnly && selectedNode?.type === 'line' && (
        <g>
          <line
            x1={selectedNode.x1}
            y1={selectedNode.y1}
            x2={selectedNode.x2}
            y2={selectedNode.y2}
            stroke="#38bdf8"
            strokeWidth={strokeW}
            strokeDasharray={`${4 / scale} ${3 / scale}`}
            pointerEvents="none"
          />
          {(['start', 'end'] as const).map((end) => (
            <circle
              key={end}
              cx={end === 'start' ? selectedNode.x1 : selectedNode.x2}
              cy={end === 'start' ? selectedNode.y1 : selectedNode.y2}
              r={handleSize / 1.4}
              fill="#38bdf8"
              stroke="#ffffff"
              strokeWidth={strokeW}
              style={{ cursor: 'grab', pointerEvents: 'all' }}
              onPointerDown={(e) => startLineEndpoint(e, end)}
            />
          ))}
        </g>
      )}

      {/* Create draft preview */}
      {draftBox && (
        <rect
          x={draftBox.x}
          y={draftBox.y}
          width={draftBox.width}
          height={draftBox.height}
          fill="rgba(56,189,248,0.15)"
          stroke="#38bdf8"
          strokeWidth={strokeW}
          strokeDasharray={`${4 / scale} ${3 / scale}`}
          pointerEvents="none"
        />
      )}
    </svg>
  );
}
