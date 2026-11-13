import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { Music2 } from 'lucide-react';

import { Button } from '../components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
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
    <div className="min-w-0 @3xl:col-start-1 @3xl:row-start-1">
      {ambiance && artworkUrl && !failed ? (
        <div
          aria-hidden="true"
          ref={backdrop}
          className="pointer-events-none absolute inset-0 -z-10 mask-[radial-gradient(ellipse_closest-side,#000_55%,transparent)]"
        />
      ) : null}
      <div className="relative mx-auto aspect-square w-full max-w-72 overflow-hidden rounded-xl bg-muted @3xl:mx-0 @3xl:max-w-none">
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
      <h2 className="mt-4 text-xl leading-tight font-semibold break-words">{title}</h2>
      {details ? <p className="mt-1 text-sm break-words text-muted-foreground">{details}</p> : null}
    </div>
  );
});

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

  useEffect(() => {
    const container = list.current;
    const line = activeLine.current;
    if (!container) return;
    if (active < 0) {
      container.scrollTop = 0;
      return;
    }
    if (!line) return;
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
      aria-label="Lyrics"
      className="relative min-h-0 min-w-0 border-t border-border/50 pt-4 @3xl:col-start-2 @3xl:row-span-2 @3xl:row-start-1 @3xl:border-t-0 @3xl:border-l @3xl:pt-0 @3xl:pl-8"
    >
      <div className="flex max-h-96 min-h-0 flex-col @3xl:absolute @3xl:inset-y-0 @3xl:right-0 @3xl:left-8 @3xl:max-h-none">
        <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Lyrics</h3>
          {sources.length > 1 ? (
            <Select value={source?.label} onValueChange={setSelected}>
              <SelectTrigger aria-label="Lyrics source" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sources.map(({ label }) => (
                  <SelectItem key={label} value={label}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2">
          {source?.lines.length ? (
            <ol className="space-y-1">
              {source.lines.map(({ time, text }, index) =>
                text ? (
                  <li key={time}>
                    <Button
                      ref={index === active ? activeLine : undefined}
                      variant="ghost"
                      className={cn(
                        'h-auto w-full justify-start border-0 border-l-2 border-transparent px-3 py-2 text-left text-base leading-snug break-words whitespace-pre-wrap',
                        index === active
                          ? 'border-primary bg-primary/10 font-semibold text-foreground'
                          : 'text-muted-foreground',
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
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{source.text}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {lyrics
                ? 'No lyrics found. Add a matching .lrc file beside this track.'
                : 'Lyrics appear when the track opens.'}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
