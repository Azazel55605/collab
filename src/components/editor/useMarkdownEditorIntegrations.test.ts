import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleNativeEditorDrop,
  importDroppedImagesIntoEditor,
  resolveHoverPreviewState,
} from './useMarkdownEditorIntegrations';

describe('useMarkdownEditorIntegrations helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('resolves hovered http links when previews are enabled', () => {
    const link = document.createElement('a');
    link.className = 'cm-lp-link';
    link.dataset.url = 'https://example.com';
    link.getBoundingClientRect = vi.fn(() => new DOMRect(10, 20, 30, 40));
    document.body.append(link);

    const event = new MouseEvent('mousemove', { bubbles: true });
    Object.defineProperty(event, 'target', { value: link });

    expect(resolveHoverPreviewState(event, true)).toEqual({
      url: 'https://example.com',
      rect: expect.any(DOMRect),
    });
  });

  it('imports dropped images into the editor and focuses it', async () => {
    const dispatch = vi.fn();
    const focus = vi.fn();
    const importAssetIntoVault = vi.fn(async (_vaultPath: string, sourcePath: string) => `Pictures/${sourcePath.split('/').pop()}`);
    const view = {
      dispatch,
      focus,
    } as unknown as import('@codemirror/view').EditorView;

    const success = await importDroppedImagesIntoEditor({
      sourcePaths: ['/tmp/example.png', '/tmp/not-image.txt'],
      dropPos: 5,
      view,
      vaultPath: '/vault',
      isImageLikePath: (path) => path.endsWith('.png'),
      buildImageMarkdown: (relativePath) => `![](${relativePath})`,
      importAssetIntoVault,
    });

    expect(success).toBe(true);
    expect(importAssetIntoVault).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      changes: { from: 5, to: 5, insert: '![](Pictures/example.png)' },
      selection: { anchor: 30 },
    });
    expect(focus).toHaveBeenCalled();
  });

  it('deduplicates repeated native drops at the same position', () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1100)
      .mockReturnValue(2000);

    const importDroppedImages = vi.fn();
    const editorDom = document.createElement('div');
    editorDom.getBoundingClientRect = vi.fn(() => new DOMRect(0, 0, 200, 200));
    const stateRef = { current: { lastDropKey: '', lastDropAt: 0 } };
    const view = {
      state: {
        selection: {
          main: {
            from: 7,
          },
        },
      },
    } as unknown as import('@codemirror/view').EditorView;

    expect(handleNativeEditorDrop({
      paths: ['a.png'],
      clientX: 20,
      clientY: 20,
      editorDom,
      view,
      stateRef,
      importDroppedImages,
    })).toBe(true);

    expect(handleNativeEditorDrop({
      paths: ['a.png'],
      clientX: 20,
      clientY: 20,
      editorDom,
      view,
      stateRef,
      importDroppedImages,
    })).toBe(false);

    expect(handleNativeEditorDrop({
      paths: ['a.png'],
      clientX: 40,
      clientY: 40,
      editorDom,
      view,
      stateRef,
      importDroppedImages,
    })).toBe(true);

    expect(importDroppedImages).toHaveBeenCalledTimes(2);
    expect(importDroppedImages).toHaveBeenCalledWith(['a.png'], 7);
  });
});
