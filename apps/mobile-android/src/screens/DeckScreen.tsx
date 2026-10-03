/**
 * Mobile presentation companion (Phase 8): view a `.deck`, read its speaker
 * notes, present it from the phone, and drive a show running on the same
 * account's computer.
 *
 * The phone never composes slides and never writes the deck. Rendering,
 * playback rules, and the remote protocol are the desktop's own
 * (`src/lib/deck/`, `DeckSlide`); this screen only arranges them for touch.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  Crosshair,
  MonitorPlay,
  Play,
  Radio,
  Smartphone,
  Square,
  StickyNote,
  X,
} from 'lucide-react';

import { animationCss, animationTimeline } from '../../../../src/lib/deck/animation';
import {
  createDirectRemoteOffer,
  directRemoteMessage,
  supportsDirectRemote,
  validDirectSdp,
} from '../../../../src/lib/deck/directRemote';
import {
  initialPlayback,
  playbackProgress,
  playbackReducer,
} from '../../../../src/lib/deck/playback';
import type {
  PlaybackAction,
  PlaybackSlide,
  PlaybackState,
} from '../../../../src/lib/deck/playback';
import {
  appendRemoteCommand,
  presentingShows,
  remotableShows,
} from '../../../../src/lib/deck/remote';
import { resolveDeck } from '../../../../src/lib/deck/resolve';
import type { ResolvedSlide } from '../../../../src/lib/deck/resolve';
import { createCanvasMeasurer } from '../../../../src/lib/deck/textLayout';
import { type DeckInteraction, useLivePeers } from '../../../../src/lib/liveAwareness';
import type { DeckRemoteAction, DeckRemoteState } from '../../../../src/lib/liveAwareness';
import { userColorForId } from '../../../../src/lib/userColor';
import type { DeckAssetRef } from '../../../../src/types/deck';
import { DeckNotes } from '../components/DeckNotes';
import { DeckSlideFrame } from '../components/DeckSlideFrame';
import { DeckThumbnailGrid } from '../components/DeckThumbnailGrid';
import { Banner, Spinner } from '../components/ui';
import { readMobileAssetDataUrl } from '../lib/assets';
import { useBackDismiss } from '../lib/backStack';
import {
  deckAssetFiles,
  type DeckDocument,
  deckName,
  type DeckViewport,
  FIT_VIEWPORT,
  inspectLiveDeck,
  loadDeckViewState,
  readDeckPresentation,
  saveDeckViewState,
} from '../lib/deck';
import {
  type LiveStatus,
  type MobileLiveDeckSession,
  openMobileLiveDeckSession,
} from '../lib/liveNote';
import type { HostedFileEntry } from '../mobileTauri';
import { useMobileStore } from '../state/store';

type Mode = 'slides' | 'slide' | 'present' | 'remote';

function slideTitle(slide: ResolvedSlide | undefined): string {
  if (!slide) return '';
  return `Slide ${slide.number}${slide.hidden ? ' (hidden)' : ''}`;
}

export function DeckScreen({
  file,
  remoteShowId,
}: {
  file: HostedFileEntry;
  remoteShowId?: string;
}) {
  const selected = useMobileStore((s) => s.selected);
  const statuses = useMobileStore((s) => s.statuses);
  const files = useMobileStore((s) => s.files);
  const closeSheet = useMobileStore((s) => s.closeSheet);

  const serverUrl = selected?.serverUrl ?? '';
  const vaultId = selected?.vault.id ?? '';
  const connected = selected ? !!statuses[serverUrl]?.connected : false;
  const localUser = statuses[serverUrl]?.user;
  const localUserId = localUser?.id ?? 'mobile';

  const restored = useMemo(() => loadDeckViewState(file.id), [file.id]);
  const [deck, setDeck] = useState<DeckDocument | null>(null);
  const [schemaNewer, setSchemaNewer] = useState(false);
  const [repairs, setRepairs] = useState<string[]>([]);
  const [source, setSource] = useState<'network' | 'cache'>('network');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(restored?.mode ?? 'slides');
  const [slideId, setSlideId] = useState<string | null>(restored?.slideId ?? null);
  const [notesOpen, setNotesOpen] = useState(restored?.notes ?? false);
  const [viewport, setViewport] = useState<DeckViewport>(restored?.viewport ?? FIT_VIEWPORT);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [liveSession, setLiveSession] = useState<MobileLiveDeckSession | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [following, setFollowing] = useState(false);
  const remoteRef = useRef<DeckRemoteState | null>(null);
  const [remoteVersion, setRemoteVersion] = useState(0);
  const directRef = useRef<{
    showId: string;
    connection: RTCPeerConnection;
    channel: RTCDataChannel;
    timeout: number;
  } | null>(null);
  const [remoteTransport, setRemoteTransport] = useState<'relay' | 'connecting' | 'direct'>(
    'relay',
  );
  const [remoteDirectIssue, setRemoteDirectIssue] = useState<string | null>(null);
  const [motionLaser, setMotionLaser] = useState(false);
  const [motionError, setMotionError] = useState<string | null>(null);
  const motionOrigin = useRef<{ beta: number; gamma: number } | null>(null);
  const motionPointer = useRef({ x: 0.5, y: 0.5 });
  const lastMotionAt = useRef(0);

  const measurer = useMemo(() => createCanvasMeasurer(), []);

  /* Load ------------------------------------------------------------------ */

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!selected) return;
      setBusy(true);
      setError(null);
      try {
        const loaded = await readDeckPresentation(serverUrl, vaultId, file, connected);
        if (cancelled) return;
        setDeck(loaded.document);
        setSchemaNewer(loaded.support === 'newer');
        setRepairs(loaded.warnings);
        setSource(loaded.source);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // Keyed on the file id, not the entry object, as in the other screens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, file.id, selected?.serverUrl, selected?.vault.id]);

  // The live room: the deck follows collaborators' edits, and awareness
  // carries where this phone is and its remote-control commands. Read-only.
  useEffect(() => {
    if (!selected || !connected || schemaNewer) return;
    let cancelled = false;
    let opened: MobileLiveDeckSession | null = null;
    const offs: Array<() => void> = [];
    const apply = (value: Record<string, unknown> | null) => {
      if (!value || cancelled) return;
      try {
        const inspection = inspectLiveDeck(value);
        if (inspection.support === 'newer') return;
        setDeck(inspection.document);
      } catch {
        // A transiently incomplete live state keeps the last good deck.
      }
    };
    void openMobileLiveDeckSession(serverUrl, vaultId, file.id)
      .then((session) => {
        if (!session) return;
        if (cancelled) {
          session.destroy();
          return;
        }
        opened = session;
        apply(session.readDeck());
        offs.push(session.onChange(apply));
        offs.push(session.onStatus(setLiveStatus));
        setLiveStatus(session.getStatus());
        setLiveSession(session);
      })
      .catch(() => {
        // Live following is best-effort; the loaded copy stays on screen.
      });
    return () => {
      cancelled = true;
      for (const off of offs) off();
      if (opened) {
        opened.awareness.setLocalStateField('deck', null);
        opened.destroy();
      }
      setLiveSession(null);
      setLiveStatus(null);
    };
  }, [connected, file.id, schemaNewer, selected, serverUrl, vaultId]);

  /* Assets ---------------------------------------------------------------- */

  const assets = useMemo(
    () => (deck ? deckAssetFiles(deck, files) : { found: new Map(), missing: [] }),
    [deck, files],
  );
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const pending = [...assets.found].filter(([path]) => !(path in assetUrls));
    if (pending.length === 0) return;
    void (async () => {
      for (const [path, entry] of pending) {
        if (cancelled) return;
        const url = await readMobileAssetDataUrl({ serverUrl, vaultId, file: entry, connected })
          .then((result) => result.dataUrl)
          .catch(() => null);
        if (cancelled) return;
        // An image that cannot be read stays a placeholder; record it so it
        // is not retried on every render.
        setAssetUrls((current) => ({ ...current, [path]: url ?? '' }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // assetUrls is read for what is already loaded, not as a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, connected, selected, serverUrl, vaultId]);
  const unreadable = Object.values(assetUrls).filter((url) => !url).length;
  const missingImages = assets.missing.length + unreadable;

  const resolveAsset = useCallback(
    (asset: DeckAssetRef) => assetUrls[asset.path] || null,
    [assetUrls],
  );

  /* Slides ---------------------------------------------------------------- */

  const slides = useMemo(() => (deck ? resolveDeck(deck) : []), [deck]);
  const playbackSlides = useMemo<PlaybackSlide[]>(
    () => slides.map((slide) => ({ id: slide.slideId, hidden: slide.hidden })),
    [slides],
  );
  const sectionStarts = useMemo(
    () => new Map((deck?.sections ?? []).map((section) => [section.firstSlideId, section.name])),
    [deck],
  );
  const foundIndex = slideId ? slides.findIndex((slide) => slide.slideId === slideId) : -1;
  const index = foundIndex >= 0 ? foundIndex : 0;
  const slide = slides[index];

  const goTo = useCallback(
    (next: number) => {
      const target = slides[next];
      if (!target) return;
      setSlideId(target.slideId);
      setViewport(FIT_VIEWPORT);
    },
    [slides],
  );

  useEffect(() => {
    if (!deck) return;
    saveDeckViewState(file.id, {
      slideId: slide?.slideId ?? null,
      mode: mode === 'slide' ? 'slide' : 'slides',
      notes: notesOpen,
      viewport,
    });
  }, [deck, file.id, mode, notesOpen, slide?.slideId, viewport]);

  /* Presenting on the phone ----------------------------------------------- */

  const playbackSlidesRef = useRef(playbackSlides);
  playbackSlidesRef.current = playbackSlides;
  const [playback, dispatch] = useReducer(
    (state: PlaybackState, action: PlaybackAction | { type: 'start'; index: number }) =>
      action.type === 'start'
        ? initialPlayback(playbackSlidesRef.current, action.index)
        : playbackReducer(playbackSlidesRef.current, state, action),
    undefined,
    () => initialPlayback([{ id: '', hidden: false }]),
  );
  const [buildSteps, setBuildSteps] = useState<Record<string, number>>({});
  const present = (from: 'start' | 'current') => {
    const first = playbackSlides.findIndex((entry) => !entry.hidden);
    const start = from === 'current' ? index : Math.max(0, first);
    const target = slides[start];
    if (target) setBuildSteps((current) => ({ ...current, [target.slideId]: 0 }));
    dispatch({ type: 'start', index: start });
    setMode('present');
  };
  const stopPresenting = useCallback(() => {
    const shown = slides[playback.index];
    if (shown) setSlideId(shown.slideId);
    setMode('slide');
  }, [playback.index, slides]);
  const presentedSlide = slides[Math.min(playback.index, slides.length - 1)];
  const presentedSource = presentedSlide ? deck?.slides[presentedSlide.slideId] : undefined;
  const presentBuildStep = presentedSlide ? (buildSteps[presentedSlide.slideId] ?? 0) : 0;
  const presentTimeline = useMemo(
    () => animationTimeline(presentedSource?.animations),
    [presentedSource?.animations],
  );
  const presentAnimationCss = useMemo(
    () => animationCss(presentedSource?.animations, presentBuildStep),
    [presentBuildStep, presentedSource?.animations],
  );
  const presentAction = useCallback(
    (action: PlaybackAction) => {
      if (
        action.type === 'next' &&
        !playback.blank &&
        !playback.ended &&
        presentedSlide &&
        presentBuildStep < presentTimeline.lastStep
      ) {
        setBuildSteps((current) => ({
          ...current,
          [presentedSlide.slideId]: presentBuildStep + 1,
        }));
        return;
      }
      if (
        action.type === 'previous' &&
        !playback.blank &&
        !playback.ended &&
        presentedSlide &&
        presentBuildStep > 0
      ) {
        setBuildSteps((current) => ({
          ...current,
          [presentedSlide.slideId]: presentBuildStep - 1,
        }));
        return;
      }
      dispatch(action);
    },
    [playback.blank, playback.ended, presentBuildStep, presentTimeline.lastStep, presentedSlide],
  );
  const presentProgress =
    slides.length > 0
      ? playbackProgress(playbackSlides, Math.min(playback.index, slides.length - 1))
      : null;

  /* Awareness and remote control ------------------------------------------ */

  const peers = useLivePeers(liveSession);
  const relativePath = file.relativePath;
  const myShows = useMemo(
    () => remotableShows(peers, localUserId, relativePath),
    [localUserId, peers, relativePath],
  );
  const shows = useMemo(() => presentingShows(peers, relativePath), [peers, relativePath]);
  const startTargets = useMemo(
    () =>
      peers.filter(
        (peer) =>
          peer.user?.id === localUserId &&
          peer.document?.kind === 'deck' &&
          peer.document.relativePath === relativePath &&
          peer.deck?.canStartPresentation &&
          !peer.deck.presenting,
      ),
    [localUserId, peers, relativePath],
  );
  const remoteShow = myShows[0] ?? null;
  const remoteShowIdValue = remoteShow?.show.id ?? null;
  const remoteDirectAnswer = remoteShow?.show.directAnswer ?? null;
  const remoteOffersDirect = remoteShow?.show.direct === true;
  const ownShowWithoutRemote = shows.find(
    (entry) =>
      !entry.show.remote &&
      peers.find((peer) => peer.clientId === entry.clientId)?.user?.id === localUserId,
  );
  const followedShow = shows[0] ?? null;

  useEffect(() => {
    const awareness = liveSession?.awareness;
    if (!awareness) return;
    awareness.setLocalStateField('user', {
      id: localUserId,
      name: localUser?.displayName || localUser?.username || 'Mobile',
      color: userColorForId(localUserId),
    });
    awareness.setLocalStateField('document', { kind: 'deck', relativePath });
    const remote = remoteRef.current;
    awareness.setLocalStateField('deck', {
      targetId: mode === 'present' ? (presentedSlide?.slideId ?? null) : (slide?.slideId ?? null),
      presenting: mode === 'present',
      remote:
        remote && (remote.startRequest || (remoteShow && remote.showId === remoteShow.show.id))
          ? remote
          : null,
    } satisfies DeckInteraction);
  }, [
    liveSession,
    localUser,
    localUserId,
    mode,
    presentedSlide?.slideId,
    relativePath,
    remoteShow,
    remoteVersion,
    slide?.slideId,
  ]);

  const sendRemote = useCallback(
    (action: DeckRemoteAction, at?: number) => {
      if (!remoteShowIdValue) return;
      const direct = directRef.current;
      if (direct?.showId === remoteShowIdValue && direct.channel.readyState === 'open') {
        direct.channel.send(
          directRemoteMessage({
            type: 'command',
            action,
            ...(action === 'goto' ? { index: at } : {}),
          }),
        );
        return;
      }
      remoteRef.current = appendRemoteCommand(remoteRef.current, remoteShowIdValue, action, at);
      setRemoteVersion((version) => version + 1);
    },
    [remoteShowIdValue],
  );

  const requestRemoteStart = useCallback((targetClientId: number) => {
    remoteRef.current = {
      showId: '',
      commands: [],
      startRequest: {
        id: crypto.randomUUID(),
        targetClientId,
      },
    };
    setRemoteVersion((version) => version + 1);
  }, []);

  const sendRemotePointer = useCallback(
    (active: boolean, x: number, y: number) => {
      if (!remoteShowIdValue) return;
      const direct = directRef.current;
      if (direct?.showId === remoteShowIdValue && direct.channel.readyState === 'open') {
        direct.channel.send(directRemoteMessage({ type: 'pointer', active, x, y }));
        return;
      }
      const previous = remoteRef.current;
      remoteRef.current = {
        showId: remoteShowIdValue,
        commands: previous?.showId === remoteShowIdValue ? previous.commands : [],
        ...(previous?.showId === remoteShowIdValue && previous.directOffer
          ? { directOffer: previous.directOffer }
          : {}),
        pointer: {
          seq: ((previous?.showId === remoteShowIdValue ? previous.pointer?.seq : 0) ?? 0) + 1,
          active,
          x,
          y,
        },
      };
      setRemoteVersion((version) => version + 1);
    },
    [remoteShowIdValue],
  );

  useEffect(() => {
    const current = directRef.current;
    if (current && current.showId !== remoteShowIdValue) {
      window.clearTimeout(current.timeout);
      current.connection.close();
      directRef.current = null;
    }
    if (
      mode !== 'remote' ||
      !remoteShowIdValue ||
      !remoteOffersDirect ||
      !supportsDirectRemote() ||
      directRef.current
    ) {
      if (mode !== 'remote' || !remoteShowIdValue || !remoteOffersDirect) {
        setRemoteTransport('relay');
        setRemoteDirectIssue(null);
      }
      if (mode === 'remote' && remoteShowIdValue && remoteOffersDirect && !supportsDirectRemote()) {
        setRemoteDirectIssue('Direct control is unavailable in this system WebView.');
      }
      return;
    }
    let cancelled = false;
    setRemoteTransport('connecting');
    setRemoteDirectIssue(null);
    void createDirectRemoteOffer()
      .then(({ connection, channel, sdp }) => {
        if (cancelled) {
          connection.close();
          return;
        }
        const timeout = window.setTimeout(() => {
          if (channel.readyState === 'open') return;
          setRemoteTransport('relay');
          setRemoteDirectIssue('Direct connection timed out; commands still use the server relay.');
        }, 15_000);
        directRef.current = { showId: remoteShowIdValue, connection, channel, timeout };
        channel.addEventListener('open', () => {
          window.clearTimeout(timeout);
          setRemoteDirectIssue(null);
          setRemoteTransport('direct');
        });
        channel.addEventListener('close', () => {
          window.clearTimeout(timeout);
          setRemoteTransport('relay');
        });
        channel.addEventListener('error', () => {
          window.clearTimeout(timeout);
          setRemoteDirectIssue('The direct channel failed; commands still use the server relay.');
          setRemoteTransport('relay');
        });
        const previous = remoteRef.current;
        remoteRef.current = {
          showId: remoteShowIdValue,
          commands: previous?.showId === remoteShowIdValue ? previous.commands : [],
          ...(previous?.showId === remoteShowIdValue && previous.pointer
            ? { pointer: previous.pointer }
            : {}),
          directOffer: sdp,
        };
        setRemoteVersion((version) => version + 1);
      })
      .catch(() => {
        setRemoteDirectIssue('Direct setup failed; commands still use the server relay.');
        setRemoteTransport('relay');
      });
    return () => {
      cancelled = true;
    };
  }, [mode, remoteOffersDirect, remoteShowIdValue]);

  useEffect(() => {
    const direct = directRef.current;
    const clientId = liveSession?.awareness.clientID;
    if (
      !direct ||
      direct.connection.remoteDescription ||
      !remoteDirectAnswer ||
      remoteDirectAnswer.clientId !== clientId ||
      !validDirectSdp(remoteDirectAnswer.sdp)
    ) {
      return;
    }
    void direct.connection
      .setRemoteDescription({ type: 'answer', sdp: remoteDirectAnswer.sdp })
      .catch(() => {
        setRemoteDirectIssue(
          'The computer rejected the direct connection; using the server relay.',
        );
        setRemoteTransport('relay');
      });
  }, [liveSession, remoteDirectAnswer]);

  useEffect(
    () => () => {
      if (directRef.current) window.clearTimeout(directRef.current.timeout);
      directRef.current?.connection.close();
      directRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!motionLaser || mode !== 'remote' || !remoteShowIdValue) return;
    const onOrientation = (event: DeviceOrientationEvent) => {
      if (event.beta === null || event.gamma === null) return;
      if (!motionOrigin.current) {
        motionOrigin.current = { beta: event.beta, gamma: event.gamma };
        return;
      }
      const now = performance.now();
      if (now - lastMotionAt.current < 40) return;
      lastMotionAt.current = now;
      const deadZone = (value: number) => (Math.abs(value) < 1.5 ? 0 : value);
      const dx = deadZone(event.gamma - motionOrigin.current.gamma) * 0.0025;
      // Device beta grows when the top of the phone tilts toward the user,
      // which is the inverse of the slide's top-to-bottom Y axis.
      const dy = -deadZone(event.beta - motionOrigin.current.beta) * 0.0025;
      const point = {
        x: Math.min(1, Math.max(0, motionPointer.current.x + dx)),
        y: Math.min(1, Math.max(0, motionPointer.current.y + dy)),
      };
      motionPointer.current = point;
      sendRemotePointer(true, point.x, point.y);
    };
    window.addEventListener('deviceorientation', onOrientation);
    return () => {
      window.removeEventListener('deviceorientation', onOrientation);
      sendRemotePointer(false, motionPointer.current.x, motionPointer.current.y);
    };
  }, [mode, motionLaser, remoteShowIdValue, sendRemotePointer]);

  const toggleMotionLaser = useCallback(async () => {
    if (motionLaser) {
      setMotionLaser(false);
      return;
    }
    setMotionError(null);
    const orientation = DeviceOrientationEvent as typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<'granted' | 'denied'>;
    };
    try {
      if (orientation.requestPermission && (await orientation.requestPermission()) !== 'granted') {
        setMotionError('Motion access was not granted.');
        return;
      }
      motionOrigin.current = null;
      motionPointer.current = { x: 0.5, y: 0.5 };
      setMotionLaser(true);
    } catch {
      setMotionError('Motion sensors are not available on this device.');
    }
  }, [motionLaser]);

  // Leave the remote when the show ends or the presenter turns it off.
  useEffect(() => {
    if (mode === 'remote' && !remoteShow) setMode('slides');
  }, [mode, remoteShow]);

  // An app-shell discovery bubble routes here with the show it found. Wait for
  // the deck room's awareness snapshot, then enter the existing remote UI.
  useEffect(() => {
    if (remoteShowId && remoteShow?.show.id === remoteShowId) setMode('remote');
  }, [remoteShow, remoteShowId]);

  // Following a presenter: keep this view on the slide they show.
  const followedSlideId = following ? (followedShow?.show.slideId ?? null) : null;
  useEffect(() => {
    if (!following) return;
    if (!followedShow) {
      setFollowing(false);
      return;
    }
    if (followedSlideId) {
      setSlideId(followedSlideId);
      setViewport(FIT_VIEWPORT);
    }
  }, [followedShow, followedSlideId, following]);

  /* Back ------------------------------------------------------------------ */

  useBackDismiss(mode === 'slide', () => setMode('slides'));
  useBackDismiss(mode === 'present', stopPresenting);
  useBackDismiss(mode === 'remote', () => setMode('slides'));

  /* Render ---------------------------------------------------------------- */

  if (busy && !deck) {
    return (
      <div className="deck-screen deck-screen-centered">
        <Spinner />
      </div>
    );
  }

  const header = (subtitle: string) => (
    <header className="deck-header">
      <button
        type="button"
        className="icon-button"
        aria-label={mode === 'slides' || !deck ? 'Back' : 'All slides'}
        onClick={() => (mode === 'slides' || !deck ? closeSheet() : setMode('slides'))}
      >
        <ArrowLeft size={18} />
      </button>
      <div className="row-text">
        <strong>{deckName(file)}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <span className="deck-header-status">
        {source === 'cache' && <CloudOff size={15} aria-label="Offline copy" />}
        {liveStatus === 'connected' && <Radio size={15} aria-label="Live" />}
        {liveStatus === 'connecting' && <Spinner size={15} />}
      </span>
    </header>
  );

  if (error && !deck) {
    return (
      <div className="deck-screen">
        {header('')}
        <Banner tone="error">{error}</Banner>
      </div>
    );
  }
  if (!deck || slides.length === 0) {
    return (
      <div className="deck-screen">
        {header('')}
        <Banner tone="info">This presentation has no slides yet.</Banner>
      </div>
    );
  }

  if (mode === 'present' && presentedSlide && presentProgress) {
    const tap = (fraction: number) =>
      playback.ended
        ? stopPresenting()
        : presentAction({ type: fraction < 0.33 ? 'previous' : 'next' });
    return (
      <div className="deck-present" role="dialog" aria-label="Slide show">
        <DeckSlideFrame
          slide={presentedSlide}
          measurer={measurer}
          resolveAsset={resolveAsset}
          viewport={null}
          onSwipe={(direction) => presentAction({ type: direction })}
          onTap={tap}
          className="deck-present-frame"
          animationKey={`${presentedSlide.slideId}:${presentBuildStep}`}
          animationCss={presentAnimationCss}
          transition={presentedSource?.transition}
        >
          {playback.ended && (
            <div className="deck-present-end">End of slide show. Tap to exit.</div>
          )}
        </DeckSlideFrame>
        <div className="deck-present-bar" role="toolbar" aria-label="Slide show controls">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous slide"
            onClick={() => presentAction({ type: 'previous' })}
          >
            <ChevronLeft size={20} />
          </button>
          <span aria-live="polite">
            {presentProgress.position} / {presentProgress.total}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="Next slide"
            onClick={() => presentAction({ type: 'next' })}
          >
            <ChevronRight size={20} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="End show"
            onClick={stopPresenting}
          >
            <X size={20} />
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'remote' && remoteShow) {
    const shownIndex = slides.findIndex((entry) => entry.slideId === remoteShow.show.slideId);
    const shown = slides[shownIndex];
    const upcoming =
      shownIndex >= 0 ? slides.slice(shownIndex + 1).find((entry) => !entry.hidden) : undefined;
    return (
      <div className="deck-screen deck-remote">
        {header(`Remote · ${remoteShow.name}`)}
        <div className="deck-remote-status" aria-live="polite">
          {remoteShow.show.blank
            ? `Screen is ${remoteShow.show.blank}`
            : `Showing slide ${remoteShow.show.position} of ${remoteShow.show.total}`}
          <span className={`deck-remote-transport ${remoteTransport}`}>
            {remoteTransport === 'direct'
              ? 'Direct connection'
              : remoteTransport === 'connecting'
                ? 'Connecting directly…'
                : 'Server relay'}
          </span>
          {remoteDirectIssue ? (
            <span className="deck-remote-transport-issue">{remoteDirectIssue}</span>
          ) : null}
        </div>
        {shown ? (
          <DeckSlideFrame
            slide={shown}
            measurer={measurer}
            resolveAsset={resolveAsset}
            viewport={null}
            onSwipe={(direction) => sendRemote(direction)}
            onTap={(fraction) => sendRemote(fraction < 0.33 ? 'previous' : 'next')}
            className="deck-remote-frame"
          />
        ) : (
          <Banner tone="info">Waiting for the presenter…</Banner>
        )}
        <div className="deck-remote-controls" role="toolbar" aria-label="Remote control">
          <button
            type="button"
            className="deck-remote-button"
            onClick={() => sendRemote('previous')}
          >
            <ChevronLeft size={22} /> Previous
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Black screen"
            aria-pressed={remoteShow.show.blank === 'black'}
            onClick={() => sendRemote('black')}
          >
            <Square size={18} fill="currentColor" />
          </button>
          <button
            type="button"
            className="deck-remote-button primary"
            onClick={() => sendRemote('next')}
          >
            Next <ChevronRight size={22} />
          </button>
        </div>
        <div className="deck-motion-laser">
          <button
            type="button"
            className={`deck-remote-button${motionLaser ? ' primary' : ''}`}
            aria-pressed={motionLaser}
            onClick={() => void toggleMotionLaser()}
          >
            <Crosshair size={20} /> {motionLaser ? 'Stop motion laser' : 'Motion laser'}
          </button>
          {motionLaser ? (
            <button
              type="button"
              className="chip"
              onClick={() => {
                motionOrigin.current = null;
                motionPointer.current = { x: 0.5, y: 0.5 };
              }}
            >
              Recenter
            </button>
          ) : null}
        </div>
        {motionError ? <Banner tone="error">{motionError}</Banner> : null}
        <section className="deck-notes" aria-label="Speaker notes">
          {upcoming && <p className="deck-notes-next">Next: slide {upcoming.number}</p>}
          <DeckNotes body={shown?.notes ?? null} />
        </section>
      </div>
    );
  }

  const banners = (
    <>
      {schemaNewer && (
        <Banner tone="info">
          This presentation was made with a newer version of Collab. Some of it may not show here.
        </Banner>
      )}
      {repairs.length > 0 && (
        <Banner tone="info">
          {repairs.length === 1
            ? repairs[0]
            : `This presentation was repaired while opening (${repairs.length} issues).`}
        </Banner>
      )}
      {missingImages > 0 && (
        <Banner tone="info">
          {missingImages === 1
            ? 'One image is not available on this device and shows as a placeholder.'
            : `${missingImages} images are not available on this device and show as placeholders.`}
        </Banner>
      )}
      {remoteShow && (
        <div className="deck-companion-bar">
          <Smartphone size={16} aria-hidden />
          <span>Your computer is presenting this deck.</span>
          <button type="button" className="chip" onClick={() => setMode('remote')}>
            Remote control
          </button>
        </div>
      )}
      {!remoteShow && startTargets.length > 0 && (
        <div className="deck-companion-bar">
          <MonitorPlay size={16} aria-hidden />
          <span>
            {startTargets.length === 1
              ? `${startTargets[0].user?.name ?? 'Your computer'} can present this deck.`
              : `${startTargets.length} computers can present this deck.`}
          </span>
          <button
            type="button"
            className="chip"
            onClick={() => requestRemoteStart(startTargets[0].clientId)}
          >
            Present there
          </button>
        </div>
      )}
      {!remoteShow && ownShowWithoutRemote && (
        <div className="deck-companion-bar">
          <Smartphone size={16} aria-hidden />
          <span>To control your show from here, turn on Phone remote in the presenter.</span>
        </div>
      )}
      {!remoteShow && followedShow && !ownShowWithoutRemote && (
        <div className="deck-companion-bar">
          <Radio size={16} aria-hidden />
          <span>{followedShow.name} is presenting.</span>
          <button
            type="button"
            className="chip"
            aria-pressed={following}
            onClick={() => setFollowing((value) => !value)}
          >
            {following ? 'Following' : 'Follow'}
          </button>
        </div>
      )}
    </>
  );

  if (mode === 'slide' && slide) {
    return (
      <div className="deck-screen">
        {header(`${slideTitle(slide)} of ${slides.length}`)}
        {banners}
        <div className="deck-body">
          <DeckSlideFrame
            slide={slide}
            measurer={measurer}
            resolveAsset={resolveAsset}
            viewport={viewport}
            onViewportChange={setViewport}
            onSwipe={(direction) => {
              setFollowing(false);
              goTo(direction === 'next' ? index + 1 : index - 1);
            }}
            className="deck-viewer-frame"
          />
          {notesOpen && (
            <section className="deck-notes" aria-label="Speaker notes">
              <DeckNotes body={slide.notes} />
            </section>
          )}
        </div>
        <nav className="deck-toolbar" aria-label="Slide navigation">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous slide"
            disabled={index === 0}
            onClick={() => {
              setFollowing(false);
              goTo(index - 1);
            }}
          >
            <ChevronLeft size={20} />
          </button>
          <span className="deck-toolbar-position">
            {index + 1} / {slides.length}
            {viewport.zoom > 1 ? ` · ${Math.round(viewport.zoom * 100)}%` : ''}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="Next slide"
            disabled={index >= slides.length - 1}
            onClick={() => {
              setFollowing(false);
              goTo(index + 1);
            }}
          >
            <ChevronRight size={20} />
          </button>
          <button
            type="button"
            className={`icon-button${notesOpen ? ' active' : ''}`}
            aria-label="Speaker notes"
            aria-pressed={notesOpen}
            onClick={() => setNotesOpen((open) => !open)}
          >
            <StickyNote size={18} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Present from this slide"
            onClick={() => present('current')}
          >
            <Play size={18} />
          </button>
        </nav>
      </div>
    );
  }

  return (
    <div className="deck-screen">
      {header(`${slides.length} ${slides.length === 1 ? 'slide' : 'slides'}`)}
      {banners}
      <DeckThumbnailGrid
        slides={slides}
        sectionStarts={sectionStarts}
        activeIndex={index}
        measurer={measurer}
        resolveAsset={resolveAsset}
        onOpen={(at) => {
          goTo(at);
          setMode('slide');
        }}
      />
      <nav className="deck-toolbar" aria-label="Presentation">
        <button type="button" className="chip" onClick={() => present('start')}>
          <Play size={16} aria-hidden /> Present
        </button>
      </nav>
    </div>
  );
}
