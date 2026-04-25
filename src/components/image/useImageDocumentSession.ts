import { useCallback, useEffect, useMemo } from 'react';
import { toast } from 'sonner';

import { tauriCommands } from '../../lib/tauri';
import type {
  ImageOverlayDocument,
  PermanentImageEdits,
} from '../../types/image';
import type { VaultMeta } from '../../types/vault';
import {
  createEmptyEdits,
  EMPTY_SIZE,
  getOverlaySignature,
  isPermanentDirty,
  type Dimensions,
} from './ImageViewUtils';

interface UseImageDocumentSessionOptions {
  vault: VaultMeta | null;
  relativePath: string | null;
  refreshFileTree: () => Promise<void>;
  openTab: (relativePath: string, title: string, type?: 'note' | 'image' | 'pdf' | 'canvas' | 'kanban' | 'graph' | 'settings') => void;
  markDirty: (path: string) => void;
  markSaved: (path: string, hash: string) => void;
  mode: 'view' | 'additive' | 'permanent';
  image: HTMLImageElement | null;
  dimensions: Dimensions | null;
  overlayDoc: ImageOverlayDocument | null;
  overlayLoaded: boolean;
  persistedOverlaySignature: string;
  permanentEdits: PermanentImageEdits;
  cropMode: boolean;
  permanentDisplayDimensions: Dimensions;
  saveIntent: 'permanent' | 'flatten' | null;
  previewCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  loadImage: (dataUrl: string) => Promise<HTMLImageElement>;
  createEmptyOverlayDocument: (dimensions: Dimensions) => ImageOverlayDocument;
  buildPermanentCanvas: (
    image: HTMLImageElement,
    edits: PermanentImageEdits,
    options?: { ignoreCrop?: boolean; ignoreResize?: boolean },
  ) => { canvas: HTMLCanvasElement; sourceSize: Dimensions };
  renderCanvasToElement: (canvas: HTMLCanvasElement, target: HTMLCanvasElement, display: Dimensions) => void;
  drawOverlayToCanvas: (
    ctx: CanvasRenderingContext2D,
    overlay: ImageOverlayDocument | null,
    dimensions: Dimensions,
  ) => void;
  getOutputMime: (path: string | null) => 'image/png' | 'image/jpeg' | 'image/webp';
  getOutputFileName: (path: string | null, mime: string) => string;
  getBaseName: (path: string | null) => string;
  setSrc: React.Dispatch<React.SetStateAction<string | null>>;
  setImage: React.Dispatch<React.SetStateAction<HTMLImageElement | null>>;
  setDimensions: React.Dispatch<React.SetStateAction<Dimensions | null>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setOverlayDoc: React.Dispatch<React.SetStateAction<ImageOverlayDocument | null>>;
  setOverlayLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  setPersistedOverlaySignature: React.Dispatch<React.SetStateAction<string>>;
  setSelectedItemId: React.Dispatch<React.SetStateAction<string | null>>;
  setDraftArrow: React.Dispatch<React.SetStateAction<any>>;
  setDraftStroke: React.Dispatch<React.SetStateAction<any>>;
  setPermanentEdits: React.Dispatch<React.SetStateAction<PermanentImageEdits>>;
  setCropMode: React.Dispatch<React.SetStateAction<boolean>>;
  setCropDraft: React.Dispatch<React.SetStateAction<any>>;
  setCropDragStart: React.Dispatch<React.SetStateAction<any>>;
  setCropInteraction: React.Dispatch<React.SetStateAction<any>>;
  setZoomPercent: React.Dispatch<React.SetStateAction<number>>;
  setEditingTextId: React.Dispatch<React.SetStateAction<string | null>>;
  setTextInteraction: React.Dispatch<React.SetStateAction<any>>;
  setArrowInteraction: React.Dispatch<React.SetStateAction<any>>;
  setSaveIntent: React.Dispatch<React.SetStateAction<'permanent' | 'flatten' | null>>;
  setSaving: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useImageDocumentSession({
  vault,
  relativePath,
  refreshFileTree,
  openTab,
  markDirty,
  markSaved,
  mode,
  image,
  dimensions,
  overlayDoc,
  overlayLoaded,
  persistedOverlaySignature,
  permanentEdits,
  cropMode,
  permanentDisplayDimensions,
  saveIntent,
  previewCanvasRef,
  loadImage,
  createEmptyOverlayDocument,
  buildPermanentCanvas,
  renderCanvasToElement,
  drawOverlayToCanvas,
  getOutputMime,
  getOutputFileName,
  getBaseName,
  setSrc,
  setImage,
  setDimensions,
  setLoading,
  setError,
  setOverlayDoc,
  setOverlayLoaded,
  setPersistedOverlaySignature,
  setSelectedItemId,
  setDraftArrow,
  setDraftStroke,
  setPermanentEdits,
  setCropMode,
  setCropDraft,
  setCropDragStart,
  setCropInteraction,
  setZoomPercent,
  setEditingTextId,
  setTextInteraction,
  setArrowInteraction,
  setSaveIntent,
  setSaving,
}: UseImageDocumentSessionOptions) {
  const overlaySignature = useMemo(() => getOverlaySignature(overlayDoc), [overlayDoc]);
  const overlayDirty = overlayLoaded && overlaySignature !== persistedOverlaySignature;
  const permanentDirty = useMemo(() => isPermanentDirty(permanentEdits), [permanentEdits]);

  useEffect(() => {
    if (!vault || !relativePath) {
      setSrc(null);
      setImage(null);
      setOverlayDoc(null);
      setDimensions(null);
      setError('No image selected');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setOverlayLoaded(false);
    setSelectedItemId(null);
    setDraftArrow(null);
    setDraftStroke(null);
    setPermanentEdits(createEmptyEdits());
    setCropMode(false);
    setCropDraft(null);
    setCropDragStart(null);
    setCropInteraction(null);
    setZoomPercent(100);
    setEditingTextId(null);
    setTextInteraction(null);
    setArrowInteraction(null);

    tauriCommands.readNoteAssetDataUrl(vault.path, relativePath)
      .then(async (dataUrl) => {
        const decoded = await loadImage(dataUrl);
        if (cancelled) return;
        const decodedDimensions = { width: decoded.naturalWidth, height: decoded.naturalHeight };
        setSrc(dataUrl);
        setImage(decoded);
        setDimensions(decodedDimensions);
        return { decodedDimensions };
      })
      .then(async (loaded) => {
        if (!vault || !relativePath || cancelled) return;
        try {
          const overlayContent = await tauriCommands.readImageOverlay(vault.path, relativePath);
          if (cancelled) return;
          const fallback = createEmptyOverlayDocument(loaded?.decodedDimensions ?? EMPTY_SIZE);

          if (!overlayContent) {
            setOverlayDoc(fallback);
            setPersistedOverlaySignature('');
            setOverlayLoaded(true);
            return;
          }

          const parsed = JSON.parse(overlayContent) as ImageOverlayDocument;
          setOverlayDoc(parsed);
          setPersistedOverlaySignature(JSON.stringify(parsed));
          setOverlayLoaded(true);
        } catch (overlayError) {
          if (!cancelled) {
            setOverlayDoc(createEmptyOverlayDocument(loaded?.decodedDimensions ?? EMPTY_SIZE));
            setPersistedOverlaySignature('');
            setOverlayLoaded(true);
            toast.error(`Failed to load additive annotations: ${overlayError}`);
          }
        }
      })
      .catch((loadError) => {
        if (cancelled) return;
        setSrc(null);
        setImage(null);
        setDimensions(null);
        setOverlayDoc(null);
        setOverlayLoaded(false);
        setError(String(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    createEmptyOverlayDocument,
    loadImage,
    relativePath,
    setArrowInteraction,
    setCropDragStart,
    setCropDraft,
    setCropInteraction,
    setCropMode,
    setDimensions,
    setDraftArrow,
    setDraftStroke,
    setEditingTextId,
    setError,
    setImage,
    setLoading,
    setOverlayDoc,
    setOverlayLoaded,
    setPermanentEdits,
    setPersistedOverlaySignature,
    setSelectedItemId,
    setSrc,
    setTextInteraction,
    setZoomPercent,
    vault,
  ]);

  useEffect(() => {
    if (!dimensions) return;
    if (!overlayDoc) {
      setOverlayDoc(createEmptyOverlayDocument(dimensions));
      return;
    }

    if (overlayDoc.baseWidth === dimensions.width && overlayDoc.baseHeight === dimensions.height) {
      return;
    }

    setOverlayDoc((current) => current ? {
      ...current,
      baseWidth: dimensions.width,
      baseHeight: dimensions.height,
      updatedAt: Date.now(),
    } : createEmptyOverlayDocument(dimensions));
  }, [createEmptyOverlayDocument, dimensions, overlayDoc, setOverlayDoc]);

  useEffect(() => {
    if (!relativePath) return;
    if (overlayDirty || permanentDirty) markDirty(relativePath);
    else markSaved(relativePath, `image:${Date.now()}`);
  }, [markDirty, markSaved, overlayDirty, permanentDirty, relativePath]);

  useEffect(() => {
    if (!vault || !relativePath || !overlayLoaded || !overlayDoc) return;

    const timeout = window.setTimeout(async () => {
      try {
        if (overlayDoc.items.length === 0) {
          await tauriCommands.deleteImageOverlay(vault.path, relativePath);
          setPersistedOverlaySignature('');
        } else {
          const serialized = JSON.stringify({ ...overlayDoc, updatedAt: Date.now() });
          await tauriCommands.writeImageOverlay(vault.path, relativePath, serialized);
          setPersistedOverlaySignature(serialized);
        }
      } catch (saveError) {
        toast.error(`Failed to save additive annotations: ${saveError}`);
      }
    }, 450);

    return () => window.clearTimeout(timeout);
  }, [overlayDoc, overlayLoaded, relativePath, setPersistedOverlaySignature, vault]);

  useEffect(() => {
    if (mode !== 'permanent' || !image || !previewCanvasRef.current) return;
    const target = previewCanvasRef.current;
    const rendered = buildPermanentCanvas(image, permanentEdits, {
      ignoreCrop: cropMode,
      ignoreResize: cropMode,
    }).canvas;
    renderCanvasToElement(rendered, target, permanentDisplayDimensions);
  }, [
    buildPermanentCanvas,
    cropMode,
    image,
    mode,
    permanentDisplayDimensions,
    permanentEdits,
    previewCanvasRef,
    renderCanvasToElement,
  ]);

  const saveImageOutput = useCallback(async (overwrite: boolean) => {
    if (!vault || !relativePath || !image || !saveIntent) return;

    const renderCanvas = saveIntent === 'flatten'
      ? (() => {
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(image, 0, 0);
          if (ctx && overlayDoc) {
            drawOverlayToCanvas(ctx, overlayDoc, {
              width: image.naturalWidth,
              height: image.naturalHeight,
            });
          }
          return canvas;
        })()
      : buildPermanentCanvas(image, permanentEdits).canvas;

    const targetMime = overwrite
      ? getOutputMime(relativePath)
      : (saveIntent === 'permanent' ? getOutputMime(relativePath) : 'image/png');
    const dataUrl = renderCanvas.toDataURL(targetMime, targetMime === 'image/jpeg' ? 0.92 : undefined);

    try {
      setSaving(true);
      const savedRelativePath = await tauriCommands.saveGeneratedImage(
        vault.path,
        relativePath,
        dataUrl,
        overwrite,
        overwrite ? undefined : getOutputFileName(relativePath, targetMime),
      );

      if (saveIntent === 'flatten' && overwrite) {
        await tauriCommands.deleteImageOverlay(vault.path, relativePath);
        const emptyDoc = createEmptyOverlayDocument({
          width: image.naturalWidth,
          height: image.naturalHeight,
        });
        setOverlayDoc(emptyDoc);
        setPersistedOverlaySignature('');
        setSelectedItemId(null);
      }

      if (saveIntent === 'permanent') {
        setPermanentEdits(createEmptyEdits());
        setCropMode(false);
        setCropDraft(null);
      }

      await refreshFileTree();

      if (overwrite) {
        const refreshedDataUrl = await tauriCommands.readNoteAssetDataUrl(vault.path, savedRelativePath);
        const refreshedImage = await loadImage(refreshedDataUrl);
        setSrc(refreshedDataUrl);
        setImage(refreshedImage);
        setDimensions({ width: refreshedImage.naturalWidth, height: refreshedImage.naturalHeight });
      } else {
        openTab(savedRelativePath, getBaseName(savedRelativePath), 'image');
      }

      toast.success(overwrite ? 'Image updated' : 'Edited image saved as a new file');
      setSaveIntent(null);
    } catch (saveError) {
      toast.error(`Failed to save image: ${saveError}`);
    } finally {
      setSaving(false);
    }
  }, [
    buildPermanentCanvas,
    createEmptyOverlayDocument,
    drawOverlayToCanvas,
    getBaseName,
    getOutputFileName,
    getOutputMime,
    image,
    loadImage,
    openTab,
    overlayDoc,
    permanentEdits,
    refreshFileTree,
    relativePath,
    saveIntent,
    setCropDraft,
    setCropMode,
    setDimensions,
    setImage,
    setOverlayDoc,
    setPersistedOverlaySignature,
    setPermanentEdits,
    setSaveIntent,
    setSaving,
    setSelectedItemId,
    setSrc,
    vault,
  ]);

  return {
    overlayDirty,
    permanentDirty,
    saveImageOutput,
  };
}
