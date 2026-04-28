import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { DragProvider } from '../../contexts/DragContext';
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

    expect(useEditorStore.getState().openTabs.map((tab) => tab.relativePath)).toEqual(['Notes/b.md']);
    expect(useEditorStore.getState().activeTabPath).toBe('Notes/b.md');
  });
});
