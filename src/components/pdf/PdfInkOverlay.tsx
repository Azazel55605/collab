import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createInkShape, createInkStamp } from '../../lib/ink/advancedTools';
import { encodeSamples } from '../../lib/ink/codec';
import { INK_LIGHT_PALETTE } from '../../lib/ink/colors';
import { applyErase, planErase } from '../../lib/ink/erase';
import { addObject, removeObjects, updateObject } from '../../lib/ink/operations';
import { selectionFrame } from '../../lib/ink/selectionFrame';
import { drawsBehindInk, INK_DEFAULT_PEN_BUTTONS } from '../../lib/ink/tools';
import type { InkToolState } from '../../lib/ink/tools';
import {
  boundsToBounds,
  composeAffine,
  resizeBounds,
  rotationAbout,
  transformObject,
  translation,
} from '../../lib/ink/transform';
import type { InkResizeHandle } from '../../lib/ink/transform';
import {
  createPdfInkSurface,
  pdfInkPage,
  pdfInkSurface,
  updatePdfInkSurface,
} from '../../lib/pdfAnnotations';
import type { InkAnnotationDocument, InkSample, InkScene } from '../../types/ink';
import InkCanvas from '../ink/InkCanvas';

export interface PdfInkOverlayProps {
  document: InkAnnotationDocument;
  pageNumber: number;
  widthPoints: number;
  heightPoints: number;
  scale: number;
  rotation: number;
  enabled: boolean;
  readOnly: boolean;
  tool: InkToolState;
  onChange: (document: InkAnnotationDocument) => void;
}

export interface PdfInkOverlayTransform {
  width: number;
  height: number;
  transform: string;
}

/** CSS map from unrotated source-page space into the PDF.js rotated surface. */
export function pdfInkOverlayTransform(
  rotation: number,
  width: number,
  height: number,
): PdfInkOverlayTransform {
  const normalized = ((rotation % 360) + 360) % 360;
  switch (normalized) {
    case 90:
      return { width, height, transform: `translateX(${height}px) rotate(90deg)` };
    case 180:
      return { width, height, transform: `translate(${width}px, ${height}px) rotate(180deg)` };
    case 270:
      return { width, height, transform: `translateY(${width}px) rotate(270deg)` };
    default:
      return { width, height, transform: 'none' };
  }
}

/** Inverse of {@link pdfInkOverlayTransform}, used for pressure input and handles. */
export function pdfInkClientToLocal(
  rotation: number,
  point: { x: number; y: number },
  bounds: DOMRect,
  width: number,
  height: number,
): { x: number; y: number } {
  const screenX = point.x - bounds.left;
  const screenY = point.y - bounds.top;
  const normalized = ((rotation % 360) + 360) % 360;
  switch (normalized) {
    case 90:
      return { x: screenY, y: height - screenX };
    case 180:
      return { x: width - screenX, y: height - screenY };
    case 270:
      return { x: width - screenY, y: screenX };
    default:
      return { x: screenX, y: screenY };
  }
}

export default function PdfInkOverlay({
  document,
  pageNumber,
  widthPoints,
  heightPoints,
  scale,
  rotation,
  enabled,
  readOnly,
  tool,
  onChange,
}: PdfInkOverlayProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const idCounter = useRef(0);
  const surface =
    pdfInkSurface(document, pageNumber) ??
    createPdfInkSurface(pageNumber, widthPoints, heightPoints);
  const page = useMemo(() => pdfInkPage(surface), [surface]);
  const activeLayerId =
    tool.activeLayerId && page.scene.layers[tool.activeLayerId]
      ? tool.activeLayerId
      : page.scene.layerOrder[page.scene.layerOrder.length - 1];
  const cssWidth = widthPoints * scale * (4 / 3);
  const cssHeight = heightPoints * scale * (4 / 3);
  const transform = pdfInkOverlayTransform(rotation, cssWidth, cssHeight);
  const clientToLocal = useCallback(
    (point: { x: number; y: number }, bounds: DOMRect) =>
      pdfInkClientToLocal(rotation, point, bounds, cssWidth, cssHeight),
    [cssHeight, cssWidth, rotation],
  );

  const nextId = useCallback((prefix: string) => {
    idCounter.current += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter.current}`;
  }, []);

  const commitScene = useCallback(
    (update: (scene: InkScene) => InkScene) => {
      if (readOnly) return;
      onChange(updatePdfInkSurface(document, pageNumber, widthPoints, heightPoints, update));
    },
    [document, heightPoints, onChange, pageNumber, readOnly, widthPoints],
  );

  const commitStroke = useCallback(
    (samples: InkSample[]) => {
      if (!activeLayerId || samples.length === 0) return;
      const brush = { ...tool.brush };
      commitScene((scene) => {
        const object = {
          id: nextId('pdf-stroke'),
          type: 'stroke' as const,
          layerId: activeLayerId,
          brush,
          samples: encodeSamples(samples),
          createdAt: Date.now(),
        };
        const index = drawsBehindInk(brush)
          ? scene.objectOrder.findIndex((id) => scene.objects[id].layerId === activeLayerId)
          : -1;
        return addObject(scene, object, index < 0 ? undefined : index).result;
      });
    },
    [activeLayerId, commitScene, nextId, tool.brush],
  );

  const createObject = useCallback(
    (
      kind:
        | 'shape'
        | 'connector'
        | 'text'
        | 'sticky'
        | 'image'
        | 'stamp'
        | 'equation'
        | 'ruler'
        | 'protractor'
        | 'compass'
        | 'guide',
      from: { x: number; y: number },
      to: { x: number; y: number },
      uniform: boolean,
    ) => {
      if (!activeLayerId || (kind !== 'shape' && kind !== 'connector' && kind !== 'stamp')) return;
      commitScene((scene) => {
        if (kind === 'stamp') {
          return addObject(
            scene,
            createInkStamp({
              id: nextId('pdf-stamp'),
              layerId: activeLayerId,
              symbolId: tool.stampSymbolId,
              from,
              to,
              color: tool.brush.color,
            }),
          ).result;
        }
        const shape = createInkShape({
          id: nextId(kind === 'connector' ? 'pdf-arrow' : 'pdf-shape'),
          layerId: activeLayerId,
          kind: kind === 'connector' ? 'line' : tool.shapeKind,
          from,
          to,
          uniform,
          style: {
            stroke: tool.brush,
            ...(kind === 'connector' ? { arrowEnd: 'arrow' as const } : {}),
          },
        });
        return addObject(scene, shape).result;
      });
    },
    [activeLayerId, commitScene, nextId, tool],
  );

  const changeSelection = useCallback((ids: string[], additive: boolean) => {
    setSelectedIds((current) => {
      if (!additive) return ids;
      const next = new Set(current);
      for (const id of ids) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return [...next];
    });
  }, []);

  const transformSelection = useCallback(
    (transform: Parameters<typeof transformObject>[1]) => {
      commitScene((scene) => {
        let next = scene;
        for (const id of selectedIds) {
          next = updateObject(next, id, (object) => transformObject(object, transform)).result;
        }
        return next;
      });
    },
    [commitScene, selectedIds],
  );

  useEffect(() => {
    if (!enabled || readOnly || selectedIds.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"], [role="textbox"]')) return;
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      event.preventDefault();
      event.stopPropagation();
      commitScene((scene) => removeObjects(scene, selectedIds).result);
      setSelectedIds([]);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [commitScene, enabled, readOnly, selectedIds]);

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[4] overflow-hidden"
      aria-hidden={!enabled}
    >
      <div
        className={
          enabled
            ? 'pointer-events-auto absolute left-0 top-0'
            : 'pointer-events-none absolute left-0 top-0'
        }
        style={{
          width: `${transform.width}px`,
          height: `${transform.height}px`,
          transform: transform.transform,
          transformOrigin: '0 0',
        }}
        data-testid={`pdf-ink-overlay-${pageNumber}`}
      >
        <InkCanvas
          page={page}
          originX={0}
          originY={0}
          zoom={scale}
          tool={tool}
          penButtons={INK_DEFAULT_PEN_BUTTONS}
          selectedIds={selectedIds}
          readOnly={readOnly}
          colorPalette={INK_LIGHT_PALETTE}
          onViewportChange={() => undefined}
          onCommitStroke={commitStroke}
          onCreateAdvancedObject={createObject}
          onEyedropObject={() => undefined}
          onActivateObjectLink={() => undefined}
          readAssetDataUrl={() => Promise.reject(new Error('PDF ink does not embed assets.'))}
          onErase={(path, radius) =>
            commitScene(
              (scene) => applyErase(scene, planErase(scene, path, radius, tool.eraserMode)).result,
            )
          }
          onSelectionChange={changeSelection}
          onMoveSelection={(dx, dy) => transformSelection(translation(dx, dy))}
          onResizeSelection={(handle: InkResizeHandle, dx, dy, uniform, selectionRotation) => {
            const frame = selectionFrame(page.scene, selectedIds);
            if (!frame) return;
            const before = {
              minX: frame.centerX - frame.width / 2,
              minY: frame.centerY - frame.height / 2,
              maxX: frame.centerX + frame.width / 2,
              maxY: frame.centerY + frame.height / 2,
            };
            const resized = boundsToBounds(before, resizeBounds(before, handle, dx, dy, uniform));
            transformSelection(
              composeAffine(
                composeAffine(
                  rotationAbout(frame.centerX, frame.centerY, -selectionRotation),
                  resized,
                ),
                rotationAbout(frame.centerX, frame.centerY, selectionRotation),
              ),
            );
          }}
          onRotateSelection={(radians) => {
            const frame = selectionFrame(page.scene, selectedIds);
            if (frame) transformSelection(rotationAbout(frame.centerX, frame.centerY, radians));
          }}
          clientToLocal={clientToLocal}
          className="h-full w-full bg-transparent"
        />
      </div>
    </div>
  );
}
