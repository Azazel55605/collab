import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  readNoteAssetDataUrl: vi.fn(),
  readImageOverlay: vi.fn(),
  writeImageOverlay: vi.fn(),
  deleteImageOverlay: vi.fn(),
  saveGeneratedImage: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  tauriCommands: tauriMocks,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { useImageDocumentSession } from './useImageDocumentSession';

describe('useImageDocumentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads image data and additive overlay state', async () => {
    tauriMocks.readNoteAssetDataUrl.mockResolvedValue('data:image/png;base64,abc');
    tauriMocks.readImageOverlay.mockResolvedValue(null);

    const setSrc = vi.fn();
    const setImage = vi.fn();
    const setDimensions = vi.fn();
    const setLoading = vi.fn();
    const setError = vi.fn();
    const setOverlayDoc = vi.fn();
    const setOverlayLoaded = vi.fn();
    const setPersistedOverlaySignature = vi.fn();

    renderHook(() => useImageDocumentSession({
      vault: { id: 'vault-1', path: '/vault', name: 'Vault', isEncrypted: false, lastOpened: 1 },
      relativePath: 'Pictures/demo.png',
      refreshFileTree: vi.fn(async () => {}),
      openTab: vi.fn(),
      markDirty: vi.fn(),
      markSaved: vi.fn(),
      mode: 'view',
      image: null,
      dimensions: null,
      overlayDoc: null,
      overlayLoaded: false,
      persistedOverlaySignature: '',
      permanentEdits: { rotation: 0, crop: null, resizeWidth: null, resizeHeight: null, lockAspectRatio: true },
      cropMode: false,
      permanentDisplayDimensions: { width: 100, height: 100 },
      saveIntent: null,
      previewCanvasRef: { current: null },
      loadImage: vi.fn(async () => ({ naturalWidth: 640, naturalHeight: 480 } as HTMLImageElement)),
      createEmptyOverlayDocument: vi.fn((dimensions) => ({ version: 1 as const, baseWidth: dimensions.width, baseHeight: dimensions.height, items: [], updatedAt: 1 })),
      buildPermanentCanvas: vi.fn(),
      renderCanvasToElement: vi.fn(),
      drawOverlayToCanvas: vi.fn(),
      getOutputMime: vi.fn(),
      getOutputFileName: vi.fn(),
      getBaseName: vi.fn(),
      setSrc,
      setImage,
      setDimensions,
      setLoading,
      setError,
      setOverlayDoc,
      setOverlayLoaded,
      setPersistedOverlaySignature,
      setSelectedItemId: vi.fn(),
      setDraftArrow: vi.fn(),
      setDraftStroke: vi.fn(),
      setPermanentEdits: vi.fn(),
      setCropMode: vi.fn(),
      setCropDraft: vi.fn(),
      setCropDragStart: vi.fn(),
      setCropInteraction: vi.fn(),
      setZoomPercent: vi.fn(),
      setEditingTextId: vi.fn(),
      setTextInteraction: vi.fn(),
      setArrowInteraction: vi.fn(),
      setSaveIntent: vi.fn(),
      setSaving: vi.fn(),
    }));

    await waitFor(() => {
      expect(tauriMocks.readNoteAssetDataUrl).toHaveBeenCalledWith('/vault', 'Pictures/demo.png');
      expect(tauriMocks.readImageOverlay).toHaveBeenCalledWith('/vault', 'Pictures/demo.png');
    });

    expect(setSrc).toHaveBeenCalledWith('data:image/png;base64,abc');
    expect(setDimensions).toHaveBeenCalledWith({ width: 640, height: 480 });
    expect(setOverlayDoc).toHaveBeenCalled();
    expect(setOverlayLoaded).toHaveBeenCalledWith(true);
    expect(setPersistedOverlaySignature).toHaveBeenCalledWith('');
  });

  it('persists additive overlays after debounce', async () => {
    vi.useFakeTimers();

    renderHook(() => useImageDocumentSession({
      vault: { id: 'vault-1', path: '/vault', name: 'Vault', isEncrypted: false, lastOpened: 1 },
      relativePath: 'Pictures/demo.png',
      refreshFileTree: vi.fn(async () => {}),
      openTab: vi.fn(),
      markDirty: vi.fn(),
      markSaved: vi.fn(),
      mode: 'additive',
      image: null,
      dimensions: { width: 640, height: 480 },
      overlayDoc: { version: 1, baseWidth: 640, baseHeight: 480, items: [{ id: 'text-1', type: 'text', x: 0, y: 0, width: 0.2, height: 0.1, text: 'Hello', color: '#fff', fontSize: 18 }], updatedAt: 1 },
      overlayLoaded: true,
      persistedOverlaySignature: '',
      permanentEdits: { rotation: 0, crop: null, resizeWidth: null, resizeHeight: null, lockAspectRatio: true },
      cropMode: false,
      permanentDisplayDimensions: { width: 100, height: 100 },
      saveIntent: null,
      previewCanvasRef: { current: null },
      loadImage: vi.fn(),
      createEmptyOverlayDocument: vi.fn(),
      buildPermanentCanvas: vi.fn(),
      renderCanvasToElement: vi.fn(),
      drawOverlayToCanvas: vi.fn(),
      getOutputMime: vi.fn(),
      getOutputFileName: vi.fn(),
      getBaseName: vi.fn(),
      setSrc: vi.fn(),
      setImage: vi.fn(),
      setDimensions: vi.fn(),
      setLoading: vi.fn(),
      setError: vi.fn(),
      setOverlayDoc: vi.fn(),
      setOverlayLoaded: vi.fn(),
      setPersistedOverlaySignature: vi.fn(),
      setSelectedItemId: vi.fn(),
      setDraftArrow: vi.fn(),
      setDraftStroke: vi.fn(),
      setPermanentEdits: vi.fn(),
      setCropMode: vi.fn(),
      setCropDraft: vi.fn(),
      setCropDragStart: vi.fn(),
      setCropInteraction: vi.fn(),
      setZoomPercent: vi.fn(),
      setEditingTextId: vi.fn(),
      setTextInteraction: vi.fn(),
      setArrowInteraction: vi.fn(),
      setSaveIntent: vi.fn(),
      setSaving: vi.fn(),
    }));

    await vi.advanceTimersByTimeAsync(500);

    expect(tauriMocks.writeImageOverlay).toHaveBeenCalledWith(
      '/vault',
      'Pictures/demo.png',
      expect.stringContaining('"text":"Hello"'),
    );
  });
});
