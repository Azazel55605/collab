import { type RefObject, useEffect, useRef } from 'react';

export default function MediaAmbiance({
  media,
  active,
}: {
  media: RefObject<HTMLMediaElement | null>;
  active: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const video = media.current;
    const target = canvas.current;
    if (!active || !(video instanceof HTMLVideoElement) || !target) return;
    const context = target.getContext('2d');
    if (!context) return;
    let lastTime = -1;
    let blocked = false;
    const paint = () => {
      if (blocked || document.hidden || video.readyState < 2 || video.currentTime === lastTime)
        return;
      lastTime = video.currentTime;
      try {
        context.drawImage(video, 0, 0, target.width, target.height);
      } catch {
        blocked = true;
      }
    };
    paint();
    video.addEventListener('loadeddata', paint);
    video.addEventListener('seeked', paint);
    const timer = setInterval(paint, 250);
    return () => {
      clearInterval(timer);
      video.removeEventListener('loadeddata', paint);
      video.removeEventListener('seeked', paint);
    };
  }, [active, media]);

  return active ? (
    <canvas
      ref={canvas}
      width={32}
      height={18}
      aria-hidden="true"
      className="pointer-events-none absolute inset-[3%] -z-10 h-[94%] w-[94%] scale-110 opacity-45 blur-[64px]"
    />
  ) : null;
}
