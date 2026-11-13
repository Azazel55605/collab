import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { Music2 } from 'lucide-react';

import { Button } from '../components/ui/button';
import { lyricIndexAt, parseLyrics } from '../lib/mediaLyrics';
import { type LocalAudioMetadata } from '../lib/tauri';
import { cn } from '../lib/utils';

import { paintMediaAmbiance } from './mediaAmbianceGradient';

export const AudioArtwork = memo(function AudioArtwork({
  filename,
  metadata,
  ambiance,
}: {
  filename: string;
  metadata: LocalAudioMetadata | null | undefined;
  ambiance: boolean;
}) {
  const artwork = useRef<HTMLImageElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const artworkUrl = metadata?.artworkUrl;
  const title = metadata?.title || filename;
  const details = [metadata?.artist, metadata?.album].filter(Boolean).join(' · ');

  function paintArtwork() {
    const image = artwork.current;
    if (!image?.naturalWidth || !backdrop.current) return;
    backdrop.current.style.backgroundImage = paintMediaAmbiance(image) ?? '';
  }

  useEffect(() => {
    if (ambiance) paintArtwork();
  }, [ambiance, artworkUrl]);

  return (
    <div className="min-w-0">
      {ambiance && artworkUrl && !failed ? (
        <div
          aria-hidden="true"
          ref={backdrop}
          className="pointer-events-none absolute inset-0 -z-10 mask-[radial-gradient(ellipse_closest-side,#000_55%,transparent)]"
        />
      ) : null}
      <div className="relative mx-auto aspect-square w-full max-w-80 overflow-hidden rounded-2xl border border-border/50 bg-muted shadow-xl shadow-black/20 @3xl:max-w-none">
        <div aria-hidden="true" className="absolute inset-0 grid place-items-center bg-primary/8">
          <Music2 className="size-1/5 text-primary/50" />
        </div>
        {artworkUrl && !failed ? (
          <img
            ref={artwork}
            crossOrigin="anonymous"
            src={artworkUrl}
            alt={`Cover art for ${metadata.album || title}`}
            className="relative size-full object-contain"
            draggable={false}
            onLoad={paintArtwork}
            onError={() => setFailed(true)}
          />
        ) : null}
      </div>
      <h2 className="mt-5 text-2xl leading-tight font-semibold tracking-tight break-words">
        {title}
      </h2>
      {details ? <p className="mt-1 text-sm break-words text-muted-foreground">{details}</p> : null}
    </div>
  );
});

const FOLLOW_PAUSE_MS = 3000;

export function AudioLyrics({
  lyrics,
  position,
  ready,
  onSeek,
}: {
  lyrics: LocalAudioMetadata['lyrics'] | undefined;
  position: number;
  ready: boolean;
  onSeek: (time: number) => void;
}) {
  const [selected, setSelected] = useState('');
  const sources = useMemo(
    () =>
      (lyrics ?? [])
        .map((source) => ({ ...source, ...parseLyrics(source.text) }))
        .filter((source) => source.lines.length || source.text),
    [lyrics],
  );
  const source =
    sources.find((item) => item.label === selected) ??
    sources.find((item) => item.lines.length) ??
    sources[0];
  const active = source ? lyricIndexAt(source.lines, position) : -1;
  const list = useRef<HTMLDivElement>(null);
  const activeLine = useRef<HTMLButtonElement>(null);
  // Manual scrolling pauses auto-follow briefly so the reader can look around.
  const followPausedUntil = useRef(0);
  const pauseFollow = () => {
    followPausedUntil.current = Date.now() + FOLLOW_PAUSE_MS;
  };

  useEffect(() => {
    const container = list.current;
    const line = activeLine.current;
    if (!container) return;
    if (active < 0) {
      container.scrollTop = 0;
      return;
    }
    if (!line || Date.now() < followPausedUntil.current) return;
    const viewport = container.getBoundingClientRect();
    const bounds = line.getBoundingClientRect();
    container.scrollTo({
      top: container.scrollTop + bounds.top - viewport.top - (viewport.height - bounds.height) / 2,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }, [active, source]);

  return (
    <section
      aria-labelledby="lyrics-heading"
      className="relative min-h-0 min-w-0 border-t border-border/50 pt-5 @3xl:border-t-0 @3xl:pt-0"
    >
      <div className="flex max-h-[28rem] min-h-0 flex-col @3xl:absolute @3xl:inset-0 @3xl:max-h-none">
        <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
          <h3 id="lyrics-heading" className="font-semibold">
            Lyrics
          </h3>
          {sources.length > 1 ? (
            <div
              role="group"
              aria-label="Lyrics source"
              className="flex rounded-lg border border-border bg-muted/40 p-0.5"
            >
              {sources.map(({ label }) => (
                <Button
                  key={label}
                  size="xs"
                  variant="ghost"
                  aria-pressed={label === source?.label}
                  className={cn(
                    'rounded-md',
                    label === source?.label
                      ? 'bg-background text-foreground shadow-sm hover:bg-background'
                      : 'text-muted-foreground',
                  )}
                  onClick={() => setSelected(label)}
                >
                  {label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        <div
          ref={list}
          onWheel={pauseFollow}
          onTouchMove={pauseFollow}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2 mask-[linear-gradient(to_bottom,transparent,#000_12%,#000_88%,transparent)]"
        >
          {source?.lines.length ? (
            <ol className="space-y-1 py-[30%]">
              {source.lines.map(({ time, text }, index) =>
                text ? (
                  <li key={time}>
                    <Button
                      ref={index === active ? activeLine : undefined}
                      variant="ghost"
                      className={cn(
                        'h-auto w-full justify-start px-0 py-1.5 text-left leading-snug break-words whitespace-pre-wrap transition-[color,font-size] duration-200 hover:bg-transparent hover:text-foreground motion-reduce:transition-none dark:hover:bg-transparent',
                        index === active
                          ? 'text-2xl font-semibold tracking-tight text-foreground @5xl:text-3xl'
                          : index === active + 1
                            ? 'text-lg font-medium text-foreground/80 @5xl:text-xl'
                            : 'text-lg font-medium text-muted-foreground @5xl:text-xl',
                      )}
                      aria-current={index === active ? 'true' : undefined}
                      disabled={!ready}
                      onClick={() => onSeek(time)}
                    >
                      <span className="min-w-0">{text}</span>
                    </Button>
                  </li>
                ) : null,
              )}
            </ol>
          ) : source?.text ? (
            <p className="text-base leading-relaxed break-words whitespace-pre-wrap">
              {source.text}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Lyrics appear when the track opens.</p>
          )}
        </div>
        {source?.lines.length ? (
          <p className="mt-2 shrink-0 text-xs text-muted-foreground">Click a line to jump there.</p>
        ) : null}
      </div>
    </section>
  );
}
