import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

import { useCommandBarShell } from './useCommandBarShell';

afterEach(cleanup);
it('does not rerender for cursor/scroll, sidebar geometry or vault progress changes', () => {
  let renders = 0;
  renderHook(() => {
    renders++;
    return useCommandBarShell();
  });
  const baseline = renders;
  act(() => {
    for (let i = 0; i < 100; i++) {
      useEditorStore
        .getState()
        .setNoteViewState('fixture.md', { scrollTop: i, selectionAnchor: i, selectionHead: i });
      useUiStore.setState({ sidebarWidth: 160 + i });
      useVaultStore.setState({ isLoading: i % 2 === 0 });
    }
  });
  expect(renders).toBe(baseline);
});
