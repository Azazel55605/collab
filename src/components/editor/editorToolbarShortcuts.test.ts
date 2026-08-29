import { describe, expect, it, vi } from 'vitest';

import { EDITOR_TOOLBAR_ACTION_EVENT } from '../../lib/editorToolbarActions';

import { handleEditorToolbarShortcutKeydown } from './editorToolbarShortcuts';

describe('editorToolbarShortcuts', () => {
  it('opens the visual math editor for Ctrl+Alt+M', () => {
    const preventDefault = vi.fn();
    const listener = vi.fn();
    window.addEventListener(EDITOR_TOOLBAR_ACTION_EVENT, listener);

    const handled = handleEditorToolbarShortcutKeydown({
      key: 'm',
      code: 'KeyM',
      ctrlKey: true,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      preventDefault,
    });

    window.removeEventListener(EDITOR_TOOLBAR_ACTION_EVENT, listener);
    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      detail: { action: 'math' },
    });
  });

  it('uses key code fallback when Ctrl+Alt changes the reported key', () => {
    const preventDefault = vi.fn();
    const listener = vi.fn();
    window.addEventListener(EDITOR_TOOLBAR_ACTION_EVENT, listener);

    const handled = handleEditorToolbarShortcutKeydown({
      key: 'µ',
      code: 'KeyM',
      ctrlKey: true,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      preventDefault,
    });

    window.removeEventListener(EDITOR_TOOLBAR_ACTION_EVENT, listener);
    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      detail: { action: 'math' },
    });
  });
});
