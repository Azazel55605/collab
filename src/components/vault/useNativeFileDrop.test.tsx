import { act, renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, expect, it, vi } from 'vitest';

import { useNativeFileDrop } from './useNativeFileDrop';

const mocks = vi.hoisted(() => ({ webview: vi.fn(), window: vi.fn(), viewport: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: mocks.webview }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onDragDropEvent: mocks.window }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../lib/tauri', () => ({ tauriCommands: { nativeDropViewport: mocks.viewport } }));
beforeEach(() => {
  mocks.viewport
    .mockReset()
    .mockResolvedValue({ width: window.innerWidth, height: window.innerHeight });
  mocks.webview.mockReset();
  mocks.window.mockReset();
  mocks.webview.mockResolvedValue(() => {});
  mocks.window.mockResolvedValue(() => {});
});

it('uses one coordinate source, deduplicates paths and ignores events after unmount', async () => {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 300 }) as DOMRect;
  const drop = vi.fn();
  const ref = { current: element };
  const hook = renderHook(() => useNativeFileDrop(ref, drop));
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.webview).toHaveBeenCalledOnce();
  expect(mocks.window).not.toHaveBeenCalled();
  const handler = mocks.webview.mock.calls[0][0];
  await act(async () => {
    handler({ payload: { type: 'drop', paths: ['file.png'], position: { x: 100, y: 100 } } });
    handler({ payload: { type: 'drop', paths: ['file.png'], position: { x: 120, y: 120 } } });
    await Promise.resolve();
  });
  expect(drop).toHaveBeenCalledOnce();
  hook.unmount();
  handler({ payload: { type: 'drop', paths: ['another.png'], position: { x: 100, y: 100 } } });
  expect(drop).toHaveBeenCalledOnce();
});

it('falls back to window events only when webview registration fails', async () => {
  mocks.webview.mockRejectedValue(new Error('not supported'));
  const element = document.createElement('div');
  renderHook(() => useNativeFileDrop({ current: element }, vi.fn()));
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.window).toHaveBeenCalledOnce();
});

it('uses the converted CSS point for both the hover area and committed drop', async () => {
  mocks.viewport.mockResolvedValue({
    width: window.innerWidth * 2,
    height: window.innerHeight * 2,
  });
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ left: 90, top: 90, right: 110, bottom: 110 }) as DOMRect;
  const drop = vi.fn();
  const ref = { current: element };
  const hook = renderHook(() => useNativeFileDrop(ref, drop));
  const handler = mocks.webview.mock.calls[0][0];
  await act(async () => {
    handler({ payload: { type: 'enter', position: { x: 200, y: 200 } } });
    await Promise.resolve();
  });
  expect(hook.result.current.isDraggingOver).toBe(true);
  await act(async () => {
    handler({ payload: { type: 'drop', paths: ['scaled.png'], position: { x: 200, y: 200 } } });
    await Promise.resolve();
  });
  expect(drop).toHaveBeenCalledWith(['scaled.png'], { x: 100, y: 100 });
  expect(hook.result.current.isDraggingOver).toBe(false);
});

it('ignores an old hover lookup after leaving the drop area', async () => {
  let resolve!: (size: { width: number; height: number }) => void;
  mocks.viewport.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 300 }) as DOMRect;
  const ref = { current: element };
  const hook = renderHook(() => useNativeFileDrop(ref, vi.fn()));
  const handler = mocks.webview.mock.calls[0][0];
  await act(async () => {
    handler({ payload: { type: 'enter', position: { x: 100, y: 100 } } });
    handler({ payload: { type: 'leave' } });
    resolve({ width: window.innerWidth, height: window.innerHeight });
  });
  expect(hook.result.current.isDraggingOver).toBe(false);
});

it('does not import an in-flight drop after the vault changes', async () => {
  let resolve!: (size: { width: number; height: number }) => void;
  mocks.viewport.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 300 }) as DOMRect;
  const ref = { current: element };
  const drop = vi.fn();
  const hook = renderHook(({ scope }) => useNativeFileDrop(ref, drop, true, scope), {
    initialProps: { scope: 'old-vault' },
  });
  const handler = mocks.webview.mock.calls[0][0];
  act(() =>
    handler({ payload: { type: 'drop', paths: ['file.png'], position: { x: 100, y: 100 } } }),
  );
  hook.rerender({ scope: 'new-vault' });
  await act(async () => resolve({ width: window.innerWidth, height: window.innerHeight }));
  expect(drop).not.toHaveBeenCalled();
});

it('reports unavailable drop geometry without importing into a guessed target', async () => {
  mocks.viewport.mockRejectedValue(new Error('native view unavailable'));
  const element = document.createElement('div');
  const ref = { current: element };
  const drop = vi.fn();
  renderHook(() => useNativeFileDrop(ref, drop));
  const handler = mocks.webview.mock.calls[0][0];
  await act(async () =>
    handler({ payload: { type: 'drop', paths: ['file.png'], position: { x: 100, y: 100 } } }),
  );
  expect(drop).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalledWith(
    'Could not determine the file drop target. Please try again.',
  );
});
