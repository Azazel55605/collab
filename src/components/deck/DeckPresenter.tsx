import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { createPortal } from 'react-dom';

import DOMPurify from 'dompurify';
import {
  ChevronLeft,
  ChevronRight,
  Eraser,
  Grid3x3,
  Highlighter,
  Monitor,
  MousePointer2,
  Pause,
  PenLine,
  Play,
  RotateCcw,
  Smartphone,
  Square,
  SquareDashed,
  X,
  Zap,
} from 'lucide-react';

import { animationCss, animationTimeline } from '../../lib/deck/animation';
import {
  eraseStrokes,
  extendStroke,
  formatElapsed,
  initialPlayback,
  inkWidth,
  nextIndex,
  PLAYBACK_INK_COLORS,
  playbackKeyCommand,
  playbackProgress,
  playbackReducer,
  strokesSvg,
  swipeCommand,
  timerElapsed,
  toggleTimer,
} from '../../lib/deck/playback';
import type {
  PlaybackAction,
  PlaybackBlank,
  PlaybackInk,
  PlaybackSlide,
  PlaybackState,
  PlaybackStroke,
  PlaybackTimer,
  PlaybackTool,
} from '../../lib/deck/playback';
import {
  chooseAudienceDisplay,
  currentDisplayId,
  listDisplays,
  openAudienceWindow,
  setWindowFullscreen,
} from '../../lib/deck/presentWindow';
import type { AudienceHandle, DisplayInfo } from '../../lib/deck/presentWindow';
import { resolveDeck } from '../../lib/deck/resolve';
import type { ResolvedSlide, ResolvedTextBody } from '../../lib/deck/resolve';
import { renderSlideSvg } from '../../lib/deck/svg';
import { linkAt, slideTextRuns } from '../../lib/deck/textLayer';
import type { DeckTextMeasurer } from '../../lib/deck/textLayout';
import { unitsToPx } from '../../lib/deck/units';
import type { DeckAssetRef, DeckDocument, DeckLink } from '../../types/deck';

import { DeckPlaybackSurface } from './DeckPlaybackSurface';
import { DeckSlide } from './DeckSlide';

export type DeckPresentMode = 'slideshow' | 'presenter';

export interface DeckPresentSummary {
  /** The slide shown last, to return the editor to. */
  slideId: string | null;
  /** Ink drawn during the show. Never written unless the person keeps it. */
  ink: PlaybackInk;
}

/** Where the show is, for the live awareness relay. */
export interface DeckShowPosition {
  slideId: string | null;
  position: number;
  total: number;
  blank: PlaybackBlank;
}

/**
 * Remote control from the presenter's own phone (`lib/deck/remote.ts`). Off
 * until the presenter turns it on for this show.
 */
export interface DeckPresenterRemote {
  allowed: boolean;
  onAllowedChange: (allowed: boolean) => void;
  /** Delivers remote commands as playback actions; returns an unsubscribe. */
  subscribe: (listener: (action: PlaybackAction) => void) => () => void;
}

export interface DeckPresenterRuntime {
  now?: () => number;
  listDisplays?: typeof listDisplays;
  currentDisplayId?: typeof currentDisplayId;
  openAudienceWindow?: typeof openAudienceWindow;
  setWindowFullscreen?: typeof setWindowFullscreen;
}

interface DeckPresenterProps {
  deck: DeckDocument;
  startSlideId: string | null;
  mode: DeckPresentMode;
  measurer: DeckTextMeasurer;
  resolveAsset: (asset: DeckAssetRef) => string | null;
  onExit: (summary: DeckPresentSummary) => void;
  onOpenUrl?: (href: string) => void;
  onOpenVaultLink?: (path: string) => void;
  onNotice?: (message: string) => void;
  /** Reported whenever the shown slide or blanking changes. */
  onShowChange?: (show: DeckShowPosition) => void;
  remote?: DeckPresenterRemote;
  runtime?: DeckPresenterRuntime;
}

const DISPLAY_POLL_MS = 3_000;
const CONTROLS_HIDE_MS = 2_500;
const WHEEL_GAP_MS = 300;
const TAP_SLOP = 12;

function sanitize(svg: string): string {
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } });
}

function now(runtime?: DeckPresenterRuntime): number {
  return runtime?.now?.() ?? performance.now();
}

/** Speaker notes as readable HTML: paragraphs, list labels, bold/italic/underline. */
function NotesText({ body, scale }: { body: ResolvedTextBody | null; scale: number }) {
  const text = body?.paragraphs.some((paragraph) =>
    paragraph.runs.some((run) => run.kind === 'text' && run.text.trim()),
  );
  if (!body || !text) {
    return <p className="text-muted-foreground">No speaker notes for this slide.</p>;
  }
  return (
    <div className="space-y-2 leading-relaxed" style={{ fontSize: `${scale}rem` }}>
      {body.paragraphs.map((paragraph) => (
        <p
          key={paragraph.id}
          style={{ paddingLeft: `${paragraph.level * 1.25}em` }}
          className="whitespace-pre-wrap"
        >
          {paragraph.label && <span className="mr-1.5">{paragraph.label}</span>}
          {paragraph.runs.map((run, index) =>
            run.kind === 'break' ? (
              <br key={index} />
            ) : (
              <span
                key={index}
                style={{
                  fontWeight: run.style.bold ? 700 : undefined,
                  fontStyle: run.style.italic ? 'italic' : undefined,
                  textDecoration:
                    [run.style.underline ? 'underline' : '', run.style.strike ? 'line-through' : '']
                      .filter(Boolean)
                      .join(' ') || undefined,
                }}
              >
                {run.text}
              </span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  active,
  children,
  className = '',
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      // Keep focus where it is: Space and Enter belong to playback, not to this button.
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={`inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-white/15 ${active ? 'bg-white/20 text-white' : 'text-white/80'} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * Presentation playback: the full-screen slide show, and the presenter view
 * with current and next slide, notes, timer, and display choice.
 *
 * Nothing here writes to the deck. Ink, laser, blanking, timer, and position
 * are playback state; on exit the view is told what was drawn and asks the
 * person whether to keep it.
 *
 * Recovery rule for the audience window: if it closes or its display goes
 * away, the show continues in this window at the same slide, with ink and
 * timer intact.
 */
export function DeckPresenter({
  deck,
  startSlideId,
  mode,
  measurer,
  resolveAsset,
  onExit,
  onOpenUrl,
  onOpenVaultLink,
  onNotice,
  onShowChange,
  remote,
  runtime,
}: DeckPresenterProps) {
  const slides = useMemo(() => resolveDeck(deck), [deck]);
  const playbackSlides = useMemo<PlaybackSlide[]>(
    () => slides.map((slide) => ({ id: slide.slideId, hidden: slide.hidden })),
    [slides],
  );
  const slidesRef = useRef(playbackSlides);
  slidesRef.current = playbackSlides;
  const [state, dispatch] = useReducer(
    (current: PlaybackState, action: PlaybackAction) =>
      playbackReducer(slidesRef.current, current, action),
    undefined,
    () => {
      const start = startSlideId ? deck.slideOrder.indexOf(startSlideId) : 0;
      return initialPlayback(playbackSlides, Math.max(0, start));
    },
  );
  const index = Math.min(state.index, Math.max(0, slides.length - 1));
  const slide: ResolvedSlide | undefined = slides[index];
  const sourceSlide = slide ? deck.slides[slide.slideId] : undefined;
  const upcomingIndex = nextIndex(playbackSlides, index);
  const upcoming = upcomingIndex === null ? null : slides[upcomingIndex];

  const [view, setView] = useState<DeckPresentMode>(mode);
  const [tool, setTool] = useState<PlaybackTool>('none');
  const [inkColor, setInkColor] = useState(PLAYBACK_INK_COLORS[0]);
  const [ink, setInk] = useState<PlaybackInk>({});
  const [draft, setDraft] = useState<PlaybackStroke | null>(null);
  const [laser, setLaser] = useState<{ x: number; y: number } | null>(null);
  const [timer, setTimer] = useState<PlaybackTimer>(() => ({
    elapsed: 0,
    runningSince: now(runtime),
  }));
  const [, setTick] = useState(0);
  const [notesScale, setNotesScale] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [buildSteps, setBuildSteps] = useState<Record<string, number>>({});
  const [audience, setAudience] = useState<AudienceHandle | null>(null);
  const [audienceStatus, setAudienceStatus] = useState<'none' | 'opening' | 'open' | 'unavailable'>(
    'none',
  );
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const audienceRef = useRef<AudienceHandle | null>(null);
  const audienceRequest = useRef(0);
  const closingAudience = useRef(false);
  const exited = useRef(false);

  const inkRef = useRef(ink);
  inkRef.current = ink;
  const indexRef = useRef(index);
  indexRef.current = index;

  /* Markup ---------------------------------------------------------------- */

  const markupCache = useRef(new Map<ResolvedSlide, string>());
  const markupFor = useCallback(
    (target: ResolvedSlide): string => {
      const cached = markupCache.current.get(target);
      if (cached) return cached;
      const markup = sanitize(
        renderSlideSvg(target, { measurer, resolveAsset, pixelWidth: unitsToPx(target.width) }),
      );
      markupCache.current.set(target, markup);
      return markup;
    },
    [measurer, resolveAsset],
  );
  useEffect(() => {
    markupCache.current = new Map();
  }, [resolveAsset, slides]);

  const markup = slide ? markupFor(slide) : '';
  const aspect = slide ? slide.width / slide.height : 16 / 9;
  const runs = useMemo(() => (slide ? slideTextRuns(slide, measurer) : []), [measurer, slide]);
  const slideInk = slide ? (ink[slide.slideId] ?? []) : [];
  const inkMarkup = strokesSvg(draft ? [...slideInk, draft] : slideInk);
  const buildStep = slide ? (buildSteps[slide.slideId] ?? 0) : 0;
  const timeline = useMemo(
    () => animationTimeline(sourceSlide?.animations),
    [sourceSlide?.animations],
  );
  const buildCss = useMemo(
    () => animationCss(sourceSlide?.animations, buildStep),
    [buildStep, sourceSlide?.animations],
  );

  /* Exit ------------------------------------------------------------------ */

  const previousFullscreen = useRef<boolean | null>(null);
  const exit = useCallback(() => {
    if (exited.current) return;
    exited.current = true;
    audienceRequest.current += 1;
    closingAudience.current = true;
    void audienceRef.current?.close();
    audienceRef.current = null;
    if (previousFullscreen.current === false) {
      void (runtime?.setWindowFullscreen ?? setWindowFullscreen)(false);
    }
    onExit({ slideId: slidesRef.current[indexRef.current]?.id ?? null, ink: inkRef.current });
  }, [onExit, runtime]);

  /* Full screen for the in-window slide show ------------------------------- */

  useEffect(() => {
    if (view !== 'slideshow') return;
    let cancelled = false;
    void (runtime?.setWindowFullscreen ?? setWindowFullscreen)(true).then((was) => {
      if (!cancelled && previousFullscreen.current === null) previousFullscreen.current = was;
    });
    return () => {
      cancelled = true;
    };
  }, [runtime, view]);

  /* Audience window ------------------------------------------------------- */

  const loseAudience = useCallback(() => {
    audienceRequest.current += 1;
    audienceRef.current = null;
    setAudience(null);
    if (closingAudience.current || exited.current) {
      closingAudience.current = false;
      return;
    }
    setAudienceStatus('unavailable');
    // Deterministic recovery: the show continues here, same slide, same ink.
    setView('slideshow');
    onNotice?.('The slide show window closed. The show continues on this screen.');
  }, [onNotice]);

  const openAudience = useCallback(
    async (preferredId: string | null) => {
      const request = ++audienceRequest.current;
      setAudienceStatus('opening');
      const list = await (runtime?.listDisplays ?? listDisplays)();
      if (request !== audienceRequest.current || exited.current) return;
      setDisplays(list);
      const own = await (runtime?.currentDisplayId ?? currentDisplayId)();
      if (request !== audienceRequest.current || exited.current) return;
      const target = chooseAudienceDisplay(list, own, preferredId);
      if (!target) {
        setAudienceStatus('unavailable');
        return;
      }
      const handle = await (runtime?.openAudienceWindow ?? openAudienceWindow)(target, {
        onClosed: () => {
          if (request === audienceRequest.current) loseAudience();
        },
        onKey: (key) => handleKeyRef.current?.(key),
        onPointer: (action) => pointerRef.current(action),
      });
      if (request !== audienceRequest.current || exited.current) {
        void handle?.close();
        return;
      }
      closingAudience.current = false;
      audienceRef.current = handle;
      setAudience(handle);
      setAudienceStatus(handle ? 'open' : 'unavailable');
    },
    [loseAudience, runtime],
  );

  useEffect(() => {
    if (mode === 'presenter') void openAudience(null);
    return () => {
      audienceRequest.current += 1;
      closingAudience.current = true;
      void audienceRef.current?.close();
      audienceRef.current = null;
      // Unmounted without "End show" (the tab closed): still leave full screen.
      if (!exited.current && previousFullscreen.current === false) {
        void (runtime?.setWindowFullscreen ?? setWindowFullscreen)(false);
      }
    };
    // Once, when the show starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A display that disappears takes the audience window with it: close it
  // ourselves so the recovery rule runs even if the OS just moved the window.
  useEffect(() => {
    if (!audience) return;
    const timerId = window.setInterval(() => {
      void (runtime?.listDisplays ?? listDisplays)().then((list) => {
        setDisplays(list);
        if (list.length > 0 && !list.some((display) => display.id === audience.display.id)) {
          void audience.close().then(loseAudience);
        }
      });
    }, DISPLAY_POLL_MS);
    return () => window.clearInterval(timerId);
  }, [audience, loseAudience, runtime]);

  const moveAudience = (displayId: string) => {
    const request = ++audienceRequest.current;
    closingAudience.current = true;
    const current = audienceRef.current;
    audienceRef.current = null;
    setAudience(null);
    void (current ? current.close() : Promise.resolve()).then(() => {
      if (request !== audienceRequest.current || exited.current) return;
      closingAudience.current = false;
      void openAudience(displayId);
    });
  };

  useEffect(() => {
    if (!audience || !slide) return;
    audience.sendSlide({
      svg: markup,
      aspect,
      blank: state.blank,
      ended: state.ended,
      slideKey: slide.slideId,
      animationKey: `${slide.slideId}:${buildStep}`,
      animationCss: buildCss,
      transition: sourceSlide?.transition,
    });
  }, [
    aspect,
    audience,
    buildCss,
    buildStep,
    markup,
    slide,
    sourceSlide?.transition,
    state.blank,
    state.ended,
  ]);

  useEffect(() => {
    if (!audience || !slide) return;
    audience.sendOverlay({
      ink: inkMarkup,
      viewBox: [slide.width, slide.height],
      laser,
    });
  }, [audience, inkMarkup, laser, slide]);

  /* Timer and controls ----------------------------------------------------- */

  useEffect(() => {
    const id = window.setInterval(() => setTick((value) => value + 1), 500);
    return () => window.clearInterval(id);
  }, []);

  const hideTimer = useRef<number | null>(null);
  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS);
  }, []);
  useEffect(() => {
    showControls();
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, [showControls]);

  /* Links ----------------------------------------------------------------- */

  const act = useCallback(
    (action: PlaybackAction) => {
      if (action.type === 'next' && !state.blank && !state.ended && slide) {
        if (buildStep < timeline.lastStep) {
          setBuildSteps((current) => ({ ...current, [slide.slideId]: buildStep + 1 }));
          return;
        }
      }
      if (action.type === 'previous' && !state.blank && !state.ended && slide && buildStep > 0) {
        setBuildSteps((current) => ({ ...current, [slide.slideId]: buildStep - 1 }));
        return;
      }
      if (action.type === 'goto') {
        const target = slides[action.index];
        if (target) setBuildSteps((current) => ({ ...current, [target.slideId]: 0 }));
      }
      dispatch(action);
    },
    [buildStep, slide, slides, state.blank, state.ended, timeline.lastStep],
  );

  const followLink = useCallback(
    (link: DeckLink) => {
      if (link.kind === 'slide') {
        const target = slidesRef.current.findIndex((entry) => entry.id === link.slideId);
        if (target >= 0) act({ type: 'goto', index: target });
      } else if (link.kind === 'url') {
        onOpenUrl?.(link.href);
      } else if (onOpenVaultLink) {
        exit();
        onOpenVaultLink(link.path);
      }
    },
    [act, exit, onOpenUrl, onOpenVaultLink],
  );

  /* Keys ------------------------------------------------------------------ */

  const chooseTool = (next: PlaybackTool) => {
    setTool((current) => (current === next ? 'none' : next));
    if (next !== 'laser') setLaser(null);
  };

  const handleKey = (key: {
    key: string;
    ctrl: boolean;
    meta: boolean;
    alt: boolean;
    shift: boolean;
  }): boolean => {
    if (state.overview && key.key === 'Escape') {
      dispatch({ type: 'overview' });
      return true;
    }
    const command = playbackKeyCommand(key.key, key, state);
    if (!command) return false;
    switch (command.type) {
      case 'exit':
        exit();
        break;
      case 'tool':
        chooseTool(command.tool);
        break;
      case 'clearInk':
        if (slide) setInk((current) => ({ ...current, [slide.slideId]: [] }));
        break;
      case 'toggleTimer':
        setTimer((current) => toggleTimer(current, now(runtime)));
        break;
      case 'resetTimer':
        setTimer((current) => ({
          elapsed: 0,
          runningSince: current.runningSince === null ? null : now(runtime),
        }));
        break;
      default:
        act(command);
    }
    return true;
  };
  const handleKeyRef = useRef(handleKey);
  handleKeyRef.current = handleKey;
  const pointerRef = useRef((action: 'next' | 'previous') => {
    void action;
  });
  pointerRef.current = (action) => {
    if (action === 'next' && state.ended) exit();
    else act({ type: action });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'SELECT') return;
      const handled = handleKeyRef.current({
        key: event.key,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        alt: event.altKey,
        shift: event.shiftKey,
      });
      // Keys never reach the editor behind the show.
      event.stopPropagation();
      if (handled || event.key === ' ' || event.key === 'Tab') event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  /* Pointer: navigation, links, ink, laser --------------------------------- */

  const pointerStart = useRef<{ x: number; y: number; id: number } | null>(null);
  const lastWheel = useRef(0);

  const slidePoint = (
    event: React.PointerEvent<HTMLElement>,
    box: { width: number; height: number },
  ): { x: number; y: number; fx: number; fy: number } | null => {
    if (!slide || box.width <= 0) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const fx = (event.clientX - rect.left) / (rect.width || box.width);
    const fy = (event.clientY - rect.top) / (rect.height || box.height);
    return { x: fx * slide.width, y: fy * slide.height, fx, fy };
  };

  const interaction = (box: { width: number; height: number }) => (
    <div
      className={`absolute inset-0 touch-none ${tool === 'pen' || tool === 'highlighter' ? 'cursor-crosshair' : tool === 'eraser' ? 'cursor-cell' : tool === 'laser' ? 'cursor-none' : ''}`}
      data-testid="deck-playback-input"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const point = slidePoint(event, box);
        if (!point || !slide) return;
        pointerStart.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        if (tool === 'pen' || tool === 'highlighter') {
          setDraft({
            tool,
            color: inkColor,
            width: inkWidth(tool, slide.width),
            points: [[point.x, point.y]],
          });
        } else if (tool === 'eraser') {
          setInk((current) => ({
            ...current,
            [slide.slideId]: eraseStrokes(
              current[slide.slideId] ?? [],
              [point.x, point.y],
              slide.width * 0.01,
            ),
          }));
        }
      }}
      onPointerMove={(event) => {
        showControls();
        const point = slidePoint(event, box);
        if (!point || !slide) return;
        if (tool === 'laser') setLaser({ x: point.fx, y: point.fy });
        if (!pointerStart.current || pointerStart.current.id !== event.pointerId) return;
        if (draft) {
          setDraft((current) =>
            current ? extendStroke(current, [point.x, point.y], slide.width * 0.001) : current,
          );
        } else if (tool === 'eraser') {
          setInk((current) => ({
            ...current,
            [slide.slideId]: eraseStrokes(
              current[slide.slideId] ?? [],
              [point.x, point.y],
              slide.width * 0.01,
            ),
          }));
        }
      }}
      onPointerLeave={() => {
        if (tool === 'laser') setLaser(null);
      }}
      onPointerUp={(event) => {
        const start = pointerStart.current;
        pointerStart.current = null;
        if (!start || start.id !== event.pointerId || !slide) return;
        if (draft) {
          const stroke = draft;
          setDraft(null);
          setInk((current) => ({
            ...current,
            [slide.slideId]: [...(current[slide.slideId] ?? []), stroke],
          }));
          return;
        }
        if (tool === 'eraser') return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.hypot(dx, dy) > TAP_SLOP) {
          const swipe = swipeCommand(dx, dy);
          if (swipe) act(swipe);
          return;
        }
        const point = slidePoint(event, box);
        const link = point ? linkAt(runs, point.x, point.y) : null;
        if (link) followLink(link);
        else if (state.ended) exit();
        else act({ type: 'next' });
      }}
      onPointerCancel={() => {
        pointerStart.current = null;
        setDraft(null);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        act({ type: 'previous' });
      }}
      onWheel={(event) => {
        const time = now(runtime);
        if (Math.abs(event.deltaY) < 4 || time - lastWheel.current < WHEEL_GAP_MS) return;
        lastWheel.current = time;
        act({ type: event.deltaY > 0 ? 'next' : 'previous' });
      }}
    />
  );

  /* Rendering ------------------------------------------------------------- */

  const progress = playbackProgress(playbackSlides, index);

  const remoteSubscribe = remote?.subscribe;
  useEffect(() => remoteSubscribe?.(act), [act, remoteSubscribe]);
  const shownSlideId = slide?.slideId ?? null;
  useEffect(() => {
    onShowChange?.({
      slideId: shownSlideId,
      position: progress.position,
      total: progress.total,
      blank: state.blank,
    });
  }, [onShowChange, progress.position, progress.total, shownSlideId, state.blank]);
  const remoteButton = remote && (
    <ControlButton
      label={remote.allowed ? 'Phone remote on' : 'Allow phone remote'}
      active={remote.allowed}
      onClick={() => remote.onAllowedChange(!remote.allowed)}
    >
      <Smartphone className="size-4" />
    </ControlButton>
  );
  const elapsed = formatElapsed(timerElapsed(timer, now(runtime)));
  const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const toolButtons = (
    <>
      <ControlButton label="Pen (Ctrl+P)" active={tool === 'pen'} onClick={() => chooseTool('pen')}>
        <PenLine className="size-4" />
      </ControlButton>
      <ControlButton
        label="Highlighter (Ctrl+I)"
        active={tool === 'highlighter'}
        onClick={() => chooseTool('highlighter')}
      >
        <Highlighter className="size-4" />
      </ControlButton>
      <ControlButton
        label="Eraser (Ctrl+E)"
        active={tool === 'eraser'}
        onClick={() => chooseTool('eraser')}
      >
        <Eraser className="size-4" />
      </ControlButton>
      <ControlButton
        label="Laser pointer (L)"
        active={tool === 'laser'}
        onClick={() => chooseTool('laser')}
      >
        <Zap className="size-4" />
      </ControlButton>
      <ControlButton
        label="Arrow (Ctrl+A)"
        active={tool === 'none'}
        onClick={() => chooseTool('none')}
      >
        <MousePointer2 className="size-4" />
      </ControlButton>
      {(tool === 'pen' || tool === 'highlighter') && (
        <span className="flex items-center gap-1 px-1">
          {PLAYBACK_INK_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Ink colour ${color}`}
              aria-pressed={inkColor === color}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                setInkColor(color);
              }}
              className={`size-4 rounded-full border ${inkColor === color ? 'border-white ring-2 ring-white/60' : 'border-white/40'}`}
              style={{ background: color }}
            />
          ))}
        </span>
      )}
    </>
  );

  const overview = state.overview && (
    <div
      className="absolute inset-0 z-20 overflow-y-auto bg-black/90 p-6"
      role="dialog"
      aria-label="All slides"
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
        {slides.map((entry, at) => (
          <button
            key={entry.slideId}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => act({ type: 'goto', index: at })}
            className={`flex flex-col items-start gap-1 rounded-md p-1 text-left text-xs text-white/80 hover:bg-white/10 ${at === index ? 'ring-2 ring-primary' : ''} ${entry.hidden ? 'opacity-50' : ''}`}
          >
            <DeckSlide slide={entry} width={200} measurer={measurer} resolveAsset={resolveAsset} />
            <span>
              {at + 1}
              {entry.hidden ? ' · hidden' : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  );

  const pending = state.pendingNumber && (
    <div className="absolute top-4 right-4 z-30 rounded-md bg-black/80 px-3 py-1.5 text-lg text-white tabular-nums">
      Go to slide {state.pendingNumber}
    </div>
  );

  if (!slide) return null;

  if (view === 'slideshow') {
    return createPortal(
      <div
        className={`fixed inset-0 z-[80] bg-black ${controlsVisible || tool !== 'none' ? '' : 'cursor-none'}`}
        role="dialog"
        aria-modal="true"
        aria-label="Slide show"
        onPointerMove={showControls}
      >
        <DeckPlaybackSurface
          markup={markup}
          aspect={aspect}
          blank={state.blank}
          ended={state.ended}
          ink={inkMarkup}
          inkViewBox={[slide.width, slide.height]}
          laser={tool === 'laser' ? laser : null}
          slideKey={slide.slideId}
          animationKey={`${slide.slideId}:${buildStep}`}
          animationCss={buildCss}
          transition={sourceSlide?.transition}
        >
          {interaction}
        </DeckPlaybackSurface>
        {pending}
        {overview}
        <div
          className={`absolute bottom-4 left-4 z-30 flex items-center gap-0.5 rounded-lg bg-black/60 p-1 backdrop-blur transition-opacity ${controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
          aria-label="Slide show controls"
          role="toolbar"
        >
          <ControlButton label="Previous slide" onClick={() => act({ type: 'previous' })}>
            <ChevronLeft className="size-4" />
          </ControlButton>
          <span className="px-1 text-xs text-white/80 tabular-nums" aria-live="polite">
            {progress.position} / {progress.total}
          </span>
          <ControlButton label="Next slide" onClick={() => act({ type: 'next' })}>
            <ChevronRight className="size-4" />
          </ControlButton>
          <span className="mx-1 h-5 w-px bg-white/20" />
          {toolButtons}
          <span className="mx-1 h-5 w-px bg-white/20" />
          <ControlButton label="All slides (G)" onClick={() => dispatch({ type: 'overview' })}>
            <Grid3x3 className="size-4" />
          </ControlButton>
          <ControlButton
            label="Black screen (B)"
            active={state.blank === 'black'}
            onClick={() => dispatch({ type: 'blank', blank: 'black' })}
          >
            <Square className="size-4 fill-current" />
          </ControlButton>
          <ControlButton
            label="White screen (W)"
            active={state.blank === 'white'}
            onClick={() => dispatch({ type: 'blank', blank: 'white' })}
          >
            <SquareDashed className="size-4" />
          </ControlButton>
          {remoteButton}
          <ControlButton
            label="Presenter view"
            onClick={() => {
              setView('presenter');
              if (!audienceRef.current) void openAudience(null);
            }}
          >
            <Monitor className="size-4" />
          </ControlButton>
          <ControlButton label="End show (Esc)" onClick={exit}>
            <X className="size-4" />
          </ControlButton>
        </div>
      </div>,
      document.body,
    );
  }

  // Presenter view.
  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex flex-col bg-neutral-950 text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Presenter view"
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-white/10 px-3 text-sm">
        <span className="font-medium tabular-nums" aria-label="Elapsed time">
          {elapsed}
        </span>
        <ControlButton
          label={timer.runningSince === null ? 'Resume timer (T)' : 'Pause timer (T)'}
          onClick={() => setTimer((current) => toggleTimer(current, now(runtime)))}
        >
          {timer.runningSince === null ? <Play className="size-4" /> : <Pause className="size-4" />}
        </ControlButton>
        <ControlButton
          label="Reset timer (R)"
          onClick={() =>
            setTimer((current) => ({
              elapsed: 0,
              runningSince: current.runningSince === null ? null : now(runtime),
            }))
          }
        >
          <RotateCcw className="size-4" />
        </ControlButton>
        <span className="text-white/60 tabular-nums">{clock}</span>
        <span className="ml-2 text-white/80 tabular-nums">
          Slide {index + 1} of {slides.length}
          {slide.hidden ? ' · hidden' : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {audienceStatus === 'open' && audience ? (
            <label className="flex items-center gap-1.5 text-xs text-white/70">
              <Monitor className="size-3.5" />
              Slides on
              <select
                aria-label="Display for slides"
                className="rounded border border-white/20 bg-neutral-900 px-1.5 py-1 text-xs text-white"
                value={audience.display.id}
                onChange={(event) => moveAudience(event.target.value)}
              >
                {displays.map((display) => (
                  <option key={display.id} value={display.id}>
                    {display.name}
                    {display.primary ? ' (primary)' : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : audienceStatus === 'opening' ? (
            <span className="text-xs text-white/60">Opening the slide show window…</span>
          ) : (
            <span className="text-xs text-white/60" role="status">
              No second display — rehearsing here.
            </span>
          )}
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              audienceRequest.current += 1;
              closingAudience.current = true;
              void audienceRef.current?.close();
              audienceRef.current = null;
              setAudience(null);
              setAudienceStatus('none');
              setView('slideshow');
            }}
            className="rounded-md border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
          >
            Show slides here
          </button>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={exit}
            className="rounded-md bg-white/10 px-2 py-1 text-xs hover:bg-white/20"
          >
            End show
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,3fr)_minmax(16rem,2fr)] gap-4 p-4">
        <div className="flex min-h-0 flex-col gap-2">
          <div className="relative min-h-0 flex-1">
            <DeckPlaybackSurface
              markup={markup}
              aspect={aspect}
              blank={state.blank}
              ended={state.ended}
              ink={inkMarkup}
              inkViewBox={[slide.width, slide.height]}
              laser={tool === 'laser' ? laser : null}
              slideKey={slide.slideId}
              animationKey={`${slide.slideId}:${buildStep}`}
              animationCss={buildCss}
              transition={sourceSlide?.transition}
              endMessage="End of slide show. Click or press Esc to exit."
            >
              {interaction}
            </DeckPlaybackSurface>
            {pending}
            {overview}
          </div>
          <div
            className="flex shrink-0 flex-wrap items-center gap-0.5 rounded-lg bg-white/5 p-1"
            role="toolbar"
            aria-label="Presenter controls"
          >
            <ControlButton label="Previous slide" onClick={() => act({ type: 'previous' })}>
              <ChevronLeft className="size-4" />
            </ControlButton>
            <span className="px-1 text-xs text-white/80 tabular-nums">
              {progress.position} / {progress.total}
            </span>
            <ControlButton label="Next slide" onClick={() => act({ type: 'next' })}>
              <ChevronRight className="size-4" />
            </ControlButton>
            <span className="mx-1 h-5 w-px bg-white/20" />
            {toolButtons}
            <span className="mx-1 h-5 w-px bg-white/20" />
            <ControlButton label="All slides (G)" onClick={() => dispatch({ type: 'overview' })}>
              <Grid3x3 className="size-4" />
            </ControlButton>
            <ControlButton
              label="Black screen (B)"
              active={state.blank === 'black'}
              onClick={() => dispatch({ type: 'blank', blank: 'black' })}
            >
              <Square className="size-4 fill-current" />
            </ControlButton>
            <ControlButton
              label="White screen (W)"
              active={state.blank === 'white'}
              onClick={() => dispatch({ type: 'blank', blank: 'white' })}
            >
              <SquareDashed className="size-4" />
            </ControlButton>
            {remoteButton}
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-3">
          <div>
            <p className="mb-1 text-xs text-white/60">
              {upcoming ? `Next: slide ${upcoming.number}` : 'End of slide show'}
            </p>
            <div className="aspect-video w-full overflow-hidden rounded bg-black">
              {upcoming ? (
                <DeckPlaybackSurface
                  markup={markupFor(upcoming)}
                  aspect={upcoming.width / upcoming.height}
                  blank={null}
                  ended={false}
                  ink=""
                  inkViewBox={[1, 1]}
                  laser={null}
                />
              ) : (
                <div className="flex size-full items-center justify-center text-xs text-white/50">
                  Last slide
                </div>
              )}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col rounded-lg bg-white/5">
            <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1 text-xs text-white/60">
              Notes
              <span className="ml-auto" />
              <ControlButton
                label="Smaller notes"
                onClick={() => setNotesScale((value) => Math.max(0.75, value - 0.125))}
              >
                <span className="text-xs">A−</span>
              </ControlButton>
              <ControlButton
                label="Larger notes"
                onClick={() => setNotesScale((value) => Math.min(2.5, value + 0.125))}
              >
                <span className="text-sm">A+</span>
              </ControlButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3" aria-label="Speaker notes">
              <NotesText body={slide.notes} scale={notesScale} />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
