import { type RefObject, useEffect, useState } from 'react';

export interface VideoBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The rectangle an `object-fit: contain` picture of `media` size occupies inside
 * a `container` box, or null while either size is unknown.
 */
export function containedBox(
  container: { width: number; height: number },
  media: { width: number; height: number },
): VideoBox | null {
  if (!container.width || !container.height || !media.width || !media.height) return null;
  const scale = Math.min(container.width / media.width, container.height / media.height);
  const width = media.width * scale;
  const height = media.height * scale;
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
  };
}

/**
 * Tracks where the visible picture of a letterboxed video sits inside its stage,
 * so overlays such as the control bar can follow the picture instead of the
 * whole stage. Updates on stage resizes and when the video's size becomes known.
 */
export function useVideoBox(
  stage: RefObject<HTMLElement | null>,
  media: RefObject<HTMLMediaElement | null>,
  sourceId: string | undefined,
): VideoBox | null {
  const [box, setBox] = useState<VideoBox | null>(null);

  useEffect(() => {
    const container = stage.current;
    const video = media.current;
    if (!container || !(video instanceof HTMLVideoElement)) {
      setBox(null);
      return;
    }
    const measure = () => {
      const next = containedBox(
        { width: container.clientWidth, height: container.clientHeight },
        { width: video.videoWidth, height: video.videoHeight },
      );
      setBox((previous) =>
        previous &&
        next &&
        Math.abs(previous.left - next.left) < 0.5 &&
        Math.abs(previous.top - next.top) < 0.5 &&
        Math.abs(previous.width - next.width) < 0.5 &&
        Math.abs(previous.height - next.height) < 0.5
          ? previous
          : next,
      );
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(container);
    video.addEventListener('loadedmetadata', measure);
    video.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      video.removeEventListener('loadedmetadata', measure);
      video.removeEventListener('resize', measure);
    };
  }, [stage, media, sourceId]);

  return box;
}

/**
 * Where the control bar goes for a picture box: along the picture's bottom
 * edge and as wide as the picture, but never narrower than `minWidth` (capped
 * at the stage width) so the controls stay usable on tall, narrow videos.
 */
export function controlsBox(box: VideoBox, minWidth = 420) {
  const stageWidth = box.left * 2 + box.width;
  const width = Math.min(stageWidth, Math.max(box.width, minWidth));
  return { left: (stageWidth - width) / 2, width, bottom: box.top };
}
