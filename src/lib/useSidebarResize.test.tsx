import { act, fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { useSidebarResize } from './useSidebarResize';

it('keeps 100 move events local, commits the final width once and restores body styles', () => {
  const commit = vi.fn();
  let paint: FrameRequestCallback | undefined;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    paint = callback;
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  function Fixture() {
    const resize = useSidebarResize(240, commit);
    return <div ref={resize.element} data-testid="sidebar" onMouseDown={resize.start} />;
  }
  const view = render(<Fixture />);
  document.body.style.cursor = 'crosshair';
  fireEvent.mouseDown(view.getByTestId('sidebar'), { button: 0, clientX: 240 });
  for (let i = 0; i < 100; i++) fireEvent.mouseMove(window, { clientX: 241 + i });
  expect(commit).not.toHaveBeenCalled();
  act(() => paint!(0));
  expect(view.getByTestId('sidebar').style.getPropertyValue('--sidebar-width')).toBe('340px');
  fireEvent.mouseUp(window);
  expect(commit).toHaveBeenCalledExactlyOnceWith(340);
  expect(document.body.style.cursor).toBe('crosshair');
  document.body.style.cursor = '';
  view.unmount();
});
