import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCanvasNodeCommands } from './useCanvasNodeCommands';

describe('useCanvasNodeCommands', () => {
  beforeEach(() => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('11111111-1111-1111-1111-111111111111');
  });

  it('creates a text node at the viewport center', () => {
    const addCanvasNode = vi.fn();
    const viewportRef = {
      current: {
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 200 }),
      } as unknown as HTMLDivElement,
    };

    const { result } = renderHook(() => useCanvasNodeCommands({
      reactFlow: {
        screenToFlowPosition: ({ x, y }) => ({ x, y }),
      },
      viewportRef,
      pickerMode: null,
      setPickerMode: vi.fn(),
      allFiles: [],
      addCanvasNode,
    }));

    result.current.addTextNode();

    expect(addCanvasNode).toHaveBeenCalledWith({
      id: '11111111-1111-1111-1111-111111111111',
      type: 'text',
      content: '',
      position: { x: 160, y: 120 },
      width: 280,
      height: 160,
    });
  });

  it('creates a note node from picker selection and closes the picker', () => {
    const addCanvasNode = vi.fn();
    const setPickerMode = vi.fn();

    const { result } = renderHook(() => useCanvasNodeCommands({
      reactFlow: {
        screenToFlowPosition: ({ x, y }) => ({ x, y }),
      },
      viewportRef: {
        current: {
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
        } as unknown as HTMLDivElement,
      },
      pickerMode: 'note',
      setPickerMode,
      allFiles: [],
      addCanvasNode,
    }));

    result.current.handlePickerSelect({
      name: 'alpha.md',
      relativePath: 'Notes/alpha.md',
      isFolder: false,
      extension: 'md',
      modifiedAt: 0,
      size: 0,
    });

    expect(addCanvasNode).toHaveBeenCalledWith({
      id: '11111111-1111-1111-1111-111111111111',
      type: 'note',
      relativePath: 'Notes/alpha.md',
      position: { x: 100, y: 50 },
      width: 300,
      height: 180,
    });
    expect(setPickerMode).toHaveBeenCalledWith(null);
  });

  it('creates a dropped file node from drag data', () => {
    const addCanvasNode = vi.fn();

    const { result } = renderHook(() => useCanvasNodeCommands({
      reactFlow: {
        screenToFlowPosition: ({ x, y }) => ({ x: x + 5, y: y + 7 }),
      },
      viewportRef: { current: null },
      pickerMode: null,
      setPickerMode: vi.fn(),
      allFiles: [{
        name: 'diagram.png',
        relativePath: 'Assets/diagram.png',
        isFolder: false,
        extension: 'png',
        modifiedAt: 0,
        size: 0,
      }],
      addCanvasNode,
    }));

    const preventDefault = vi.fn();
    result.current.handleDropOnCanvas({
      preventDefault,
      clientX: 40,
      clientY: 60,
      dataTransfer: {
        getData: () => 'Assets/diagram.png',
      },
    } as unknown as React.DragEvent<HTMLDivElement>);

    expect(preventDefault).toHaveBeenCalled();
    expect(addCanvasNode).toHaveBeenCalledWith({
      id: '11111111-1111-1111-1111-111111111111',
      type: 'file',
      relativePath: 'Assets/diagram.png',
      position: { x: 45, y: 67 },
      width: 300,
      height: 180,
    });
  });
});
