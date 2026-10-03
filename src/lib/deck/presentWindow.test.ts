import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DisplayInfo } from './presentWindow';
import { audienceViewportSize, openAudienceWindow, setWindowFullscreen } from './presentWindow';

const mocks = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  setFullscreenOnMonitor: vi.fn(async () => {}),
  show: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  currentSetFullscreen: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/dpi', () => ({
  PhysicalPosition: class PhysicalPosition {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class WebviewWindow {
    setFullscreenOnMonitor = mocks.setFullscreenOnMonitor;
    show = mocks.show;
    destroy = mocks.destroy;

    constructor(_label: string, options: Record<string, unknown>) {
      mocks.options = options;
    }

    async once(event: string, callback: () => void) {
      if (event === 'tauri://created') queueMicrotask(callback);
      return () => {};
    }
  },
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    isFullscreen: vi.fn(async () => false),
    setFullscreen: mocks.currentSetFullscreen,
  })),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

afterEach(() => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('presentation windows', () => {
  it.each([
    { width: 1_920, height: 1_080, scaleFactor: 1 },
    { width: 2_560, height: 1_440, scaleFactor: 1.33 },
    { width: 2_554, height: 1_464, scaleFactor: 1.875 },
  ])(
    'converts $scaleFactor-scale monitor bounds into an initial logical webview size',
    ({ width, height, scaleFactor }) => {
      expect(
        audienceViewportSize({
          id: 'projector',
          name: 'Projector',
          x: 0,
          y: 0,
          width,
          height,
          scaleFactor,
          primary: false,
        }),
      ).toEqual({ width: width / scaleFactor, height: height / scaleFactor });
    },
  );

  it('maps the audience webview before fullscreening it on the selected monitor', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const display: DisplayInfo = {
      id: 'projector',
      name: 'Projector',
      x: 0,
      y: 0,
      width: 2_554,
      height: 1_464,
      scaleFactor: 1.875,
      primary: false,
    };

    const handle = await openAudienceWindow(display, {
      onClosed: vi.fn(),
      onKey: vi.fn(),
      onPointer: vi.fn(),
    });

    expect(handle).not.toBeNull();
    expect(mocks.options).toMatchObject({
      fullscreen: false,
      visible: false,
      width: 2_554 / 1.875,
      height: 1_464 / 1.875,
    });
    expect(mocks.setFullscreenOnMonitor).toHaveBeenCalledWith(
      expect.objectContaining({ x: 0, y: 0 }),
    );
    expect(mocks.show).toHaveBeenCalledOnce();
    expect(mocks.show.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setFullscreenOnMonitor.mock.invocationCallOrder[0],
    );
  });

  it('lets the platform size the main window when it enters fullscreen', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    await expect(setWindowFullscreen(true)).resolves.toBe(false);

    expect(mocks.currentSetFullscreen).toHaveBeenCalledWith(true);
  });
});
