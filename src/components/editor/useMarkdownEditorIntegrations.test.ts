import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleEditorDocumentLinkMouseDown,
  handleEditorImageShiftClick,
  handleNativeEditorDrop,
  importDroppedImagesIntoEditor,
  resolveHoverPreviewState,
} from './useMarkdownEditorIntegrations';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

describe('useMarkdownEditorIntegrations helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    useEditorStore.setState({
      sessionVaultPath: null,
      openTabs: [],
      activeTabPath: null,
      forceReloadPath: null,
    });
    useUiStore.setState({
      activeView: 'editor',
    });
    useVaultStore.setState({
      vault: null,
      isVaultLocked: false,
      fileTree: [
        {
          relativePath: 'Notes',
          name: 'Notes',
          extension: '',
          modifiedAt: 0,
          size: 0,
          isFolder: true,
          children: [
            {
              relativePath: 'Notes/a.md',
              name: 'a.md',
              extension: 'md',
              modifiedAt: 0,
              size: 1,
              isFolder: false,
            },
          ],
        },
        {
          relativePath: 'Docs',
          name: 'Docs',
          extension: '',
          modifiedAt: 0,
          size: 0,
          isFolder: true,
          children: [
            {
              relativePath: 'Docs/spec.pdf',
              name: 'spec.pdf',
              extension: 'pdf',
              modifiedAt: 0,
              size: 1,
              isFolder: false,
            },
          ],
        },
      ],
      recentVaults: [],
      lastOpenedVaultPath: null,
      isLoading: false,
    });
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

  it('opens vault-backed live preview images in the image viewer on shift-mousedown', () => {
    const openTab = vi.spyOn(useEditorStore.getState(), 'openTab');
    const setActiveView = vi.spyOn(useUiStore.getState(), 'setActiveView');

    const wrap = document.createElement('span');
    const img = document.createElement('img');
    img.className = 'cm-lp-image';
    img.dataset.assetKind = 'vault';
    img.dataset.assetValue = 'Pictures/demo.png';
    wrap.appendChild(img);
    document.body.appendChild(wrap);

    const event = new MouseEvent('mousedown', { bubbles: true, shiftKey: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: img });

    expect(handleEditorImageShiftClick(event)).toBe(true);
    expect(openTab).toHaveBeenCalledWith('Pictures/demo.png', 'demo', 'image');
    expect(setActiveView).toHaveBeenCalledWith('editor');
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens wikilinked PDFs in the PDF viewer on mousedown', () => {
    const openTab = vi.spyOn(useEditorStore.getState(), 'openTab');
    const setActiveView = vi.spyOn(useUiStore.getState(), 'setActiveView');

    const link = document.createElement('span');
    link.className = 'cm-lp-wikilink';
    link.dataset.path = 'spec.pdf';
    document.body.append(link);

    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: link });

    expect(handleEditorDocumentLinkMouseDown(event, 'Notes/a.md')).toBe(true);
    expect(openTab).toHaveBeenCalledWith('Docs/spec.pdf', 'spec', 'pdf');
    expect(setActiveView).toHaveBeenCalledWith('editor');
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens relative markdown links to PDFs in the PDF viewer on mousedown', () => {
    const openTab = vi.spyOn(useEditorStore.getState(), 'openTab');

    const link = document.createElement('span');
    link.className = 'cm-lp-link';
    link.dataset.url = '../Docs/spec.pdf';
    document.body.append(link);

    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: link });

    expect(handleEditorDocumentLinkMouseDown(event, 'Notes/a.md')).toBe(true);
    expect(openTab).toHaveBeenCalledWith('Docs/spec.pdf', 'spec', 'pdf');
  });
});
