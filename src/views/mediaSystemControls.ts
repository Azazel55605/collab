import { useEffect, useEffectEvent } from 'react';

import type { LocalAudioMetadata } from '../lib/tauri';

export function useMediaSystemControls({
  media,
  title,
  details,
  seek,
  next,
  previous,
  hasNext,
  hasPrevious,
}: {
  media: HTMLMediaElement | null;
  title: string;
  details?: LocalAudioMetadata | null;
  seek(time: number): void;
  next(): void;
  previous(): void;
  hasNext: boolean;
  hasPrevious: boolean;
}) {
  const seekTo = useEffectEvent(seek);
  const goNext = useEffectEvent(next);
  const goPrevious = useEffectEvent(previous);
  useEffect(() => {
    const session = navigator.mediaSession;
    if (!media || !session) return;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => void media.play().catch(() => {})],
      ['pause', () => media.pause()],
      [
        'seekto',
        ({ seekTime }) => {
          if (seekTime !== undefined) seekTo(seekTime);
        },
      ],
      ['seekbackward', ({ seekOffset }) => seekTo(media.currentTime - (seekOffset ?? 10))],
      ['seekforward', ({ seekOffset }) => seekTo(media.currentTime + (seekOffset ?? 10))],
    ];
    if (hasNext) handlers.push(['nexttrack', goNext]);
    if (hasPrevious) handlers.push(['previoustrack', goPrevious]);

    const update = () => {
      session.playbackState = media.paused ? 'paused' : 'playing';
      if (!(media.duration > 0 && Number.isFinite(media.duration))) return;
      session.setPositionState?.({
        duration: media.duration,
        playbackRate: media.playbackRate,
        position: Math.max(0, Math.min(media.currentTime, media.duration)),
      });
    };

    if (typeof MediaMetadata !== 'undefined') {
      session.metadata = new MediaMetadata({
        title: details?.title || title,
        artist: details?.artist ?? '',
        album: details?.album ?? '',
      });
    }
    const installed = handlers.filter(([action, handler]) => {
      try {
        session.setActionHandler(action, handler);
        return true;
      } catch {
        // Engines can support a subset of actions.
        return false;
      }
    });
    const events = ['play', 'pause', 'seeked', 'ratechange', 'ended'];
    events.forEach((event) => media.addEventListener(event, update));
    update();
    return () => {
      events.forEach((event) => media.removeEventListener(event, update));
      installed.forEach(([action]) => session.setActionHandler(action, null));
      session.metadata = null;
      session.playbackState = 'none';
      session.setPositionState?.();
    };
  }, [details, hasNext, hasPrevious, media, title]);
}
