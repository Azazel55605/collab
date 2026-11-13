import { useEffect, useRef, useState } from 'react';

import {
  ExternalLink,
  Film,
  Maximize,
  Minimize,
  Music2,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Volume2,
  VolumeX,
} from 'lucide-react';

import {
  DocumentTopBar,
  DocumentTopBarButton,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { Button } from '../components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Slider } from '../components/ui/slider';
import { isCaptionPath, mediaKindForPath } from '../lib/mediaFiles';
import { listenSafely } from '../lib/nativeSubscription';
import { type LocalPlaybackSource, tauriCommands } from '../lib/tauri';
import { cn } from '../lib/utils';
import { vaultTreeIndex } from '../lib/vaultTreeIndex';
import { useVaultStore } from '../store/vaultStore';

import { AudioArtwork, AudioLyrics } from './AudioPlayerContent';
import MediaAmbiance from './MediaAmbiance';
import { useFullscreenMediaDock } from './useFullscreenMediaDock';

interface Resume {
  revision: string;
  position: number;
  rate: number;
  volume: number;
  muted: boolean;
  caption: string;
  captionPath: string | null;
  audio: string;
  isolatedAudio: number | null;
  compatibility: boolean;
}
interface AudioTrack {
  label: string;
  language: string;
  enabled: boolean;
}
type AudioTrackList = ArrayLike<AudioTrack> & EventTarget;

const AMBIANCE_KEY = 'collab-media-ambiance';
const recent = new Map<string, Resume>();
useVaultStore.subscribe((next, previous) => {
  if (next.vault !== previous.vault || next.isVaultLocked) recent.clear();
});

function audioTracks(media: HTMLMediaElement) {
  return (media as HTMLMediaElement & { audioTracks?: AudioTrackList }).audioTracks;
}

function formatTime(seconds: number) {
  const whole = Math.floor(Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = String(whole % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`;
}

function Choice({
  label,
  value,
  onChange,
  choices,
  onOpenChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  choices: { label: string; value: string }[];
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange} onOpenChange={onOpenChange}>
      <SelectTrigger aria-label={label} size="sm" className="max-w-56">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem value={choice.value} key={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function MediaView({ relativePath }: { relativePath: string }) {
  const vault = useVaultStore((state) => state.vault);
  const locked = useVaultStore((state) => state.isVaultLocked);
  const kind = mediaKindForPath(relativePath);
  const available = vault && !locked && vault.kind !== 'hosted' && !vault.isEncrypted && kind;
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <DocumentTopBar
        title={getDocumentBaseName(relativePath, 'Media')}
        subtitle={getDocumentFolderPath(relativePath)}
        icon={kind === 'audio' ? <Music2 size={16} /> : <Film size={16} />}
      />
      {available ? (
        <LocalPlayer
          key={JSON.stringify([vault.path, relativePath])}
          vaultPath={vault.path}
          relativePath={relativePath}
          kind={kind}
        />
      ) : (
        <div role="status" className="m-auto px-6 text-center text-sm text-muted-foreground">
          {vault?.kind === 'hosted'
            ? 'Playback is currently available in local vaults. Use Download from Files to save a copy.'
            : 'Playback requires an unencrypted local vault.'}
        </div>
      )}
    </div>
  );
}

function LocalPlayer({
  vaultPath,
  relativePath,
  kind,
}: {
  vaultPath: string;
  relativePath: string;
  kind: 'audio' | 'video';
}) {
  const vault = useVaultStore.getState().vault;
  const scope = JSON.stringify([vaultPath, relativePath]);
  const [captionPath, setCaptionPath] = useState<string | null>(
    () => recent.get(scope)?.captionPath ?? null,
  );
  const [attempt, setAttempt] = useState(0);
  const [compatibility, setCompatibility] = useState(
    () => recent.get(scope)?.compatibility ?? false,
  );
  const [isolatedAudio, setIsolatedAudio] = useState<number | null>(
    () => recent.get(scope)?.isolatedAudio ?? null,
  );
  const isMp4 = /\.mp4$/i.test(relativePath);
  const [source, setSource] = useState<LocalPlaybackSource | null>(null);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [status, setStatus] = useState('Opening media…');
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const resumePlaying = useRef(false);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [caption, setCaption] = useState('off');
  const [audio, setAudio] = useState('0');
  const [captionChoices, setCaptionChoices] = useState<{ label: string; value: string }[]>([]);
  const [audioChoices, setAudioChoices] = useState<{ label: string; value: string }[]>([]);
  const element = useRef<HTMLMediaElement | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const controls = useFullscreenMediaDock(fullscreen, Boolean(error || actionError));
  const [ambiance, setAmbiance] = useState(() => localStorage.getItem(AMBIANCE_KEY) === 'true');
  const restoreWindow = useRef<(() => Promise<void>) | null>(null);
  const fullscreenPending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void restoreWindow.current?.().catch(() => {});
      restoreWindow.current = null;
    };
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    document.body.classList.add('media-fullscreen');
    return () => document.body.classList.remove('media-fullscreen');
  }, [fullscreen]);

  async function toggleFullscreen() {
    if (fullscreenPending.current) return;
    fullscreenPending.current = true;
    try {
      if (restoreWindow.current) {
        await restoreWindow.current();
        restoreWindow.current = null;
        if (mounted.current) setFullscreen(false);
      } else {
        const restore = await tauriCommands.enterMediaFullscreen();
        if (!mounted.current) {
          await restore();
          return;
        }
        restoreWindow.current = restore;
        setFullscreen(true);
        surface.current?.focus({ preventScroll: true });
      }
    } catch {
      if (mounted.current) setActionError('Fullscreen is unavailable.');
    } finally {
      fullscreenPending.current = false;
    }
  }
  const failed = useRef(false);
  const liveId = useRef<string | null>(null);
  const hydrated = useRef(false);
  const selection = useRef({ caption: 'off', audio: '0' });
  const autoCaption = useRef(false);

  useEffect(() => {
    let disposed = false;
    let id: string | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    failed.current = false;
    hydrated.current = false;
    setSource(null);
    setError('');
    setActionError('');
    setDuration(0);
    setPosition(0);
    setPlaying(false);
    setScrub(null);
    pendingSeek.current = null;
    setStatus(compatibility ? 'Opening with compatible subtitles…' : 'Opening media…');
    setCaptionChoices([]);
    setAudioChoices([]);
    const restore = recent.get(scope);
    autoCaption.current = captionPath !== null && captionPath !== restore?.captionPath;
    selection.current = { caption: restore?.caption ?? 'off', audio: restore?.audio ?? '0' };
    void tauriCommands
      .openLocalPlayback(vaultPath, relativePath, captionPath, compatibility, isolatedAudio)
      .then(
        (opened) => {
          if (disposed) {
            void tauriCommands.closeLocalPlayback(opened.id).catch(() => {});
            return;
          }
          id = opened.id;
          liveId.current = id;
          if (restore?.revision !== opened.revision) {
            selection.current = { caption: 'off', audio: '0' };
            recent.delete(scope);
            if (restore && isolatedAudio !== null) {
              void tauriCommands.closeLocalPlayback(opened.id).catch(() => {});
              setIsolatedAudio(null);
              return;
            }
          }
          setSource(opened);
          startupTimer = setTimeout(() => {
            if (disposed || failed.current || hydrated.current) return;
            failed.current = true;
            element.current?.pause();
            void tauriCommands.closeLocalPlayback(opened.id).catch(() => {});
            setSource(null);
            if (isMp4 && !compatibility) setCompatibility(true);
            else
              setError(
                'The player did not receive media metadata. Reload or open the file externally.',
              );
          }, 8000);
          timer = setInterval(() => {
            void tauriCommands.checkLocalPlayback(opened.id).catch((reason) => {
              if (disposed || failed.current) return;
              failed.current = true;
              element.current?.pause();
              setError(String(reason));
              setSource(null);
            });
          }, 5000);
        },
        (reason) => {
          if (!disposed) {
            setError(
              compatibility ? `MP4 compatibility retry failed. ${String(reason)}` : String(reason),
            );
          }
        },
      );
    return () => {
      disposed = true;
      liveId.current = null;
      clearInterval(timer);
      clearTimeout(startupTimer);
      if (id) void tauriCommands.closeLocalPlayback(id).catch(() => {});
    };
  }, [attempt, captionPath, compatibility, isMp4, isolatedAudio, relativePath, scope, vaultPath]);

  function remember(media: HTMLMediaElement) {
    if (
      !source ||
      !hydrated.current ||
      failed.current ||
      !Number.isFinite(media.currentTime) ||
      useVaultStore.getState().vault !== vault
    )
      return;
    recent.delete(scope);
    recent.set(scope, {
      revision: source.revision,
      position: media.ended ? 0 : media.currentTime,
      rate: media.playbackRate,
      volume: media.volume,
      muted: media.muted,
      ...selection.current,
      captionPath,
      isolatedAudio,
      compatibility,
    });
    if (recent.size > 64) recent.delete(recent.keys().next().value!);
  }

  function chooseCaption(media: HTMLMediaElement, value: string) {
    selection.current.caption = value;
    Array.from(media.textTracks).forEach((track, index) => {
      track.mode = String(index) === value ? 'showing' : 'disabled';
    });
    setCaption(value);
    remember(media);
  }

  function chooseAudio(media: HTMLMediaElement, value: string) {
    selection.current.audio = value;
    Array.from(audioTracks(media) ?? []).forEach((track, index) => {
      track.enabled = String(index) === value;
    });
    setAudio(value);
    remember(media);
  }

  function refreshTracks(media: HTMLMediaElement) {
    const text = Array.from(media.textTracks);
    const audio = Array.from(audioTracks(media) ?? []);
    setCaptionChoices(
      text.map((track, index) => ({
        label: track.label || [track.language, `Caption ${index + 1}`].filter(Boolean).join(' · '),
        value: String(index),
      })),
    );
    setAudioChoices(
      audio.map((track, index) => ({
        label: [track.label || track.language, `Track ${index + 1}`].filter(Boolean).join(' · '),
        value: String(index),
      })),
    );
    if (!hydrated.current) return;
    const selected = selection.current;
    if (autoCaption.current) {
      const sidecar = media.querySelector('track');
      const index = sidecar ? text.indexOf(sidecar.track) : -1;
      if (index >= 0) {
        autoCaption.current = false;
        chooseCaption(media, String(index));
      }
    } else if (selected.caption === 'off' || text[Number(selected.caption)]) {
      chooseCaption(media, selected.caption);
    }
    if (isolatedAudio !== null) {
      if (audio.length === 1 && !audio[0].enabled) audio[0].enabled = true;
    } else if (audio[Number(selected.audio)]) chooseAudio(media, selected.audio);
  }

  useEffect(() => {
    const media = element.current;
    if (!source || !media) return;
    const tracks = audioTracks(media);
    const refresh = () => refreshTracks(media);
    const pause = () => media.pause();
    const stopOnHidden = () => {
      if (document.hidden) pause();
    };
    const unlisten = listenSafely('background:window-hidden', pause);
    document.addEventListener('visibilitychange', stopOnHidden);
    media.textTracks.addEventListener('addtrack', refresh);
    media.textTracks.addEventListener('removetrack', refresh);
    tracks?.addEventListener('addtrack', refresh);
    tracks?.addEventListener('removetrack', refresh);
    return () => {
      unlisten();
      document.removeEventListener('visibilitychange', stopOnHidden);
      media.textTracks.removeEventListener('addtrack', refresh);
      media.textTracks.removeEventListener('removetrack', refresh);
      tracks?.removeEventListener('addtrack', refresh);
      remember(media);
      media.pause();
      media.removeAttribute('src');
      media.querySelectorAll('track').forEach((track) => track.removeAttribute('src'));
      media.load();
    };
    // The element and its saved state are owned by this source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  function metadata(media: HTMLMediaElement) {
    if (!Number.isFinite(media.duration)) return;
    setDuration(media.duration);
    const restore = source && recent.get(scope);
    media.playbackRate = restore?.rate ?? 1;
    media.volume = restore?.volume ?? 1;
    media.muted = restore?.muted ?? false;
    if (restore?.position && restore.position < media.duration)
      media.currentTime = restore.position;
    setRate(media.playbackRate);
    setVolume(media.volume);
    setMuted(media.muted);
    setPosition(media.currentTime);
    setStatus('Paused');
    hydrated.current = true;
    refreshTracks(media);
    if (resumePlaying.current) {
      resumePlaying.current = false;
      void media.play().catch(() => setActionError('Press Play to resume.'));
    }
  }

  function seek(target: number) {
    const media = element.current;
    if (!media || !Number.isFinite(media.duration)) return;
    media.currentTime = Math.max(0, Math.min(target, media.duration));
    setPosition(media.currentTime);
    remember(media);
  }

  function toggle() {
    const media = element.current;
    if (!media) return;
    if (media.paused) void media.play().catch(() => setActionError('Could not start playback.'));
    else media.pause();
  }

  function openExternal() {
    setActionError('');
    void tauriCommands.openMediaExternally(vaultPath, relativePath).catch((reason) => {
      setActionError(String(reason));
    });
  }

  const mediaProps = {
    src: source?.url,
    preload: 'metadata',
    crossOrigin: 'anonymous' as const,
    onLoadedMetadata: (event: React.SyntheticEvent<HTMLMediaElement>) =>
      metadata(event.currentTarget),
    onTimeUpdate: (event: React.SyntheticEvent<HTMLMediaElement>) => {
      setPosition(event.currentTarget.currentTime);
    },
    onPlay: () => {
      setPlaying(true);
      setActionError('');
    },
    onPlaying: () => setStatus('Playing'),
    onWaiting: () => setStatus('Buffering…'),
    onSeeking: () => setStatus('Seeking…'),
    onSeeked: (event: React.SyntheticEvent<HTMLMediaElement>) => {
      setStatus(event.currentTarget.paused ? 'Paused' : 'Playing');
      remember(event.currentTarget);
    },
    onPause: (event: React.SyntheticEvent<HTMLMediaElement>) => {
      setPlaying(false);
      setStatus(event.currentTarget.ended ? 'Finished' : 'Paused');
      remember(event.currentTarget);
    },
    onEnded: (event: React.SyntheticEvent<HTMLMediaElement>) => {
      setStatus('Finished');
      remember(event.currentTarget);
    },
    onError: () => {
      if (!source) return;
      const id = source.id;
      const reject = (message: string) => {
        if (liveId.current !== id || failed.current) return;
        failed.current = true;
        setError(message);
        setSource(null);
        void tauriCommands.closeLocalPlayback(id).catch(() => {});
      };
      void tauriCommands.checkLocalPlayback(id).then(
        () => {
          if (liveId.current !== id || failed.current) return;
          if (isMp4 && !compatibility && !hydrated.current) setCompatibility(true);
          else
            reject('This file could not be played. Its codec may be unsupported by this device.');
        },
        (reason) => reject(String(reason)),
      );
    },
  };
  const tracks = source?.captions.map((track) => (
    <track
      key={track.url}
      kind="subtitles"
      label={[track.label, track.language].filter(Boolean).join(' · ')}
      srcLang={track.language || 'und'}
      src={track.url}
      onError={() => setActionError(`Could not load captions from ${track.label}.`)}
    />
  ));
  const canPlay = source !== null && !error;
  const ready = duration > 0 && !error;
  const nativeAudio = source?.audioTracks ?? [];
  const useIsolatedAudio = isolatedAudio !== null || audioChoices.length < nativeAudio.length;
  const availableAudio = useIsolatedAudio
    ? nativeAudio.map((language, index) => ({
        label: [language, `Track ${index + 1}`].filter(Boolean).join(' · '),
        value: String(index),
      }))
    : audioChoices;
  const filename = getDocumentBaseName(relativePath, 'Media');

  return (
    <div className="@container flex min-h-0 flex-1 flex-col items-center overflow-auto p-4">
      <div
        ref={surface}
        className={cn(
          'isolate min-h-0 w-full text-card-foreground focus-visible:outline-ring',
          fullscreen
            ? 'fixed inset-0 z-50 bg-background'
            : ambiance || kind === 'audio'
              ? 'relative my-auto'
              : 'relative my-auto overflow-hidden rounded-xl border border-border/65',
          kind === 'video'
            ? 'flex flex-1 flex-col'
            : 'grid max-w-6xl shrink-0 gap-x-8 gap-y-4 p-3 @3xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @3xl:p-8',
          !controls.show && 'cursor-none',
        )}
        tabIndex={0}
        role="region"
        aria-label={kind === 'video' ? 'Video player' : 'Audio player'}
        onPointerMove={fullscreen ? controls.reveal : undefined}
        onPointerDown={fullscreen ? controls.reveal : undefined}
        onKeyDown={(event) => {
          if (fullscreen) controls.reveal();
          if (event.key === 'Escape' && fullscreen && !event.defaultPrevented) {
            event.preventDefault();
            void toggleFullscreen();
            return;
          }
          if (event.target !== event.currentTarget || !canPlay) return;
          if (event.key.toLowerCase() === 'f' && kind === 'video') {
            event.preventDefault();
            void toggleFullscreen();
            return;
          }
          if (event.key === ' ') toggle();
          else if (!ready) return;
          else if (event.key === 'ArrowLeft') seek(position - 5);
          else if (event.key === 'ArrowRight') seek(position + 5);
          else return;
          event.preventDefault();
        }}
      >
        {kind === 'video' ? (
          <div
            className={cn(
              'relative flex min-h-0 flex-1 items-center justify-center',
              !fullscreen && 'min-h-32',
              !ambiance && 'bg-black',
            )}
          >
            {ambiance && source ? <MediaAmbiance media={element} key={source.id} /> : null}
            {source ? (
              <video
                key={source.id}
                {...mediaProps}
                ref={(node) => {
                  element.current = node;
                }}
                playsInline
                className="absolute inset-0 size-full object-contain"
                aria-label={filename}
              >
                {tracks}
              </video>
            ) : (
              <Film className="text-white/40" aria-hidden="true" />
            )}
          </div>
        ) : (
          <>
            <AudioArtwork
              key={source?.audioMetadata?.artworkUrl}
              filename={filename}
              metadata={source?.audioMetadata}
              ambiance={ambiance}
            />
            {source ? (
              <audio
                key={source.id}
                {...mediaProps}
                ref={(node) => {
                  element.current = node;
                }}
                aria-label={filename}
              >
                {tracks}
              </audio>
            ) : null}
          </>
        )}
        <div
          ref={controls.dock}
          role="group"
          aria-label="Playback controls"
          data-visible={controls.show}
          onFocusCapture={controls.reveal}
          onBlurCapture={controls.reveal}
          onPointerLeave={controls.reveal}
          className={cn(
            'z-10 space-y-2',
            fullscreen
              ? 'absolute inset-x-0 bottom-5 mx-auto w-[min(44rem,calc(100%_-_2rem))] rounded-2xl bg-card/95 p-3 shadow-lg transition-opacity app-motion-fast'
              : kind === 'audio'
                ? 'min-w-0 @3xl:col-start-1 @3xl:row-start-2'
                : ambiance
                  ? 'shrink-0 rounded-xl bg-card/65 p-4'
                  : 'shrink-0 bg-card/90 p-4',
            !controls.show && 'pointer-events-none opacity-0',
          )}
        >
          <div className="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
            <span>{formatTime(scrub ?? position)}</span>
            <Slider
              aria-label="Playback position"
              aria-valuetext={formatTime(scrub ?? position)}
              min={0}
              max={duration || 1}
              step={0.1}
              value={[scrub ?? position]}
              onValueChange={([value]) => {
                pendingSeek.current = value;
                setScrub(value);
              }}
              onValueCommit={([value]) => {
                seek(value);
                pendingSeek.current = null;
                setScrub(null);
              }}
              onPointerUp={() => {
                // Some WebViews deliver pointer-up before Radix sees the latest
                // controlled value. Commit the pending position in that case.
                if (pendingSeek.current === null) return;
                seek(pendingSeek.current);
                pendingSeek.current = null;
                setScrub(null);
              }}
              onPointerCancel={() => {
                pendingSeek.current = null;
                setScrub(null);
              }}
              disabled={!ready}
            />
            <span>{formatTime(duration)}</span>
          </div>
          <div className={cn('flex flex-wrap items-center gap-2', fullscreen && 'justify-center')}>
            <Button size="sm" disabled={!canPlay} onClick={toggle}>
              {playing ? <Pause /> : <Play />} {playing ? 'Pause' : 'Play'}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={muted ? 'Unmute' : 'Mute'}
              disabled={!ready}
              onClick={() => {
                const media = element.current;
                if (!media) return;
                media.muted = !media.muted;
                setMuted(media.muted);
                remember(media);
              }}
            >
              {muted ? <VolumeX /> : <Volume2 />}
            </Button>
            <Slider
              className="w-20"
              aria-label="Volume"
              min={0}
              max={1}
              step={0.05}
              value={[volume]}
              disabled={!ready}
              onValueChange={([value]) => {
                const media = element.current;
                if (!media) return;
                media.volume = value;
                setVolume(value);
                remember(media);
              }}
            />
            {ready ? (
              <Choice
                label="Playback speed"
                onOpenChange={controls.onMenuOpenChange}
                value={String(rate)}
                choices={[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => ({
                  label: `${value}×`,
                  value: String(value),
                }))}
                onChange={(value) => {
                  const media = element.current;
                  if (!media) return;
                  media.playbackRate = Number(value);
                  setRate(media.playbackRate);
                  remember(media);
                }}
              />
            ) : null}
            {kind === 'video' && captionChoices.length ? (
              <Choice
                label="Captions"
                onOpenChange={controls.onMenuOpenChange}
                value={caption}
                choices={[{ label: 'Captions off', value: 'off' }, ...captionChoices]}
                onChange={(value) => {
                  setActionError('');
                  if (element.current) chooseCaption(element.current, value);
                }}
              />
            ) : null}
            {availableAudio.length > 1 ? (
              <Choice
                label="Audio track"
                onOpenChange={controls.onMenuOpenChange}
                value={useIsolatedAudio ? String(isolatedAudio ?? 0) : audio}
                choices={availableAudio}
                onChange={(value) => {
                  const media = element.current;
                  if (!media) return;
                  if (useIsolatedAudio) {
                    resumePlaying.current = !media.paused;
                    remember(media);
                    setIsolatedAudio(Number(value));
                  } else chooseAudio(media, value);
                }}
              />
            ) : null}
            {isMp4 && (compatibility || error) ? (
              <Choice
                label="MP4 subtitle mode"
                onOpenChange={controls.onMenuOpenChange}
                value={compatibility ? 'compatibility' : 'auto'}
                choices={[
                  { label: 'Automatic subtitles', value: 'auto' },
                  { label: 'Compatible subtitles', value: 'compatibility' },
                ]}
                onChange={(value) => {
                  setCompatibility(value !== 'auto');
                  setAttempt((n) => n + 1);
                }}
              />
            ) : null}
            {kind === 'video' ? (
              <CaptionPicker
                onOpenChange={controls.onMenuOpenChange}
                captionPath={captionPath}
                onChange={(path) => {
                  if (element.current) remember(element.current);
                  setCaptionPath(path);
                }}
              />
            ) : null}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Ambiance mode"
              aria-pressed={ambiance}
              title="Ambiance mode"
              onClick={() => {
                const next = !ambiance;
                setAmbiance(next);
                localStorage.setItem(AMBIANCE_KEY, String(next));
              }}
            >
              <Sparkles />
            </Button>
            {kind === 'video' ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                title={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                onClick={() => void toggleFullscreen()}
              >
                {fullscreen ? <Minimize /> : <Maximize />}
              </Button>
            ) : null}
            <DocumentTopBarButton
              className={fullscreen && !error ? 'hidden' : undefined}
              onClick={openExternal}
            >
              <ExternalLink /> Open externally
            </DocumentTopBarButton>
          </div>
          {error ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span role="alert" className="text-destructive">
                {error}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCompatibility(false);
                  setAttempt((n) => n + 1);
                }}
              >
                <RotateCcw /> Reload
              </Button>
            </div>
          ) : (
            <div role="status" className={fullscreen ? 'sr-only' : 'text-xs text-muted-foreground'}>
              {status}
            </div>
          )}
          {compatibility && ready && !fullscreen ? (
            <p className="text-xs text-muted-foreground">
              Compatible subtitle mode. Supported embedded text tracks and sidecar captions are
              available.
            </p>
          ) : null}
          {actionError ? (
            <div role="alert" className="text-xs text-destructive">
              {actionError}
            </div>
          ) : null}
        </div>
        {kind === 'audio' ? (
          <AudioLyrics
            key={source ? `lyrics-${source.id}` : undefined}
            lyrics={source?.audioMetadata?.lyrics ?? (source ? [] : undefined)}
            position={position}
            ready={ready}
            onSeek={seek}
          />
        ) : null}
      </div>
    </div>
  );
}

function CaptionPicker({
  captionPath,
  onChange,
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
  captionPath: string | null;
  onChange: (path: string | null) => void;
}) {
  const tree = useVaultStore((state) => state.fileTree);
  const files = vaultTreeIndex(tree).files.filter((file) => isCaptionPath(file.relativePath));
  if (!files.length && !captionPath) return null;
  return (
    <Choice
      label="Caption file"
      onOpenChange={onOpenChange}
      value={captionPath ?? 'automatic'}
      onChange={(value) => onChange(value === 'automatic' ? null : value)}
      choices={[
        { label: 'Matching captions', value: 'automatic' },
        ...files.map((file) => ({ label: file.relativePath, value: file.relativePath })),
      ]}
    />
  );
}
