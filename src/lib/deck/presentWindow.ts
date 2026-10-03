/**
 * The audience window: slides on a second display while the presenter view
 * stays on this one.
 *
 * The audience window is deliberately dumb. It holds no vault, no deck, and no
 * document session; it draws the frames the presenter sends over Tauri events
 * and sends key presses back. So losing it loses nothing, and the presenter
 * decides what happens next (see `DeckPresenter`).
 *
 * Every call degrades to "no second display" outside the desktop app or when
 * the platform refuses, so presenting still works in a single window.
 */
import type { DeckTransition } from '../../types/deck';

export const AUDIENCE_WINDOW_LABEL = 'deck-audience';
export const AUDIENCE_QUERY = 'deck-audience';
export const AUDIENCE_EVENTS = {
  slide: 'deck-audience://slide',
  overlay: 'deck-audience://overlay',
  ready: 'deck-audience://ready',
  key: 'deck-audience://key',
  pointer: 'deck-audience://pointer',
} as const;

/** The slide as the audience sees it. Sent when the slide or blanking changes. */
export interface AudienceSlideFrame {
  /** Sanitized-on-arrival slide SVG, sized by the receiver. */
  svg: string;
  /** Slide aspect ratio (width / height). */
  aspect: number;
  blank: 'black' | 'white' | null;
  ended: boolean;
  slideKey?: string;
  animationKey?: string;
  animationCss?: string;
  transition?: DeckTransition;
}

/** Ink and pointer, sent as they change. Coordinates are 0..1 of the slide. */
export interface AudienceOverlayFrame {
  /** Ink as SVG elements in a `viewBox` of the slide's deck units. */
  ink: string;
  viewBox: [number, number];
  laser: { x: number; y: number } | null;
}

export interface AudienceKey {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export interface DisplayInfo {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  primary: boolean;
}

export interface AudienceHandle {
  display: DisplayInfo;
  sendSlide(frame: AudienceSlideFrame): void;
  sendOverlay(frame: AudienceOverlayFrame): void;
  close(): Promise<void>;
}

export interface AudienceCallbacks {
  /** The window went away: closed by the person, the OS, or a lost display. */
  onClosed: () => void;
  onKey: (key: AudienceKey) => void;
  /** A click or tap in the audience window: `next`, or `previous` for a right click. */
  onPointer: (action: 'next' | 'previous') => void;
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function displayId(monitor: { name: string | null; position: { x: number; y: number } }): string {
  return `${monitor.name ?? 'display'}@${monitor.position.x},${monitor.position.y}`;
}

/** The connected displays, primary first. Empty outside the desktop app. */
export async function listDisplays(): Promise<DisplayInfo[]> {
  if (!isDesktopRuntime()) return [];
  try {
    const { availableMonitors, primaryMonitor } = await import('@tauri-apps/api/window');
    const [monitors, primary] = await Promise.all([availableMonitors(), primaryMonitor()]);
    const primaryId = primary ? displayId(primary) : null;
    return monitors
      .map((monitor, index) => {
        const id = displayId(monitor);
        return {
          id,
          name: monitor.name || `Display ${index + 1}`,
          x: monitor.position.x,
          y: monitor.position.y,
          width: monitor.size.width,
          height: monitor.size.height,
          scaleFactor: monitor.scaleFactor,
          primary: id === primaryId,
        };
      })
      .sort((a, b) => Number(b.primary) - Number(a.primary));
  } catch {
    return [];
  }
}

/** The display this window is on, if the platform says. */
export async function currentDisplayId(): Promise<string | null> {
  if (!isDesktopRuntime()) return null;
  try {
    const { currentMonitor } = await import('@tauri-apps/api/window');
    const monitor = await currentMonitor();
    return monitor ? displayId(monitor) : null;
  } catch {
    return null;
  }
}

/**
 * The display the audience window should use: the one named, if still
 * connected; else the first display that is not the presenter's.
 */
export function chooseAudienceDisplay(
  displays: readonly DisplayInfo[],
  presenterDisplayId: string | null,
  preferredId: string | null,
): DisplayInfo | null {
  if (preferredId) {
    const preferred = displays.find((display) => display.id === preferredId);
    if (preferred) return preferred;
  }
  const others = displays.filter((display) => display.id !== presenterDisplayId);
  if (others.length > 0) return others[0];
  return null;
}

/** Opens the audience window full screen on a display. Null when it cannot. */
export async function openAudienceWindow(
  display: DisplayInfo,
  callbacks: AudienceCallbacks,
): Promise<AudienceHandle | null> {
  if (!isDesktopRuntime()) return null;
  try {
    const [{ WebviewWindow }, { emitTo, listen }] = await Promise.all([
      import('@tauri-apps/api/webviewWindow'),
      import('@tauri-apps/api/event'),
    ]);
    const existing = await WebviewWindow.getByLabel(AUDIENCE_WINDOW_LABEL);
    if (existing) await existing.destroy().catch(() => undefined);

    const scale = display.scaleFactor || 1;
    const window = new WebviewWindow(AUDIENCE_WINDOW_LABEL, {
      url: `index.html?${AUDIENCE_QUERY}=1`,
      title: 'Slide show',
      x: display.x / scale,
      y: display.y / scale,
      width: Math.max(320, display.width / scale),
      height: Math.max(240, display.height / scale),
      decorations: false,
      fullscreen: true,
      focus: false,
      skipTaskbar: true,
    });

    let latestSlide: AudienceSlideFrame | null = null;
    let latestOverlay: AudienceOverlayFrame | null = null;
    let closed = false;
    const unlisteners: Array<() => void> = [];
    const finish = () => {
      if (closed) return;
      closed = true;
      for (const unlisten of unlisteners) unlisten();
      callbacks.onClosed();
    };

    const created = await new Promise<boolean>((resolve) => {
      void window.once('tauri://created', () => resolve(true));
      void window.once('tauri://error', () => resolve(false));
    });
    if (!created) return null;

    unlisteners.push(
      await window.once('tauri://destroyed', finish),
      await listen<AudienceKey>(AUDIENCE_EVENTS.key, (event) => callbacks.onKey(event.payload)),
      await listen<'next' | 'previous'>(AUDIENCE_EVENTS.pointer, (event) =>
        callbacks.onPointer(event.payload),
      ),
      // A window that loads after the first frame asks for the latest one.
      await listen(AUDIENCE_EVENTS.ready, () => {
        if (latestSlide) void emitTo(AUDIENCE_WINDOW_LABEL, AUDIENCE_EVENTS.slide, latestSlide);
        if (latestOverlay)
          void emitTo(AUDIENCE_WINDOW_LABEL, AUDIENCE_EVENTS.overlay, latestOverlay);
      }),
    );

    return {
      display,
      sendSlide(frame) {
        latestSlide = frame;
        if (!closed)
          void emitTo(AUDIENCE_WINDOW_LABEL, AUDIENCE_EVENTS.slide, frame).catch(() => {});
      },
      sendOverlay(frame) {
        latestOverlay = frame;
        if (!closed)
          void emitTo(AUDIENCE_WINDOW_LABEL, AUDIENCE_EVENTS.overlay, frame).catch(() => {});
      },
      async close() {
        if (closed) return;
        closed = true;
        for (const unlisten of unlisteners) unlisten();
        await window.destroy().catch(() => undefined);
      },
    };
  } catch {
    return null;
  }
}

/** Puts this window in or out of full screen; returns the previous state. */
export async function setWindowFullscreen(fullscreen: boolean): Promise<boolean | null> {
  if (isDesktopRuntime()) {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const current = getCurrentWindow();
      const was = await current.isFullscreen();
      if (was !== fullscreen) await current.setFullscreen(fullscreen);
      return was;
    } catch {
      return null;
    }
  }
  try {
    const was = Boolean(document.fullscreenElement);
    if (fullscreen && !was) await document.documentElement.requestFullscreen?.();
    if (!fullscreen && was) await document.exitFullscreen?.();
    return was;
  } catch {
    return null;
  }
}
