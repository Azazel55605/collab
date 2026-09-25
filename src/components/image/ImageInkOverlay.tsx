import { useCallback, useMemo } from 'react';

import type { InkToolState } from '../../lib/ink/tools';
import {
  anchoredSurfacePage,
  createImageAnnotationSurface,
  imageAnnotationSurface,
  putAnchoredSurface,
} from '../../lib/viewAnnotations';
import type { InkAnnotationDocument, InkAnnotationSurface, InkScene } from '../../types/ink';
import { AnchoredInkOverlay } from '../pdf/PdfInkOverlay';

interface ImageInkOverlayProps {
  document: InkAnnotationDocument;
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  enabled: boolean;
  readOnly: boolean;
  tool: InkToolState;
  onChange: (document: InkAnnotationDocument) => void;
}

export default function ImageInkOverlay({
  document,
  width,
  height,
  displayWidth,
  displayHeight,
  enabled,
  readOnly,
  tool,
  onChange,
}: ImageInkOverlayProps) {
  const existingSurface = imageAnnotationSurface(document);
  if (!existingSurface && !enabled) return null;

  return (
    <MountedImageInkOverlay
      document={document}
      width={width}
      height={height}
      displayWidth={displayWidth}
      displayHeight={displayHeight}
      enabled={enabled}
      readOnly={readOnly}
      tool={tool}
      onChange={onChange}
      surface={existingSurface ?? createImageAnnotationSurface(width, height)}
    />
  );
}

function MountedImageInkOverlay({
  document,
  width,
  height,
  displayWidth,
  displayHeight,
  enabled,
  readOnly,
  tool,
  onChange,
  surface,
}: ImageInkOverlayProps & { surface: InkAnnotationSurface }) {
  const page = useMemo(() => anchoredSurfacePage(surface), [surface]);
  const zoom = displayWidth / Math.max(width, 1);
  const onSceneChange = useCallback(
    (scene: InkScene) =>
      onChange(
        putAnchoredSurface(document, {
          ...surface,
          anchor: { kind: 'image', width, height },
          scene,
        }),
      ),
    [document, height, onChange, surface, width],
  );

  return (
    <AnchoredInkOverlay
      page={page}
      displayWidth={displayWidth}
      displayHeight={displayHeight}
      zoom={zoom}
      enabled={enabled}
      readOnly={readOnly}
      tool={tool}
      idPrefix="image"
      testId="image-ink-overlay"
      onSceneChange={onSceneChange}
    />
  );
}
