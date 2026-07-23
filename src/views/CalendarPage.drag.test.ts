import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCompactCalendarDragImage } from './CalendarPage';

afterEach(() => {
  vi.useRealTimers();
});

describe('calendar drag preview', () => {
  it('uses a bounded preview instead of the full event dimensions', () => {
    vi.useFakeTimers();
    const source = document.createElement('div');
    source.setAttribute('draggable', 'true');
    source.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 240,
      bottom: 180,
      width: 240,
      height: 180,
      toJSON: () => ({}),
    });
    const setDragImage = vi.fn();

    setCompactCalendarDragImage({ setDragImage } as unknown as DataTransfer, source, 1);

    const preview = setDragImage.mock.calls[0][0] as HTMLElement;
    expect(preview.style.width).toBe('140px');
    expect(preview.style.height).toBe('30px');
    expect(preview.getAttribute('draggable')).toBeNull();
    expect(document.body.contains(preview)).toBe(true);

    vi.runAllTimers();
    expect(document.body.contains(preview)).toBe(false);
  });

  it('compensates its CSS dimensions for the configured interface scale', () => {
    vi.useFakeTimers();
    const source = document.createElement('div');
    source.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 240,
      bottom: 180,
      width: 240,
      height: 180,
      toJSON: () => ({}),
    });
    const setDragImage = vi.fn();

    setCompactCalendarDragImage({ setDragImage } as unknown as DataTransfer, source, 1.5);

    const preview = setDragImage.mock.calls[0][0] as HTMLElement;
    expect(preview.style.width).toBe('93px');
    expect(preview.style.height).toBe('20px');
  });
});
