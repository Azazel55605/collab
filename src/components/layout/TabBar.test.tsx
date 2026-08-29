import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { DragProvider, useDragContext } from '../../contexts/DragContext';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';

import TabBar from './TabBar';

describe('TabBar middle click', () => {
  beforeEach(() => {
    useEditorStore.setState({
      sessionVaultPath: '/vault',
      openTabs: [
        { relativePath: 'Notes/a.md', title: 'a', isDirty: false, savedHash: null, type: 'note' },
        { relativePath: 'Notes/b.md', title: 'b', isDirty: false, savedHash: null, type: 'note' },
      ],
      activeTabPath: 'Notes/a.md',
      forceReloadPath: null,
    });

    useUiStore.setState({
      activeView: 'editor',
    });
  });

  it('closes a tab on middle click', () => {
    render(
      <DragProvider>
        <TabBar />
      </DragProvider>,
    );

    fireEvent.mouseDown(screen.getByText('a'), { button: 1 });

    expect(useEditorStore.getState().openTabs.map((tab) => tab.relativePath)).toEqual([
      'Notes/b.md',
    ]);
    expect(useEditorStore.getState().activeTabPath).toBe('Notes/b.md');
  });

  it('starts a pointer-driven drag after crossing the movement threshold', () => {
    function DragStateProbe() {
      const { draggingTab } = useDragContext();
      return <div data-testid="drag-state">{draggingTab?.relativePath ?? 'none'}</div>;
    }

    render(
      <DragProvider>
        <TabBar />
        <DragStateProbe />
      </DragProvider>,
    );

    const tab = screen.getByText('a').closest('.tab-active')!;

    // A pointerdown alone (no movement) must not start a drag — a click stays a click.
    fireEvent.pointerDown(tab, { button: 0, clientX: 10, clientY: 10 });
    expect(screen.getByTestId('drag-state').textContent).toBe('none');

    // Tiny movement below the threshold still does not start a drag.
    fireEvent.pointerMove(window, { clientX: 12, clientY: 11 });
    expect(screen.getByTestId('drag-state').textContent).toBe('none');

    // Crossing the threshold begins the drag.
    fireEvent.pointerMove(window, { clientX: 40, clientY: 12 });
    expect(screen.getByTestId('drag-state').textContent).toBe('Notes/a.md');

    // Releasing ends the drag.
    fireEvent.pointerUp(window, { clientX: 40, clientY: 12 });
    expect(screen.getByTestId('drag-state').textContent).toBe('none');
  });

  it('does not start a drag on a non-left button', () => {
    function DragStateProbe() {
      const { draggingTab } = useDragContext();
      return <div data-testid="drag-state">{draggingTab?.relativePath ?? 'none'}</div>;
    }

    render(
      <DragProvider>
        <TabBar />
        <DragStateProbe />
      </DragProvider>,
    );

    const tab = screen.getByText('a').closest('.tab-active')!;
    fireEvent.pointerDown(tab, { button: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 60, clientY: 12 });
    expect(screen.getByTestId('drag-state').textContent).toBe('none');
  });
});
