import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import {
  ExternalLink,
  Film,
  Maximize,
  Minimize,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Sparkles,
  Subtitles,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  DocumentTopBar,
  DocumentTopBarButton,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { Button } from '../components/ui/button';
import { isCaptionPath, mediaKindForPath } from '../lib/mediaFiles';
import { listenSafely } from '../lib/nativeSubscription';
import { type LocalPlaybackSource, tauriCommands } from '../lib/tauri';
import { cn } from '../lib/utils';
import { vaultTreeIndex } from '../lib/vaultTreeIndex';
import { useVaultStore } from '../store/vaultStore';

import { AudioArtwork, AudioLyrics } from './AudioPlayerContent';
import MediaAmbiance from './MediaAmbiance';
import {
  MediaErrorCard,
  MediaIconButton,
  type MediaSetting,
  MediaSpinner,
  SettingsMenu,
  ShortcutsCard,
  SkipIcon,
  SpeedMenu,
  Timeline,
  VolumeControl,
} from './MediaControls';
import { formatTime, speedLabel, SPEEDS } from './mediaFormat';
import { useFullscreenMediaDock } from './useFullscreenMediaDock';
import { controlsBox, useVideoBox } from './useVideoBox';

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
        meta={
          available ? (
            <DocumentTopBarButton
              onClick={() =>
                void tauriCommands
                  .openMediaExternally(vault.path, relativePath)
                  .catch((reason) => toast.error(String(reason)))
              }
            >
              <ExternalLink /> Open externally
            </DocumentTopBarButton>
          ) : null
        }
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
  const stage = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const controls = useFullscreenMediaDock(
    kind === 'video' && playing,
    Boolean(error || actionError),
  );
  const [ambiance, setAmbiance] = useState(() => localStorage.getItem(AMBIANCE_KEY) === 'true');
  const [buffered, setBuffered] = useState(0);
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const announceCompatibility = useRef(false);
  const lastCaption = useRef<string | null>(null);
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
    setBuffered(0);
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
            if (isMp4 && !compatibility) {
              announceCompatibility.current = true;
              setCompatibility(true);
            } else
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
    if (restore?.position && restore.position < media.duration) {
      media.currentTime = restore.position;
      if (restore.position >= 1) setResumedAt(restore.position);
    }
    if (announceCompatibility.current) {
      announceCompatibility.current = false;
      setNotice('Switched to compatible subtitles. Change it under Settings › Subtitle mode.');
    }
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

  function skip(seconds: number) {
    seek(position + seconds);
  }

  function changeVolume(value: number) {
    const media = element.current;
    if (!media) return;
    media.volume = Math.max(0, Math.min(1, value));
    if (media.muted && media.volume > 0) media.muted = false;
    setVolume(media.volume);
    setMuted(media.muted);
    remember(media);
  }

  function toggleMute() {
    const media = element.current;
    if (!media) return;
    media.muted = !media.muted;
    setMuted(media.muted);
    remember(media);
  }

  function changeRate(value: number) {
    const media = element.current;
    if (!media) return;
    media.playbackRate = value;
    setRate(media.playbackRate);
    remember(media);
  }

  function toggleCaptions() {
    const media = element.current;
    if (!media || !captionChoices.length) return;
    if (caption !== 'off') {
      lastCaption.current = caption;
      chooseCaption(media, 'off');
    } else {
      const previous = lastCaption.current;
      chooseCaption(
        media,
        previous && captionChoices.some((choice) => choice.value === previous) ? previous : '0',
      );
    }
  }

  function updateBuffered(media: HTMLMediaElement) {
    const ranges = media.buffered;
    let end = 0;
    for (let index = 0; index < ranges.length; index += 1) {
      if (ranges.start(index) <= media.currentTime + 0.5) end = Math.max(end, ranges.end(index));
    }
    setBuffered(end);
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
      updateBuffered(event.currentTarget);
    },
    onProgress: (event: React.SyntheticEvent<HTMLMediaElement>) =>
      updateBuffered(event.currentTarget),
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
          if (isMp4 && !compatibility && !hydrated.current) {
            announceCompatibility.current = true;
            setCompatibility(true);
          } else
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
  const captionFiles = useCaptionFiles(kind === 'video');
  const lyrics = source?.audioMetadata?.lyrics;
  const hasLyrics = Boolean(lyrics?.some((entry) => entry.text.trim()));
  const busy = status === 'Buffering…' || status === 'Seeking…';
  const video = kind === 'video';
  const bleed = video && ambiance && !fullscreen;
  // In a tab the controls follow the visible picture, not the letterboxed stage.
  const videoBox = useVideoBox(stage, element, video ? source?.id : undefined);
  const dockBox = video && !fullscreen && videoBox ? controlsBox(videoBox) : null;

  useEffect(() => {
    if (resumedAt === null) return;
    const timer = setTimeout(() => setResumedAt(null), 8000);
    return () => clearTimeout(timer);
  }, [resumedAt]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const settings: MediaSetting[] = [];
  if (ready && video)
    settings.push({
      id: 'speed',
      label: 'Speed',
      value: String(rate),
      choices: SPEEDS.map((speed) => ({ label: speedLabel(speed), value: String(speed) })),
      onSelect: (value) => changeRate(Number(value)),
    });
  if (video && captionChoices.length)
    settings.push({
      id: 'captions',
      label: 'Subtitles',
      value: caption,
      choices: [{ label: 'Off', value: 'off' }, ...captionChoices],
      onSelect: (value) => {
        setActionError('');
        if (element.current) chooseCaption(element.current, value);
      },
    });
  if (video && (captionFiles.length || captionPath))
    settings.push({
      id: 'caption-file',
      label: 'Caption file',
      value: captionPath ?? 'automatic',
      choices: [
        { label: 'Matching captions', value: 'automatic' },
        ...captionFiles.map((path) => ({ label: path, value: path })),
      ],
      onSelect: (value) => {
        if (element.current) remember(element.current);
        setCaptionPath(value === 'automatic' ? null : value);
      },
    });
  if (availableAudio.length > 1)
    settings.push({
      id: 'audio-track',
      label: 'Audio track',
      value: useIsolatedAudio ? String(isolatedAudio ?? 0) : audio,
      choices: availableAudio,
      onSelect: (value) => {
        const media = element.current;
        if (!media) return;
        if (useIsolatedAudio) {
          resumePlaying.current = !media.paused;
          remember(media);
          setIsolatedAudio(Number(value));
        } else chooseAudio(media, value);
      },
    });
  if (isMp4 && (compatibility || error))
    settings.push({
      id: 'subtitle-mode',
      label: 'Subtitle mode',
      value: compatibility ? 'compatibility' : 'auto',
      choices: [
        { label: 'Automatic', value: 'auto' },
        { label: 'Compatible subtitles', value: 'compatibility' },
      ],
      onSelect: (value) => {
        setCompatibility(value !== 'auto');
        setAttempt((n) => n + 1);
      },
    });

  function reload() {
    setCompatibility(false);
    setAttempt((n) => n + 1);
  }

  function toggleAmbiance() {
    const next = !ambiance;
    setAmbiance(next);
    localStorage.setItem(AMBIANCE_KEY, String(next));
  }

  function startOver() {
    setResumedAt(null);
    seek(0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (video) controls.reveal();
    if (event.key === 'Escape' && !event.defaultPrevented) {
      if (showShortcuts) {
        event.preventDefault();
        setShowShortcuts(false);
        return;
      }
      if (fullscreen) {
        event.preventDefault();
        void toggleFullscreen();
        return;
      }
    }
    // Keys typed while a slider or menu has focus belong to that control.
    const target = event.target as HTMLElement;
    const onSurface = target === event.currentTarget;
    const onButton = target instanceof HTMLButtonElement && !target.hasAttribute('aria-haspopup');
    if (!onSurface && !onButton) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === '?') {
      setShowShortcuts((open) => !open);
    } else if (!canPlay) {
      return;
    } else if (key === ' ' && onSurface) toggle();
    else if (key === 'k') toggle();
    else if (key === 'f' && video) void toggleFullscreen();
    else if (!ready) return;
    else if (key === 'ArrowLeft') skip(-5);
    else if (key === 'ArrowRight') skip(5);
    else if (key === 'j') skip(-10);
    else if (key === 'l') skip(10);
    else if (key === 'ArrowUp') changeVolume(volume + 0.05);
    else if (key === 'ArrowDown') changeVolume(volume - 0.05);
    else if (key === 'm') toggleMute();
    else if (key === 'c' && video) toggleCaptions();
    else if (/^[0-9]$/.test(key)) seek((duration * Number(key)) / 10);
    else return;
    event.preventDefault();
  }

  const timeline = (
    <Timeline
      overlay={video}
      position={scrub ?? position}
      duration={duration}
      buffered={buffered}
      disabled={!ready}
      onScrub={(value) => {
        pendingSeek.current = value;
        setScrub(value);
      }}
      onCommit={(value) => {
        seek(value);
        pendingSeek.current = null;
        setScrub(null);
      }}
      onRelease={() => {
        // Some WebViews deliver pointer-up before Radix sees the latest
        // controlled value. Commit the pending position in that case.
        if (pendingSeek.current === null) return;
        seek(pendingSeek.current);
        pendingSeek.current = null;
        setScrub(null);
      }}
      onCancel={() => {
        pendingSeek.current = null;
        setScrub(null);
      }}
    />
  );
  const playButtonLabel = playing ? 'Pause' : 'Play';
  const resumeChip =
    resumedAt !== null && !playing ? (
      <div
        className={cn(
          'flex items-center gap-2.5 rounded-full py-1 pr-1 pl-3 text-xs',
          video ? 'bg-black/75 text-white' : 'bg-muted text-foreground',
        )}
      >
        Resumed at {formatTime(resumedAt)}
        <Button
          size="xs"
          variant="ghost"
          className={cn('rounded-full', video && 'bg-white/10 text-white hover:bg-white/20')}
          onClick={startOver}
        >
          Start over
        </Button>
      </div>
    ) : null;
  const liveStatus = (
    <div role="status" className="sr-only">
      {error ? '' : status}
    </div>
  );
  const alerts = actionError ? (
    <div role="alert" className={cn('text-xs', video ? 'text-red-300' : 'text-destructive')}>
      {actionError}
    </div>
  ) : null;

  return (
    <div
      className={cn(
        '@container flex min-h-0 flex-1 flex-col items-center overflow-auto',
        // Ambient video bleeds to the pane edges; a padded, rounded frame
        // would leave a hard border where the glow stops.
        bleed ? 'p-0' : 'p-4',
      )}
    >
      <div
        ref={surface}
        className={cn(
          'isolate min-h-0 w-full text-card-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
          fullscreen
            ? 'fixed inset-0 z-50 bg-black'
            : bleed
              ? 'relative'
              : 'relative my-auto rounded-xl',
          video
            ? 'flex flex-1 flex-col'
            : cn(
                'grid max-w-6xl shrink-0 gap-x-12 gap-y-6 p-3 @3xl:p-8',
                hasLyrics && '@3xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]',
              ),
          video && !controls.show && 'cursor-none',
        )}
        tabIndex={0}
        role="region"
        aria-label={video ? 'Video player' : 'Audio player'}
        onPointerMove={video ? controls.reveal : undefined}
        onPointerDown={video ? controls.reveal : undefined}
        onKeyDown={onKeyDown}
      >
        {video ? (
          <div
            ref={stage}
            className={cn(
              'relative flex min-h-48 flex-1 items-center justify-center overflow-hidden',
              !fullscreen && !bleed && 'rounded-xl',
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
                onClick={() => {
                  if (canPlay) toggle();
                }}
              >
                {tracks}
              </video>
            ) : null}

            {error ? (
              <div className="absolute inset-0 z-20 grid place-items-center p-4">
                <MediaErrorCard message={error} onReload={reload} onOpenExternally={openExternal} />
              </div>
            ) : !ready ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-white/80">
                <MediaSpinner label={status} />
                {status}
              </div>
            ) : busy ? (
              <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/25">
                <MediaSpinner label={status} className="size-11" />
              </div>
            ) : !playing ? (
              <Button
                variant="ghost"
                aria-label="Play"
                onClick={toggle}
                className={cn(
                  'absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/20 bg-black/60 text-white hover:bg-black/75 hover:text-white dark:hover:bg-black/75',
                  fullscreen ? 'size-24 [&_svg]:size-10' : 'size-19 [&_svg]:size-8',
                )}
              >
                <Play className="fill-current" />
              </Button>
            ) : null}

            {notice ? (
              <div
                role="status"
                style={videoBox && !fullscreen ? { top: videoBox.top + 12 } : undefined}
                className="absolute inset-x-3 top-3 z-20 mx-auto flex max-w-md items-center gap-2 rounded-lg bg-black/85 py-1.5 pr-1.5 pl-3 text-xs text-white"
              >
                <span className="flex-1">{notice}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-white hover:bg-white/15 hover:text-white"
                  onClick={() => setNotice('')}
                >
                  Dismiss
                </Button>
              </div>
            ) : null}

            {fullscreen && controls.show ? (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between bg-linear-to-t from-transparent to-black/70 px-7 pt-5 pb-14 text-white">
                <div className="min-w-0">
                  <p className="truncate text-lg font-semibold">{filename}</p>
                  <p className="truncate text-xs text-white/70">
                    {getDocumentFolderPath(relativePath)}
                  </p>
                </div>
                <span className="text-xs text-white/75">
                  <kbd className="rounded border border-white/35 px-1.5 font-mono">Esc</kbd> exit
                  fullscreen
                </span>
              </div>
            ) : null}

            {showShortcuts ? (
              <div className="absolute top-4 right-4 z-30">
                <ShortcutsCard video onClose={() => setShowShortcuts(false)} />
              </div>
            ) : null}

            <div
              ref={controls.dock}
              role="group"
              aria-label="Playback controls"
              data-visible={controls.show}
              onFocusCapture={controls.reveal}
              onBlurCapture={controls.reveal}
              onPointerLeave={controls.reveal}
              style={dockBox ?? undefined}
              className={cn(
                'absolute z-10 space-y-1 bg-linear-to-b from-transparent to-black/80 text-white transition-opacity app-motion-fast',
                !dockBox && 'inset-x-0 bottom-0',
                fullscreen ? 'px-7 pt-20 pb-5' : 'px-3 pt-14 pb-2',
                (!controls.show || error) && 'pointer-events-none opacity-0',
              )}
            >
              {resumeChip ? <div className="mb-2 flex">{resumeChip}</div> : null}
              {alerts}
              <div className="px-1.5">{timeline}</div>
              <div className="flex flex-wrap items-center gap-0.5">
                <MediaIconButton
                  overlay
                  aria-label={playButtonLabel}
                  disabled={!canPlay}
                  onClick={toggle}
                >
                  {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
                </MediaIconButton>
                <MediaIconButton
                  overlay
                  aria-label="Back 10 seconds"
                  disabled={!ready}
                  onClick={() => skip(-10)}
                >
                  <SkipIcon direction={-1} />
                </MediaIconButton>
                <MediaIconButton
                  overlay
                  aria-label="Forward 10 seconds"
                  disabled={!ready}
                  onClick={() => skip(10)}
                >
                  <SkipIcon direction={1} />
                </MediaIconButton>
                <VolumeControl
                  overlay
                  volume={volume}
                  muted={muted}
                  disabled={!ready}
                  onToggleMute={toggleMute}
                  onVolume={changeVolume}
                />
                <span className="ml-3 font-mono text-[13px] tabular-nums">
                  {formatTime(scrub ?? position)}
                  <span className="text-white/65"> / {formatTime(duration)}</span>
                </span>
                <span className="flex-1" />
                {captionChoices.length ? (
                  <MediaIconButton
                    overlay
                    aria-label="Subtitles"
                    title="Subtitles (C)"
                    pressed={caption !== 'off'}
                    disabled={!ready}
                    onClick={toggleCaptions}
                  >
                    <Subtitles />
                  </MediaIconButton>
                ) : null}
                <SettingsMenu
                  overlay
                  settings={settings}
                  onOpenChange={controls.onMenuOpenChange}
                />
                <MediaIconButton
                  overlay
                  aria-label="Ambiance mode"
                  title="Ambiance mode"
                  pressed={ambiance}
                  onClick={toggleAmbiance}
                >
                  <Sparkles />
                </MediaIconButton>
                <MediaIconButton
                  overlay
                  aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                  title={fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
                  onClick={() => void toggleFullscreen()}
                >
                  {fullscreen ? <Minimize /> : <Maximize />}
                </MediaIconButton>
              </div>
            </div>
            {liveStatus}
          </div>
        ) : (
          <>
            <div
              className={cn(
                'flex w-full max-w-md min-w-0 flex-col gap-5 justify-self-center',
                hasLyrics && '@3xl:max-w-none',
              )}
            >
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
              {error ? (
                <MediaErrorCard message={error} onReload={reload} onOpenExternally={openExternal} />
              ) : (
                <div
                  ref={controls.dock}
                  role="group"
                  aria-label="Playback controls"
                  className="space-y-4"
                >
                  <div>
                    {timeline}
                    <div className="flex justify-between font-mono text-xs text-muted-foreground tabular-nums">
                      <span>{formatTime(scrub ?? position)}</span>
                      <span>{formatTime(duration)}</span>
                    </div>
                  </div>
                  <div className="flex items-center justify-center gap-4">
                    <MediaIconButton
                      aria-label="Back 10 seconds"
                      disabled={!ready}
                      onClick={() => skip(-10)}
                      className="size-11 rounded-full [&_svg:not([class*=size-])]:size-6"
                    >
                      <SkipIcon direction={-1} />
                    </MediaIconButton>
                    <Button
                      aria-label={ready ? playButtonLabel : status}
                      disabled={!canPlay}
                      onClick={toggle}
                      className="size-16 rounded-full shadow-lg shadow-primary/25 [&_svg:not([class*=size-])]:size-7"
                    >
                      {!ready ? (
                        <MediaSpinner
                          label={status}
                          className="size-7 border-primary-foreground/30 border-t-primary-foreground"
                        />
                      ) : playing ? (
                        <Pause className="fill-current" />
                      ) : (
                        <Play className="fill-current" />
                      )}
                    </Button>
                    <MediaIconButton
                      aria-label="Forward 10 seconds"
                      disabled={!ready}
                      onClick={() => skip(10)}
                      className="size-11 rounded-full [&_svg:not([class*=size-])]:size-6"
                    >
                      <SkipIcon direction={1} />
                    </MediaIconButton>
                  </div>
                  {resumeChip ? <div className="flex justify-center">{resumeChip}</div> : null}
                  <div className="flex items-center gap-1 border-t border-border/50 pt-2">
                    <VolumeControl
                      volume={volume}
                      muted={muted}
                      disabled={!ready}
                      onToggleMute={toggleMute}
                      onVolume={changeVolume}
                    />
                    <span className="flex-1" />
                    <SpeedMenu
                      rate={rate}
                      disabled={!ready}
                      onSelect={changeRate}
                      onOpenChange={controls.onMenuOpenChange}
                    />
                    <MediaIconButton
                      aria-label="Ambiance mode"
                      title="Ambiance mode"
                      pressed={ambiance}
                      onClick={toggleAmbiance}
                    >
                      <Sparkles />
                    </MediaIconButton>
                    <SettingsMenu
                      settings={settings}
                      onOpenChange={controls.onMenuOpenChange}
                      icon={<MoreHorizontal />}
                      label="More options"
                    />
                  </div>
                  {alerts}
                </div>
              )}
              {liveStatus}
            </div>
            {hasLyrics ? (
              <AudioLyrics
                key={source ? `lyrics-${source.id}` : undefined}
                lyrics={lyrics}
                position={position}
                ready={ready}
                onSeek={seek}
              />
            ) : source && !error ? (
              <p className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
                No lyrics. Add a matching .lrc file beside this track to show them.
              </p>
            ) : null}
            {showShortcuts ? (
              <div className="fixed right-6 bottom-6 z-40">
                <ShortcutsCard video={false} onClose={() => setShowShortcuts(false)} />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function useCaptionFiles(enabled: boolean): string[] {
  const tree = useVaultStore((state) => state.fileTree);
  if (!enabled) return [];
  return vaultTreeIndex(tree)
    .files.filter((file) => isCaptionPath(file.relativePath))
    .map((file) => file.relativePath);
}
