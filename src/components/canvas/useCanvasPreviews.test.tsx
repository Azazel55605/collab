import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node as FlowNode } from '@xyflow/react';

import type { CanvasNodeData } from './CanvasNodeTypes';
import { useCanvasPreviews } from './useCanvasPreviews';

const openUrlMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: openUrlMock,
}));

vi.mock('../../lib/webPreviewCache', () => ({
  normalizeWebPreviewUrl: (url: string) => url.startsWith('http') ? url : `https://${url}`,
  prefetchWebPreviews: vi.fn(),
  requestWebPreview: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    readNoteAssetDataUrl: vi.fn(),
    readNote: vi.fn(),
  },
}));

describe('useCanvasPreviews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resets web node preview fields when the url changes', () => {
    let nodes: FlowNode<CanvasNodeData>[] = [{
      id: 'web-1',
      type: 'webCard',
      position: { x: 0, y: 0 },
      data: {
        title: 'Old title',
        subtitle: 'Old subtitle',
        url: 'https://old.example',
        excerpt: 'Old excerpt',
        imageSrc: 'old.png',
        faviconSrc: 'old.ico',
        hasRichPreview: true,
        previewError: 'bad',
        previewLoading: true,
        previewLoaded: true,
      },
    }];

    const setNodes = vi.fn((updater: React.SetStateAction<FlowNode<CanvasNodeData>[]>) => {
      nodes = typeof updater === 'function' ? updater(nodes) : updater;
    });

    const { result } = renderHook(() => useCanvasPreviews({
      vault: null,
      nodes,
      setNodes,
      isMountedRef: { current: true },
      fromFlowNode: (node) => ({
        id: node.id,
        type: 'web',
        url: node.data.url ?? '',
        displayModeOverride: null,
        position: node.position,
        width: 360,
        height: 240,
      }),
      renderPdfPreview: vi.fn(),
      openRelativePath: vi.fn(),
      canvasWebCardDefaultMode: 'preview',
      canvasWebCardAutoLoad: false,
      webPreviewsEnabled: false,
      hoverWebLinkPreviewsEnabled: false,
      backgroundWebPreviewPrefetchEnabled: false,
    }));

    result.current.updateWebUrl('web-1', 'example.com/docs');

    expect(setNodes).toHaveBeenCalled();
    expect(nodes[0].data).toMatchObject({
      url: 'example.com/docs',
      title: '',
      subtitle: '',
      excerpt: '',
      imageSrc: null,
      faviconSrc: null,
      hasRichPreview: false,
      previewError: null,
      previewLoading: false,
      previewLoaded: false,
      embedAvailable: undefined,
    });
  });

  it('opens normalized external urls', async () => {
    const { result } = renderHook(() => useCanvasPreviews({
      vault: null,
      nodes: [],
      setNodes: vi.fn(),
      isMountedRef: { current: true },
      fromFlowNode: vi.fn(),
      renderPdfPreview: vi.fn(),
      openRelativePath: vi.fn(),
      canvasWebCardDefaultMode: 'preview',
      canvasWebCardAutoLoad: false,
      webPreviewsEnabled: false,
      hoverWebLinkPreviewsEnabled: false,
      backgroundWebPreviewPrefetchEnabled: false,
    }));

    result.current.openExternalUrl('example.com');

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com');
  });
});
