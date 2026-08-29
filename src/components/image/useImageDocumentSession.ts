import { useCallback, useEffect, useMemo, useRef } from 'react';

import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';

import {
  type DocumentStatus,
  type RemoteCandidate,
  useDocumentSessionController,
} from '../../lib/documentSessionController';
import { tauriCommands } from '../../lib/tauri';
import { createVaultClient } from '../../lib/vaultClient';
import type { ImageOverlayDocument, PermanentImageEdits } from '../../types/image';
import type { VaultMeta } from '../../types/vault';

import { createEmptyEdits, type Dimensions, EMPTY_SIZE, isPermanentDirty } from './ImageViewUtils';

function getImageOutputFolder(relativePath: string | null) {
  if (!relativePath) return 'Pictures';
  const normalized = relativePath.replace(/\\/g, '/');
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex < 0) return '';
  return normalized.slice(0, slashIndex);
}

function getUniqueImageOutputFileName(
  files: Array<{ relativePath: string }>,
  targetFolder: string,
  suggestedName: string,
) {
  const prefix = targetFolder ? `${targetFolder}/` : '';
  const existingPaths = new Set(files.map((file) => file.relativePath));
  if (!existingPaths.has(`${prefix}${suggestedName}`)) return suggestedName;

  const dotIndex = suggestedName.lastIndexOf('.');
  const stem = dotIndex > 0 ? suggestedName.slice(0, dotIndex) : suggestedName;
  const extension = dotIndex > 0 ? suggestedName.slice(dotIndex) : '';
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!existingPaths.has(`${prefix}${candidate}`)) return candidate;
  }
  return `${stem}-${Date.now()}${extension}`;
}

interface UseImageDocumentSessionOptions {
  vault: VaultMeta | null;
  relativePath: string | null;
  refreshFileTree: () => Promise<void>;
  openTab: (
    relativePath: string,
    title: string,
    type?: 'note' | 'image' | 'pdf' | 'canvas' | 'kanban' | 'graph' | 'settings',
  ) => void;
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
  renderCanvasToElement: (
    canvas: HTMLCanvasElement,
    target: HTMLCanvasElement,
    display: Dimensions,
  ) => void;
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
  const vaultClient = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  // Additive overlays are stored as local filesystem sidecars. Hosted vaults can
  // still persist baked raster edits through their asset upload capability.
  const supportsImageEditing = useMemo(
    () => vaultClient?.capabilities.nativeFilesystem ?? false,
    [vaultClient],
  );
  const hostedAssetImporter = vaultClient?.runtime.externalAssetImport ?? null;
  const vaultPath = vault?.path ?? null;
  const overlayFallbackDimensionsRef = useRef<Dimensions>(EMPTY_SIZE);
  overlayFallbackDimensionsRef.current =
    dimensions ??
    (overlayDoc ? { width: overlayDoc.baseWidth, height: overlayDoc.baseHeight } : EMPTY_SIZE);
  const permanentDirty = useMemo(() => isPermanentDirty(permanentEdits), [permanentEdits]);

  const serializeOverlay = useCallback((doc: ImageOverlayDocument) => JSON.stringify(doc), []);
  const parseOverlay = useCallback(
    (content: string) => JSON.parse(content) as ImageOverlayDocument,
    [],
  );
  const applyOverlayDocument = useCallback(
    (candidate: RemoteCandidate<ImageOverlayDocument>) => {
      setOverlayDoc(candidate.document);
      setPersistedOverlaySignature(candidate.content);
      setOverlayLoaded(true);
    },
    [setOverlayDoc, setOverlayLoaded, setPersistedOverlaySignature],
  );
  const readOverlayDocument = useCallback(
    async (fallbackDimensions?: Dimensions): Promise<{ content: string; version: string }> => {
      const dimensionsForFallback = fallbackDimensions ?? overlayFallbackDimensionsRef.current;
      if (!vaultPath || !relativePath) {
        const fallback = createEmptyOverlayDocument(dimensionsForFallback);
        const content = JSON.stringify(fallback);
        return { content, version: content };
      }
      const overlayContent = await tauriCommands.readImageOverlay(vaultPath, relativePath);
      if (overlayContent) return { content: overlayContent, version: overlayContent };
      const fallback = createEmptyOverlayDocument(dimensionsForFallback);
      const content = JSON.stringify(fallback);
      return { content, version: content };
    },
    [createEmptyOverlayDocument, relativePath, vaultPath],
  );

  const { controller: overlayController, snapshot: overlaySnapshot } =
    useDocumentSessionController<ImageOverlayDocument>({
      serialize: serializeOverlay,
      deserialize: parseOverlay,
      applyDocument: applyOverlayDocument,
      read: async () => {
        if (!supportsImageEditing || !vaultPath || !relativePath) return null;
        return readOverlayDocument();
      },
      write: async ({ content, expectedVersion }) => {
        if (!supportsImageEditing || !vaultPath || !relativePath)
          return { version: expectedVersion ?? content };
        const parsed = parseOverlay(content);
        if (parsed.items.length === 0) {
          await tauriCommands.deleteImageOverlay(vaultPath, relativePath);
          const emptyContent = JSON.stringify(parsed);
          setPersistedOverlaySignature('');
          return { version: emptyContent, mergedContent: emptyContent };
        }
        const toPersist = JSON.stringify({ ...parsed, updatedAt: Date.now() });
        await tauriCommands.writeImageOverlay(vaultPath, relativePath, toPersist);
        setPersistedOverlaySignature(toPersist);
        return { version: toPersist, mergedContent: toPersist };
      },
      autosaveDebounceMs: 450,
    });

  const overlayDirty = overlayLoaded && overlaySnapshot.dirty;
  const overlayStatus: DocumentStatus = overlaySnapshot.status;
  const loadRemoteOverlay = useCallback(() => {
    if (overlaySnapshot.conflicted) overlayController.resolveConflict('load-remote');
    else overlayController.applyRemoteNow();
  }, [overlayController, overlaySnapshot.conflicted]);
  const keepLocalOverlay = useCallback(() => {
    if (overlaySnapshot.conflicted) overlayController.resolveConflict('keep-local');
    else overlayController.discardRemoteCandidate();
  }, [overlayController, overlaySnapshot.conflicted]);

  useEffect(() => {
    if (!vault || !relativePath || !vaultClient) {
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

    vaultClient
      .readAssetDataUrl(relativePath)
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
        // Hosted vaults cannot persist overlay sidecars; start from an empty overlay.
        if (!supportsImageEditing) {
          setOverlayDoc(createEmptyOverlayDocument(loaded?.decodedDimensions ?? EMPTY_SIZE));
          setPersistedOverlaySignature('');
          setOverlayLoaded(true);
          return;
        }
        try {
          const loadedOverlay = await readOverlayDocument(loaded?.decodedDimensions ?? EMPTY_SIZE);
          if (cancelled) return;
          overlayController.load(loadedOverlay.content, loadedOverlay.version, 'local');
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
    readOverlayDocument,
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
    supportsImageEditing,
    overlayController,
    vaultClient,
    vault?.path,
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

    setOverlayDoc((current) =>
      current
        ? {
            ...current,
            baseWidth: dimensions.width,
            baseHeight: dimensions.height,
            updatedAt: Date.now(),
          }
        : createEmptyOverlayDocument(dimensions),
    );
  }, [createEmptyOverlayDocument, dimensions, overlayDoc, setOverlayDoc]);

  useEffect(() => {
    if (!relativePath) return;
    if (overlayDirty || permanentDirty) markDirty(relativePath);
    else markSaved(relativePath, `image:${overlaySnapshot.loadedVersion ?? ''}`);
  }, [
    markDirty,
    markSaved,
    overlayDirty,
    permanentDirty,
    relativePath,
    overlaySnapshot.loadedVersion,
  ]);

  useEffect(() => {
    if (!overlayLoaded || !overlayDoc || !supportsImageEditing) return;
    overlayController.markLocalChange(overlayDoc);
  }, [overlayController, overlayDoc, overlayLoaded, supportsImageEditing]);

  useEffect(() => {
    if (!vaultPath || !relativePath || !supportsImageEditing) return;
    let unlisten: (() => void) | undefined;
    listen<{ path: string }>('vault:file-modified', async (event) => {
      if (event.payload?.path !== relativePath) return;
      if (Date.now() - overlayController.getSnapshot().lastLocalWriteStartedAt < 2000) return;
      await overlayController.handleExternalMutation('local');
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, [overlayController, relativePath, supportsImageEditing, vaultPath]);

  useEffect(() => {
    if (!overlaySnapshot.conflicted) return;
    toast.error(
      'Image annotations changed elsewhere. Review the pending changes before editing further.',
    );
  }, [overlaySnapshot.conflicted]);

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

  const saveImageOutput = useCallback(
    async (overwrite: boolean) => {
      if (!vault || !relativePath || !image || !saveIntent) return;
      if (!supportsImageEditing && !hostedAssetImporter) {
        toast.error('Saving edited images is not supported for this vault.');
        return;
      }
      if (!supportsImageEditing && overwrite) {
        toast.error('Overwriting hosted images is not yet supported. Save as a new file instead.');
        return;
      }

      const renderCanvas =
        saveIntent === 'flatten'
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
        : saveIntent === 'permanent'
          ? getOutputMime(relativePath)
          : 'image/png';
      const dataUrl = renderCanvas.toDataURL(
        targetMime,
        targetMime === 'image/jpeg' ? 0.92 : undefined,
      );

      try {
        setSaving(true);
        const savedRelativePath = supportsImageEditing
          ? await tauriCommands.saveGeneratedImage(
              vault.path,
              relativePath,
              dataUrl,
              overwrite,
              overwrite ? undefined : getOutputFileName(relativePath, targetMime),
            )
          : await (async () => {
              const targetFolder = getImageOutputFolder(relativePath);
              const suggestedName = getUniqueImageOutputFileName(
                await vaultClient!.listFiles(),
                targetFolder,
                getOutputFileName(relativePath, targetMime),
              );
              return hostedAssetImporter!.importData(dataUrl, suggestedName, targetFolder);
            })();

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
          const refreshedDataUrl = await vaultClient!.readAssetDataUrl(savedRelativePath);
          const refreshedImage = await loadImage(refreshedDataUrl);
          setSrc(refreshedDataUrl);
          setImage(refreshedImage);
          setDimensions({
            width: refreshedImage.naturalWidth,
            height: refreshedImage.naturalHeight,
          });
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
    },
    [
      buildPermanentCanvas,
      createEmptyOverlayDocument,
      drawOverlayToCanvas,
      getBaseName,
      getOutputFileName,
      getOutputMime,
      hostedAssetImporter,
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
      supportsImageEditing,
      vault,
      vaultClient,
    ],
  );

  return {
    overlayDirty,
    overlayStatus,
    permanentDirty,
    saveImageOutput,
    loadRemoteOverlay,
    keepLocalOverlay,
  };
}
