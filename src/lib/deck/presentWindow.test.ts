import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DisplayInfo } from './presentWindow';
import { openAudienceWindow, setWindowFullscreen } from './presentWindow';

const mocks = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  setPosition: vi.fn(async () => {}),
  setSize: vi.fn(async () => {}),
  setFullscreen: vi.fn(async () => {}),
  destroy: vi.fn(async () => {}),
  currentSetSize: vi.fn(async () => {}),
  currentSetFullscreen: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/dpi', () => ({
  PhysicalPosition: class PhysicalPosition {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
  PhysicalSize: class PhysicalSize {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class WebviewWindow {
    static getByLabel = vi.fn(async () => null);
    setPosition = mocks.setPosition;
    setSize = mocks.setSize;
    setFullscreen = mocks.setFullscreen;
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
  currentMonitor: vi.fn(async () => ({ size: { width: 2_554, height: 1_464 } })),
  getCurrentWindow: vi.fn(() => ({
    isFullscreen: vi.fn(async () => false),
    setFullscreen: mocks.currentSetFullscreen,
    setSize: mocks.currentSetSize,
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
  it('opens the audience window visibly and reapplies physical fullscreen bounds', async () => {
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
    expect(mocks.options).toMatchObject({ fullscreen: true });
    expect(mocks.options).not.toHaveProperty('visible');
    expect(mocks.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 0, y: 0 }));
    expect(mocks.setSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 2_554, height: 1_464 }),
    );
    expect(mocks.setFullscreen).toHaveBeenCalledWith(true);
  });

  it('reapplies physical monitor size after the main window enters fullscreen', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    await expect(setWindowFullscreen(true)).resolves.toBe(false);

    expect(mocks.currentSetFullscreen).toHaveBeenCalledWith(true);
    expect(mocks.currentSetSize).toHaveBeenCalledWith(
      expect.objectContaining({ width: 2_554, height: 1_464 }),
    );
  });
});
