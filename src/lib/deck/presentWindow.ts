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

/** Events are scoped to one audience window so overlapping open/close work cannot cross-talk. */
export function audienceEvents(session: string) {
  const prefix = `deck-audience://${session}`;
  return {
    slide: `${prefix}/slide`,
    overlay: `${prefix}/overlay`,
    ready: `${prefix}/ready`,
    key: `${prefix}/key`,
    pointer: `${prefix}/pointer`,
  } as const;
}

let audienceWindowSequence = 0;

function nextAudienceWindowLabel(): string {
  audienceWindowSequence += 1;
  const unique = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${audienceWindowSequence}`;
  return `${AUDIENCE_WINDOW_LABEL}-${unique}`;
}

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

/** Monitor bounds are physical; Tauri window constructor dimensions are logical. */
export function audienceViewportSize(display: DisplayInfo): { width: number; height: number } {
  const scaleFactor =
    Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
  return {
    width: Math.max(320, display.width / scaleFactor),
    height: Math.max(240, display.height / scaleFactor),
  };
}

/** Opens the audience window full screen on a display. Null when it cannot. */
export async function openAudienceWindow(
  display: DisplayInfo,
  callbacks: AudienceCallbacks,
): Promise<AudienceHandle | null> {
  if (!isDesktopRuntime()) return null;
  try {
    const [{ PhysicalPosition }, { WebviewWindow }, { emitTo, listen }] = await Promise.all([
      import('@tauri-apps/api/dpi'),
      import('@tauri-apps/api/webviewWindow'),
      import('@tauri-apps/api/event'),
    ]);
    const label = nextAudienceWindowLabel();
    const events = audienceEvents(label);
    const viewport = audienceViewportSize(display);
    const window = new WebviewWindow(label, {
      url: `index.html?${AUDIENCE_QUERY}=${encodeURIComponent(label)}`,
      title: 'Slide show',
      decorations: false,
      fullscreen: false,
      focus: false,
      skipTaskbar: true,
      visible: false,
      width: viewport.width,
      height: viewport.height,
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

    try {
      unlisteners.push(await window.once('tauri://destroyed', finish));
      unlisteners.push(
        await listen<AudienceKey>(events.key, (event) => callbacks.onKey(event.payload)),
      );
      unlisteners.push(
        await listen<'next' | 'previous'>(events.pointer, (event) =>
          callbacks.onPointer(event.payload),
        ),
      );
      // A window that loads after the first frame asks for the latest one.
      unlisteners.push(
        await listen(events.ready, () => {
          if (latestSlide) void emitTo(label, events.slide, latestSlide);
          if (latestOverlay) void emitTo(label, events.overlay, latestOverlay);
        }),
      );

      // Map the native window before asking the compositor to fullscreen it.
      // WebKitGTK can retain the hidden window's initial viewport allocation
      // when fullscreen is applied first, leaving the slide at the old size
      // inside an otherwise correctly sized native window.
      await window.show();
      // This uses the native monitor handle selected by Tauri instead of
      // emulating placement with absolute coordinates. That distinction is
      // required on Wayland and avoids mixed-DPI coordinate bugs elsewhere.
      await window.setFullscreenOnMonitor(new PhysicalPosition(display.x, display.y));
    } catch {
      closed = true;
      for (const unlisten of unlisteners) unlisten();
      await window.destroy().catch(() => undefined);
      return null;
    }

    return {
      display,
      sendSlide(frame) {
        latestSlide = frame;
        if (!closed) void emitTo(label, events.slide, frame).catch(() => {});
      },
      sendOverlay(frame) {
        latestOverlay = frame;
        if (!closed) void emitTo(label, events.overlay, frame).catch(() => {});
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
