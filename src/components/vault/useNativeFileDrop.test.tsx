import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { useNativeFileDrop } from './useNativeFileDrop';

const mocks = vi.hoisted(() => ({ webview: vi.fn(), window: vi.fn() }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: mocks.webview }),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onDragDropEvent: mocks.window }),
}));
beforeEach(() => {
  mocks.webview.mockReset();
  mocks.window.mockReset();
  mocks.webview.mockResolvedValue(() => {});
  mocks.window.mockResolvedValue(() => {});
});

it('uses one coordinate source, deduplicates paths and ignores events after unmount', async () => {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 300 }) as DOMRect;
  const drop = vi.fn();
  const hook = renderHook(() => useNativeFileDrop({ current: element }, drop));
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.webview).toHaveBeenCalledOnce();
  expect(mocks.window).not.toHaveBeenCalled();
  const handler = mocks.webview.mock.calls[0][0];
  act(() => {
    handler({ payload: { type: 'drop', paths: ['file.png'], position: { x: 100, y: 100 } } });
    handler({ payload: { type: 'drop', paths: ['file.png'], position: { x: 120, y: 120 } } });
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
