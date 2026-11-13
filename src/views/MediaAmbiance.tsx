import { type RefObject, useEffect, useRef } from 'react';

export default function MediaAmbiance({ media }: { media: RefObject<HTMLMediaElement | null> }) {
  const background = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const video = media.current;
    const layer = background.current;
    if (!(video instanceof HTMLVideoElement) || !layer) return;
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;

    let frame = 0;
    let blocked = false;
    const paint = () => {
      if (blocked || document.hidden || video.seeking || video.readyState < 2) return;
      try {
        context.drawImage(video, 0, 0, 2, 2);
        const { data } = context.getImageData(0, 0, 2, 2);
        const corners = ['20% 25%', '80% 25%', '20% 75%', '80% 75%'];
        layer.style.backgroundImage = corners
          .map((corner, index) => {
            const offset = index * 4;
            const color = `${data[offset]} ${data[offset + 1]} ${data[offset + 2]}`;
            return `radial-gradient(ellipse at ${corner}, rgb(${color} / 0.38), transparent 68%)`;
          })
          .join(', ');
      } catch {
        blocked = true;
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    };
    schedule();
    video.addEventListener('loadeddata', schedule);
    video.addEventListener('seeked', schedule);
    video.addEventListener('pause', schedule);
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener('loadeddata', schedule);
      video.removeEventListener('seeked', schedule);
      video.removeEventListener('pause', schedule);
    };
  }, [media]);

  return (
    <div
      ref={background}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10"
    />
  );
}
