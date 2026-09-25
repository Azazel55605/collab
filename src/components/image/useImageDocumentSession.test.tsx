import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAnchoredAnnotationDocument } from '../../lib/viewAnnotations';

import { useImageDocumentSession } from './useImageDocumentSession';

const mocks = vi.hoisted(() => ({
  readAssetDataUrl: vi.fn(),
  readViewAnnotations: vi.fn(),
  writeViewAnnotations: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('../../lib/vaultClient', () => ({
  createVaultClient: () => ({
    capabilities: { nativeFilesystem: true },
    runtime: {},
    readAssetDataUrl: mocks.readAssetDataUrl,
    readViewAnnotations: mocks.readViewAnnotations,
    writeViewAnnotations: mocks.writeViewAnnotations,
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));

const vault = {
  id: 'vault-1',
  path: '/vault',
  name: 'Vault',
  isEncrypted: false,
  lastOpened: 1,
};

function options() {
  return {
    vault,
    relativePath: 'Pictures/demo.png',
    refreshFileTree: vi.fn(async () => {}),
    openTab: vi.fn(),
    markDirty: vi.fn(),
    markSaved: vi.fn(),
    mode: 'additive' as const,
    image: null,
    dimensions: null,
    annotationDoc: null,
    annotationsLoaded: false,
    permanentEdits: {
      rotation: 0 as const,
      crop: null,
      resizeWidth: null,
      resizeHeight: null,
      lockAspectRatio: true,
    },
    cropMode: false,
    permanentDisplayDimensions: { width: 100, height: 100 },
    saveIntent: null,
    previewCanvasRef: { current: null },
    loadImage: vi.fn(async () => ({ naturalWidth: 640, naturalHeight: 480 }) as HTMLImageElement),
    buildPermanentCanvas: vi.fn(),
    renderCanvasToElement: vi.fn(),
    drawAnnotationsToCanvas: vi.fn(),
    getOutputMime: vi.fn(() => 'image/png' as const),
    getOutputFileName: vi.fn(() => 'demo-edited.png'),
    getBaseName: vi.fn(() => 'demo-edited'),
    setSrc: vi.fn(),
    setImage: vi.fn(),
    setDimensions: vi.fn(),
    setLoading: vi.fn(),
    setError: vi.fn(),
    setAnnotationDoc: vi.fn(),
    setAnnotationsLoaded: vi.fn(),
    setPermanentEdits: vi.fn(),
    setCropMode: vi.fn(),
    setCropDraft: vi.fn(),
    setZoomPercent: vi.fn(),
    setSaveIntent: vi.fn(),
    setSaving: vi.fn(),
  };
}

describe('useImageDocumentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listen.mockResolvedValue(vi.fn());
    mocks.readAssetDataUrl.mockResolvedValue('data:image/png;base64,abc');
  });

  it('loads a shared image annotation document through VaultClient', async () => {
    const document = createAnchoredAnnotationDocument('Pictures/demo.png');
    mocks.readViewAnnotations.mockResolvedValue({ state: document, version: null });
    const input = options();

    renderHook(() => useImageDocumentSession(input));

    await waitFor(() => expect(input.setAnnotationsLoaded).toHaveBeenCalledWith(true));
    expect(mocks.readViewAnnotations).toHaveBeenCalledWith('Pictures/demo.png');
    expect(input.setDimensions).toHaveBeenCalledWith({ width: 640, height: 480 });
    expect(input.setAnnotationDoc).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'collab-annotations' }),
    );
  });

  it('migrates a v1 image overlay before exposing it', async () => {
    mocks.readViewAnnotations.mockResolvedValue({
      state: {
        version: 1,
        baseWidth: 640,
        baseHeight: 480,
        updatedAt: 1,
        items: [
          {
            id: 'legacy-pen',
            type: 'pen',
            points: [
              { x: 0.1, y: 0.2 },
              { x: 0.3, y: 0.4 },
            ],
            color: '#fff',
            strokeWidth: 4,
          },
        ],
      },
      version: null,
    });
    const input = options();

    renderHook(() => useImageDocumentSession(input));

    await waitFor(() => expect(input.setAnnotationDoc).toHaveBeenCalled());
    const calls = input.setAnnotationDoc.mock.calls;
    const document = calls[calls.length - 1]?.[0];
    expect(document.surfaces.image.scene.objects['legacy-pen'].type).toBe('stroke');
  });

  it('publishes local annotation changes through VaultClient', async () => {
    vi.useFakeTimers();
    mocks.readAssetDataUrl.mockImplementation(() => new Promise(() => {}));
    mocks.writeViewAnnotations.mockImplementation(async (_path, state) => ({
      state,
      version: null,
    }));
    const document = createAnchoredAnnotationDocument('Pictures/demo.png');
    const input = {
      ...options(),
      annotationDoc: document,
      annotationsLoaded: true,
    };

    renderHook(() => useImageDocumentSession(input));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(mocks.writeViewAnnotations).toHaveBeenCalledWith(
      'Pictures/demo.png',
      expect.objectContaining({
        kind: 'collab-annotations',
        surfaces: expect.objectContaining({ image: expect.any(Object) }),
      }),
      null,
    );
    vi.useRealTimers();
  });
});
