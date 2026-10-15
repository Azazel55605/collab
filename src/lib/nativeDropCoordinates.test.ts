import { describe, expect, it, vi } from 'vitest';

import { nativeDropFolderAtPoint } from '../components/vault/nativeDropTarget';

import { nativeDropClientPoint, resolveNativeDropPoint } from './nativeDropCoordinates';

const api = vi.hoisted(() => ({ viewport: vi.fn() }));
vi.mock('./tauri', () => ({ tauriCommands: { nativeDropViewport: api.viewport } }));

describe('native drop coordinate spaces', () => {
  it.each([
    ['Wayland logical, no display scaling', 1200, 600, 1200, 600, 110, 115],
    ['Wayland logical, HiDPI display', 1200, 600, 1200, 600, 110, 115],
    ['Wayland logical, 150% app zoom', 1200, 600, 800, 400, 165, 172.5],
    ['Windows physical, no display scaling', 1200, 600, 1200, 600, 110, 115],
    ['Windows physical, 200% display', 2400, 1200, 1200, 600, 220, 230],
    ['Windows physical, 200% display and 150% app zoom', 2400, 1200, 800, 400, 330, 345],
  ])('%s hits the same CSS folder row', (_label, width, height, cssWidth, cssHeight, x, y) => {
    const point = nativeDropClientPoint(
      { x, y },
      { width, height },
      { width: cssWidth, height: cssHeight },
    );
    expect(point).toEqual({ x: 110, y: 115 });
    const tree = document.createElement('div');
    tree.innerHTML =
      '<div data-tree-drop-folder="first"></div><div data-tree-drop-folder="second"></div>';
    tree.children[0].getBoundingClientRect = () =>
      ({ left: 0, right: 220, top: 70, bottom: 100 }) as DOMRect;
    tree.children[1].getBoundingClientRect = () =>
      ({ left: 0, right: 220, top: 100, bottom: 130 }) as DOMRect;
    expect(nativeDropFolderAtPoint(tree, point)).toBe('second');
  });

  it('rejects unavailable viewports instead of guessing a destination', () => {
    expect(() =>
      nativeDropClientPoint({ x: 10, y: 10 }, { width: 0, height: 0 }, { width: 100, height: 100 }),
    ).toThrow();
  });

  it('queries fresh native geometry for every committed drop', async () => {
    api.viewport.mockResolvedValueOnce({ width: window.innerWidth, height: window.innerHeight });
    api.viewport.mockResolvedValueOnce({
      width: window.innerWidth * 2,
      height: window.innerHeight * 2,
    });
    expect(await resolveNativeDropPoint({ x: 200, y: 200 }, true)).toEqual({ x: 200, y: 200 });
    expect(await resolveNativeDropPoint({ x: 200, y: 200 }, true)).toEqual({ x: 100, y: 100 });
    expect(api.viewport).toHaveBeenCalledTimes(2);
  });
});
