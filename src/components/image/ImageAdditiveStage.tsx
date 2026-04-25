import type { RefObject } from 'react';

import { cn } from '../../lib/utils';
import type { ImageArrowOverlay, ImageOverlayItem, ImagePenOverlay, ImageTextOverlay } from '../../types/image';
import {
  getArrowHeadPoints,
  getArrowLineEnd,
  getLineDash,
  getRelativePoint,
  getTextHeight,
  getTextWidth,
  type Dimensions,
  type Point,
} from './ImageViewUtils';

interface ImageAdditiveStageProps {
  src: string;
  relativePath: string | null;
  toolCursor: 'cursor-text' | 'cursor-default' | 'cursor-crosshair';
  additiveCanvasStyle: { width: number; height: number };
  additiveDisplayDimensions: Dimensions;
  overlaySvgItems: ImageOverlayItem[];
  selectedItemId: string | null;
  textInputRefs: RefObject<Record<string, HTMLTextAreaElement | null>>;
  onStagePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onStagePointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onStagePointerUp: () => void;
  onStagePointerLeave: () => void;
  onSelectItem: (id: string) => void;
  onSetEditingTextId: (id: string) => void;
  onStartArrowInteraction: (interaction: {
    id: string;
    mode: 'move' | 'start' | 'end';
    startPointer: Point;
    startStart: Point;
    startEnd: Point;
  }) => void;
  onStartTextInteraction: (interaction: {
    id: string;
    mode: 'move' | 'resize';
    startPointer: Point;
    startX: number;
    startY: number;
    startWidth?: number;
    startHeight?: number;
    edges?: { left: boolean; right: boolean; top: boolean; bottom: boolean };
  }) => void;
  onTextChange: (id: string, value: string) => void;
}

const TEXT_RESIZE_HANDLES = [
  { key: 'top', className: 'absolute inset-x-2 top-[-3px] h-2 cursor-ns-resize', edges: { left: false, right: false, top: true, bottom: false } },
  { key: 'bottom', className: 'absolute inset-x-2 bottom-[-3px] h-2 cursor-ns-resize', edges: { left: false, right: false, top: false, bottom: true } },
  { key: 'left', className: 'absolute inset-y-2 left-[-3px] w-2 cursor-ew-resize', edges: { left: true, right: false, top: false, bottom: false } },
  { key: 'right', className: 'absolute inset-y-2 right-[-3px] w-2 cursor-ew-resize', edges: { left: false, right: true, top: false, bottom: false } },
  { key: 'top-left', className: 'absolute left-[-4px] top-[-4px] h-3 w-3 cursor-nwse-resize', edges: { left: true, right: false, top: true, bottom: false } },
  { key: 'top-right', className: 'absolute right-[-4px] top-[-4px] h-3 w-3 cursor-nesw-resize', edges: { left: false, right: true, top: true, bottom: false } },
  { key: 'bottom-left', className: 'absolute bottom-[-4px] left-[-4px] h-3 w-3 cursor-nesw-resize', edges: { left: true, right: false, top: false, bottom: true } },
  { key: 'bottom-right', className: 'absolute bottom-[-4px] right-[-4px] h-3 w-3 cursor-nwse-resize', edges: { left: false, right: true, top: false, bottom: true } },
] as const;

export function ImageAdditiveStage({
  src,
  relativePath,
  toolCursor,
  additiveCanvasStyle,
  additiveDisplayDimensions,
  overlaySvgItems,
  selectedItemId,
  textInputRefs,
  onStagePointerDown,
  onStagePointerMove,
  onStagePointerUp,
  onStagePointerLeave,
  onSelectItem,
  onSetEditingTextId,
  onStartArrowInteraction,
  onStartTextInteraction,
  onTextChange,
}: ImageAdditiveStageProps) {
  return (
    <div
      className="relative shrink-0 rounded-xl border border-border/40 bg-background/70 shadow-xl app-fade-scale-in"
      style={additiveCanvasStyle}
    >
      <img
        src={src}
        alt={relativePath ?? 'Image'}
        className="block h-full w-full rounded-xl select-none"
        draggable={false}
      />

      <div
        data-image-stage="additive"
        className={cn('absolute inset-0 overflow-hidden rounded-xl', toolCursor)}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerLeave={onStagePointerLeave}
      >
        <svg className="absolute inset-0 h-full w-full">
          {overlaySvgItems.map((item) => {
            if (item.type === 'arrow') {
              const arrow = item as ImageArrowOverlay;
              const arrowStart = {
                x: arrow.start.x * additiveDisplayDimensions.width,
                y: arrow.start.y * additiveDisplayDimensions.height,
              };
              const arrowEnd = {
                x: arrow.end.x * additiveDisplayDimensions.width,
                y: arrow.end.y * additiveDisplayDimensions.height,
              };
              const headSize = Math.max(8, arrow.strokeWidth * 3);
              const lineEnd = getArrowLineEnd(arrowStart, arrowEnd, headSize);
              return (
                <g
                  key={arrow.id}
                  className="cursor-pointer"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    onSelectItem(arrow.id);
                    const stage = event.currentTarget.closest('[data-image-stage="additive"]') as HTMLDivElement | null;
                    if (!stage) return;
                    const rect = stage.getBoundingClientRect();
                    onStartArrowInteraction({
                      id: arrow.id,
                      mode: 'move',
                      startPointer: getRelativePoint(event, rect),
                      startStart: arrow.start,
                      startEnd: arrow.end,
                    });
                  }}
                >
                  <line
                    x1={arrowStart.x}
                    y1={arrowStart.y}
                    x2={lineEnd.x}
                    y2={lineEnd.y}
                    stroke={arrow.color}
                    strokeWidth={arrow.strokeWidth}
                    strokeLinecap="round"
                    strokeDasharray={(getLineDash(arrow.lineStyle, arrow.strokeWidth) ?? []).join(' ')}
                  />
                  <polygon
                    points={getArrowHeadPoints(
                      arrowStart,
                      arrowEnd,
                      headSize,
                    )}
                    fill={arrow.color}
                  />
                  {selectedItemId === arrow.id && (
                    <>
                      <circle
                        cx={arrowStart.x}
                        cy={arrowStart.y}
                        r="7"
                        fill="rgb(var(--background))"
                        stroke="white"
                        strokeWidth="1.5"
                        opacity="0.95"
                        className="cursor-grab"
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          const stage = event.currentTarget.closest('[data-image-stage="additive"]') as HTMLDivElement | null;
                          if (!stage) return;
                          const rect = stage.getBoundingClientRect();
                          onStartArrowInteraction({
                            id: arrow.id,
                            mode: 'start',
                            startPointer: getRelativePoint(event, rect),
                            startStart: arrow.start,
                            startEnd: arrow.end,
                          });
                        }}
                      />
                      <circle
                        cx={arrowEnd.x}
                        cy={arrowEnd.y}
                        r="7"
                        fill="rgb(var(--background))"
                        stroke="white"
                        strokeWidth="1.5"
                        opacity="0.95"
                        className="cursor-grab"
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          const stage = event.currentTarget.closest('[data-image-stage="additive"]') as HTMLDivElement | null;
                          if (!stage) return;
                          const rect = stage.getBoundingClientRect();
                          onStartArrowInteraction({
                            id: arrow.id,
                            mode: 'end',
                            startPointer: getRelativePoint(event, rect),
                            startStart: arrow.start,
                            startEnd: arrow.end,
                          });
                        }}
                      />
                    </>
                  )}
                </g>
              );
            }

            if (item.type === 'pen') {
              const pen = item as ImagePenOverlay;
              return (
                <polyline
                  key={pen.id}
                  points={pen.points.map((point) => `${point.x * additiveDisplayDimensions.width},${point.y * additiveDisplayDimensions.height}`).join(' ')}
                  fill="none"
                  stroke={pen.color}
                  strokeWidth={pen.strokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="cursor-pointer"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    onSelectItem(pen.id);
                  }}
                  opacity={selectedItemId === pen.id ? 1 : 0.95}
                />
              );
            }

            return null;
          })}
        </svg>

        {overlaySvgItems.filter((item): item is ImageTextOverlay => item.type === 'text').map((item) => (
          <div
            key={item.id}
            className={cn(
              'absolute rounded-md border shadow-lg shadow-black/15',
              selectedItemId === item.id ? 'ring-1 ring-primary/80 bg-background/70' : 'bg-background/35',
            )}
            style={{
              left: `${item.x * 100}%`,
              top: `${item.y * 100}%`,
              width: `${getTextWidth(item) * 100}%`,
              height: `${getTextHeight(item) * 100}%`,
              borderColor: selectedItemId === item.id ? 'rgb(var(--primary) / 0.65)' : 'rgb(var(--border) / 0.65)',
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              onSelectItem(item.id);
              onSetEditingTextId(item.id);
              const target = event.target as HTMLElement;
              if (target.tagName === 'TEXTAREA' || target.closest('[data-text-resize-handle="true"]')) {
                return;
              }
              const stage = event.currentTarget.closest('[data-image-stage="additive"]') as HTMLDivElement | null;
              if (!stage) return;
              const rect = stage.getBoundingClientRect();
              onStartTextInteraction({
                id: item.id,
                mode: 'move',
                startPointer: getRelativePoint(event, rect),
                startX: item.x,
                startY: item.y,
              });
            }}
          >
            <textarea
              ref={(node) => {
                textInputRefs.current[item.id] = node;
              }}
              value={item.text}
              placeholder="Write here"
              className="h-full w-full resize-none rounded-md border-0 bg-transparent px-2 py-2 outline-none"
              style={{
                color: item.color,
                fontSize: `${item.fontSize}px`,
                lineHeight: 1.25,
              }}
              onPointerDown={(event) => {
                event.stopPropagation();
                onSelectItem(item.id);
                onSetEditingTextId(item.id);
              }}
              onChange={(event) => {
                onSelectItem(item.id);
                onSetEditingTextId(item.id);
                onTextChange(item.id, event.target.value);
              }}
              onFocus={() => {
                onSelectItem(item.id);
                onSetEditingTextId(item.id);
              }}
            />
            {TEXT_RESIZE_HANDLES.map((handle) => (
              <button
                key={handle.key}
                type="button"
                data-text-resize-handle="true"
                className={handle.className}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  const stage = event.currentTarget.closest('[data-image-stage="additive"]') as HTMLDivElement | null;
                  if (!stage) return;
                  const rect = stage.getBoundingClientRect();
                  onSelectItem(item.id);
                  onSetEditingTextId(item.id);
                  onStartTextInteraction({
                    id: item.id,
                    mode: 'resize',
                    edges: handle.edges,
                    startPointer: getRelativePoint(event, rect),
                    startX: item.x,
                    startY: item.y,
                    startWidth: getTextWidth(item),
                    startHeight: getTextHeight(item),
                  });
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
