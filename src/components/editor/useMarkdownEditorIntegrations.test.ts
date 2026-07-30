import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getClipboardFileUriPaths,
  getClipboardEventImageSources,
  getClipboardHtmlImageSources,
  handleEditorDocumentLinkMouseDown,
  handleEditorImageShiftClick,
  handleNativeEditorDrop,
  importClipboardImagesIntoEditor,
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
      pendingSheetJump: null,
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
            {
              relativePath: 'Docs/budget.sheet',
              name: 'budget.sheet',
              extension: 'sheet',
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
      pdfRelativePath: null,
      rect: expect.any(DOMRect),
    });
  });

  it('resolves hovered vault PDF links for local preview', () => {
    const link = document.createElement('span');
    link.className = 'cm-lp-link';
    link.dataset.url = '../Docs/spec.pdf';
    link.getBoundingClientRect = vi.fn(() => new DOMRect(10, 20, 30, 40));
    document.body.append(link);

    const event = new MouseEvent('mousemove', { bubbles: true });
    Object.defineProperty(event, 'target', { value: link });

    expect(resolveHoverPreviewState(event, true, 'Notes/a.md')).toEqual({
      url: null,
      pdfRelativePath: 'Docs/spec.pdf',
      rect: expect.any(DOMRect),
    });
  });

  it('imports dropped images into the editor and focuses it', async () => {
    const dispatch = vi.fn();
    const focus = vi.fn();
    const importAsset = vi.fn(async (sourcePath: string) => `Pictures/${sourcePath.split('/').pop()}`);
    const view = {
      dispatch,
      focus,
    } as unknown as import('@codemirror/view').EditorView;

    const success = await importDroppedImagesIntoEditor({
      sourcePaths: ['/tmp/example.png', '/tmp/not-image.txt'],
      dropPos: 5,
      view,
      importAsset,
      isImageLikePath: (path) => path.endsWith('.png'),
      buildImageMarkdown: (relativePath) => `![](${relativePath})`,
    });

    expect(success).toBe(true);
    expect(importAsset).toHaveBeenCalledTimes(1);
    expect(importAsset).toHaveBeenCalledWith('/tmp/example.png', 'Pictures');
    expect(dispatch).toHaveBeenCalledWith({
      changes: { from: 5, to: 5, insert: '![](Pictures/example.png)' },
      selection: { anchor: 30 },
    });
    expect(focus).toHaveBeenCalled();
  });

  it('extracts image files from clipboard data', () => {
    const imageFile = new File(['png'], 'capture.png', { type: 'image/png' });
    const textFile = new File(['text'], 'note.txt', { type: 'text/plain' });
    const clipboardData = {
      files: [imageFile, textFile],
      items: [],
    } as unknown as DataTransfer;

    expect(getClipboardEventImageSources(clipboardData)).toEqual([
      {
        kind: 'blob',
        blob: imageFile,
        mime: 'image/png',
        suggestedFileName: 'capture.png',
      },
    ]);
  });

  it('extracts local file paths from clipboard uri text', () => {
    const clipboardData = {
      getData: (type: string) => {
        if (type === 'text/plain') return 'file:///tmp/Capture%20One.png';
        return '';
      },
    } as unknown as DataTransfer;

    expect(getClipboardFileUriPaths(clipboardData)).toEqual(['/tmp/Capture One.png']);
  });

  it('extracts embedded data-url images from clipboard html', () => {
    expect(
      getClipboardHtmlImageSources('<p><img src="data:image/png;base64,abc123" /><img src="https://example.com/a.png" /></p>'),
    ).toEqual([
      {
        kind: 'dataUrl',
        dataUrl: 'data:image/png;base64,abc123',
        suggestedFileName: 'clipboard-image.png',
      },
    ]);
  });

  it('imports clipboard images into the editor and inserts markdown links', async () => {
    const dispatch = vi.fn();
    const focus = vi.fn();
    const importData = vi
      .fn()
      .mockResolvedValueOnce('Pictures/clipboard-image.png')
      .mockResolvedValueOnce('Pictures/clipboard-image-2.webp');
    const view = {
      dispatch,
      focus,
    } as unknown as import('@codemirror/view').EditorView;
    const expectedInsert = '![Notes/a.md](Pictures/clipboard-image.png)\n![Notes/a.md](Pictures/clipboard-image-2.webp)';

    const success = await importClipboardImagesIntoEditor({
      clipboardImages: [
        {
          kind: 'dataUrl',
          dataUrl: 'data:image/png;base64,abc123',
          suggestedFileName: 'clipboard-image.png',
        },
        {
          kind: 'dataUrl',
          dataUrl: 'data:image/webp;base64,def456',
          suggestedFileName: 'clipboard-image-2.webp',
        },
      ],
      insertPos: 12,
      view,
      importData,
      currentDocumentRelativePath: 'Notes/a.md',
      buildImageMarkdown: (relativePath, currentDocumentRelativePath) => `![${currentDocumentRelativePath}](${relativePath})`,
    });

    expect(success).toBe(true);
    expect(importData).toHaveBeenNthCalledWith(
      1,
      'data:image/png;base64,abc123',
      'clipboard-image.png',
      'Pictures',
    );
    expect(importData).toHaveBeenNthCalledWith(
      2,
      'data:image/webp;base64,def456',
      'clipboard-image-2.webp',
      'Pictures',
    );
    expect(dispatch).toHaveBeenCalledWith({
      changes: {
        from: 12,
        to: 12,
        insert: expectedInsert,
      },
      selection: { anchor: 12 + expectedInsert.length },
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

  it('preserves a source-linked range jump when opening a sheet embed', () => {
    const link = document.createElement('span');
    link.className = 'cm-lp-link';
    link.dataset.url = '../Docs/budget.sheet#range=B2%3AD8';
    document.body.append(link);
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: link });

    expect(handleEditorDocumentLinkMouseDown(event, 'Notes/a.md')).toBe(true);
    expect(useEditorStore.getState().pendingSheetJump).toEqual({
      relativePath: 'Docs/budget.sheet',
      range: 'B2:D8',
    });
  });
});
