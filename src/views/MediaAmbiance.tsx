import { type RefObject, useEffect, useRef } from 'react';

const SAMPLE_INTERVAL_MS = 1000;
const CORNERS = ['20% 25%', '80% 25%', '20% 75%', '80% 75%'];

export default function MediaAmbiance({ media }: { media: RefObject<HTMLMediaElement | null> }) {
  const background = useRef<HTMLDivElement>(null);
  const foreground = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const video = media.current;
    const layer = background.current;
    const overlay = foreground.current;
    if (!(video instanceof HTMLVideoElement) || !layer || !overlay) return;
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;

    let frame = 0;
    let blocked = false;
    let sampledAt = -Infinity;
    let sampledPosition = -1;
    let previous = '';
    let overlayVisible = false;
    const paint = () => {
      if (
        blocked ||
        document.hidden ||
        video.seeking ||
        video.readyState < 2 ||
        video.currentTime === sampledPosition
      )
        return;
      sampledAt = performance.now();
      sampledPosition = video.currentTime;
      try {
        context.drawImage(video, 0, 0, 2, 2);
        const { data } = context.getImageData(0, 0, 2, 2);
        const gradient = CORNERS.map((corner, index) => {
          const offset = index * 4;
          const color = `${data[offset]} ${data[offset + 1]} ${data[offset + 2]}`;
          return `radial-gradient(ellipse at ${corner}, rgb(${color} / 0.38), transparent 68%)`;
        }).join(', ');
        if (gradient === previous) return;
        if (!previous || overlayVisible) {
          layer.style.backgroundImage = gradient;
          overlay.style.opacity = '0';
        } else {
          overlay.style.backgroundImage = gradient;
          overlay.style.opacity = '1';
        }
        overlayVisible = Boolean(previous) && !overlayVisible;
        previous = gradient;
      } catch {
        blocked = true;
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    };
    const onTimeUpdate = () => {
      if (!blocked && !video.paused && performance.now() - sampledAt >= SAMPLE_INTERVAL_MS)
        schedule();
    };
    schedule();
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadeddata', schedule);
    video.addEventListener('seeked', schedule);
    video.addEventListener('pause', schedule);
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadeddata', schedule);
      video.removeEventListener('seeked', schedule);
      video.removeEventListener('pause', schedule);
    };
  }, [media]);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
      <div ref={background} className="absolute inset-0 bg-background" />
      <div
        ref={foreground}
        className="absolute inset-0 bg-background opacity-0 transition-opacity duration-1000 ease-linear motion-reduce:transition-none"
      />
    </div>
  );
}
