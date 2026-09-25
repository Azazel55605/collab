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
import { onReplicaMutated, replicaMutationAffectsPath } from '../../lib/vaultReplica';
import { migrateImageAnnotations } from '../../lib/viewAnnotations';
import type { ImageCropRect, PermanentImageEdits } from '../../types/image';
import type { InkAnnotationDocument } from '../../types/ink';
import type { VaultMeta } from '../../types/vault';
import { vaultCan } from '../../types/vault';

import { createEmptyEdits, type Dimensions, EMPTY_SIZE, isPermanentDirty } from './ImageViewUtils';

function outputFolder(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? '' : normalized.slice(0, slash);
}

function uniqueOutputName(
  files: Array<{ relativePath: string }>,
  folder: string,
  suggestedName: string,
) {
  const prefix = folder ? `${folder}/` : '';
  const existing = new Set(files.map((file) => file.relativePath));
  if (!existing.has(`${prefix}${suggestedName}`)) return suggestedName;
  const dot = suggestedName.lastIndexOf('.');
  const stem = dot > 0 ? suggestedName.slice(0, dot) : suggestedName;
  const extension = dot > 0 ? suggestedName.slice(dot) : '';
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!existing.has(`${prefix}${candidate}`)) return candidate;
  }
  return `${stem}-${Date.now()}${extension}`;
}

interface Options {
  vault: VaultMeta | null;
  relativePath: string | null;
  refreshFileTree: () => Promise<void>;
  openTab: (relativePath: string, title: string, type?: 'image') => void;
  markDirty: (path: string) => void;
  markSaved: (path: string, hash: string) => void;
  mode: 'view' | 'additive' | 'permanent';
  image: HTMLImageElement | null;
  dimensions: Dimensions | null;
  annotationDoc: InkAnnotationDocument | null;
  annotationsLoaded: boolean;
  permanentEdits: PermanentImageEdits;
  cropMode: boolean;
  permanentDisplayDimensions: Dimensions;
  saveIntent: 'permanent' | 'flatten' | null;
  previewCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  loadImage: (dataUrl: string) => Promise<HTMLImageElement>;
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
  drawAnnotationsToCanvas: (
    ctx: CanvasRenderingContext2D,
    annotations: InkAnnotationDocument,
    dimensions: Dimensions,
  ) => Promise<void>;
  getOutputMime: (path: string | null) => 'image/png' | 'image/jpeg' | 'image/webp';
  getOutputFileName: (path: string | null, mime: string) => string;
  getBaseName: (path: string | null) => string;
  setSrc: React.Dispatch<React.SetStateAction<string | null>>;
  setImage: React.Dispatch<React.SetStateAction<HTMLImageElement | null>>;
  setDimensions: React.Dispatch<React.SetStateAction<Dimensions | null>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setAnnotationDoc: React.Dispatch<React.SetStateAction<InkAnnotationDocument | null>>;
  setAnnotationsLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  setPermanentEdits: React.Dispatch<React.SetStateAction<PermanentImageEdits>>;
  setCropMode: React.Dispatch<React.SetStateAction<boolean>>;
  setCropDraft: React.Dispatch<React.SetStateAction<ImageCropRect | null>>;
  setZoomPercent: React.Dispatch<React.SetStateAction<number>>;
  setSaveIntent: React.Dispatch<React.SetStateAction<'permanent' | 'flatten' | null>>;
  setSaving: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useImageDocumentSession(options: Options) {
  const {
    vault,
    relativePath,
    refreshFileTree,
    openTab,
    markDirty,
    markSaved,
    mode,
    image,
    dimensions,
    annotationDoc,
    annotationsLoaded,
    permanentEdits,
    cropMode,
    permanentDisplayDimensions,
    saveIntent,
    previewCanvasRef,
    loadImage,
    buildPermanentCanvas,
    renderCanvasToElement,
    drawAnnotationsToCanvas,
    getOutputMime,
    getOutputFileName,
    getBaseName,
    setSrc,
    setImage,
    setDimensions,
    setLoading,
    setError,
    setAnnotationDoc,
    setAnnotationsLoaded,
    setPermanentEdits,
    setCropMode,
    setCropDraft,
    setZoomPercent,
    setSaveIntent,
    setSaving,
  } = options;
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  const canAnnotate = !vault || vault.kind !== 'hosted' || vaultCan(vault, 'view.annotate');
  const importer = client?.runtime.externalAssetImport ?? null;
  const fallbackDimensions = useRef(EMPTY_SIZE);
  fallbackDimensions.current = dimensions ?? EMPTY_SIZE;
  const permanentDirty = useMemo(() => isPermanentDirty(permanentEdits), [permanentEdits]);

  const serialize = useCallback((document: InkAnnotationDocument) => JSON.stringify(document), []);
  const deserialize = useCallback(
    (content: string) => {
      const size = fallbackDimensions.current;
      return migrateImageAnnotations(
        JSON.parse(content),
        relativePath ?? '',
        size.width,
        size.height,
      ).document;
    },
    [relativePath],
  );
  const apply = useCallback(
    (candidate: RemoteCandidate<InkAnnotationDocument>) => {
      setAnnotationDoc(candidate.document);
      setAnnotationsLoaded(true);
    },
    [setAnnotationDoc, setAnnotationsLoaded],
  );
  const read = useCallback(
    async (size = fallbackDimensions.current) => {
      if (!client || !relativePath) return null;
      const response = await client.readViewAnnotations(relativePath);
      const migration = migrateImageAnnotations(
        response.state,
        relativePath,
        size.width,
        size.height,
      );
      migration.warnings.forEach((warning) => toast.warning(warning));
      const content = serialize(migration.document);
      return { content, version: response.version === null ? content : String(response.version) };
    },
    [client, relativePath, serialize],
  );

  const { controller, snapshot } = useDocumentSessionController<InkAnnotationDocument>({
    serialize,
    deserialize,
    applyDocument: apply,
    read: () => read(),
    write: async ({ content, expectedVersion }) => {
      if (!client || !relativePath) return { version: expectedVersion ?? content };
      const result = await client.writeViewAnnotations(
        relativePath,
        deserialize(content),
        expectedVersion && /^\d+$/.test(expectedVersion) ? Number(expectedVersion) : null,
      );
      const mergedContent = serialize(result.state as InkAnnotationDocument);
      return {
        version: result.version === null ? mergedContent : String(result.version),
        mergedContent,
        offlineQueued: result.offlineQueued,
      };
    },
    autosaveDebounceMs: 450,
  });

  useEffect(() => {
    if (!vault || !relativePath || !client) {
      setSrc(null);
      setImage(null);
      setAnnotationDoc(null);
      setDimensions(null);
      setError('No image selected');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAnnotationsLoaded(false);
    setPermanentEdits(createEmptyEdits());
    setCropMode(false);
    setCropDraft(null);
    setZoomPercent(100);
    client
      .readAssetDataUrl(relativePath)
      .then(async (dataUrl) => {
        const decoded = await loadImage(dataUrl);
        if (cancelled) return null;
        const size = { width: decoded.naturalWidth, height: decoded.naturalHeight };
        fallbackDimensions.current = size;
        setSrc(dataUrl);
        setImage(decoded);
        setDimensions(size);
        return size;
      })
      .then(async (size) => {
        if (!size || cancelled) return;
        const loaded = await read(size);
        if (!loaded || cancelled) return;
        controller.load(loaded.content, loaded.version, vault.kind === 'hosted' ? 'rest' : 'local');
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    client,
    controller,
    loadImage,
    read,
    relativePath,
    setAnnotationDoc,
    setAnnotationsLoaded,
    setCropDraft,
    setCropMode,
    setDimensions,
    setError,
    setImage,
    setLoading,
    setPermanentEdits,
    setSrc,
    setZoomPercent,
    vault,
  ]);

  useEffect(() => {
    if (annotationsLoaded && annotationDoc && canAnnotate)
      controller.markLocalChange(annotationDoc);
  }, [annotationDoc, annotationsLoaded, canAnnotate, controller]);

  useEffect(() => {
    if (!relativePath) return;
    if (snapshot.dirty || permanentDirty) markDirty(relativePath);
    else markSaved(relativePath, `image:${snapshot.loadedVersion ?? ''}`);
  }, [markDirty, markSaved, permanentDirty, relativePath, snapshot.dirty, snapshot.loadedVersion]);

  useEffect(() => {
    if (!vault || !relativePath || vault.kind === 'hosted') return;
    let unlisten: (() => void) | undefined;
    listen<{ path: string }>('vault:file-modified', async (event) => {
      if (event.payload?.path !== relativePath) return;
      if (Date.now() - controller.getSnapshot().lastLocalWriteStartedAt < 2000) return;
      await controller.handleExternalMutation('local');
    }).then((cleanup) => (unlisten = cleanup));
    return () => unlisten?.();
  }, [controller, relativePath, vault]);

  useEffect(() => {
    if (!vault || vault.kind !== 'hosted' || !relativePath) return;
    return onReplicaMutated(
      async (event) => {
        if (replicaMutationAffectsPath(event, relativePath))
          await controller.handleExternalMutation('cache');
      },
      { kinds: ['manifest'] },
    );
  }, [controller, relativePath, vault]);

  useEffect(() => {
    if (!vault || vault.kind !== 'hosted' || !relativePath || !annotationsLoaded) return;
    const check = () => void controller.handleExternalMutation('rest');
    const interval = window.setInterval(check, 2_000);
    window.addEventListener('focus', check);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', check);
    };
  }, [annotationsLoaded, controller, relativePath, vault]);

  useEffect(() => {
    if (snapshot.conflicted)
      toast.error('Image annotations changed elsewhere. Review the pending changes.');
  }, [snapshot.conflicted]);

  useEffect(() => {
    if (mode !== 'permanent' || !image || !previewCanvasRef.current) return;
    const rendered = buildPermanentCanvas(image, permanentEdits, {
      ignoreCrop: cropMode,
      ignoreResize: cropMode,
    }).canvas;
    renderCanvasToElement(rendered, previewCanvasRef.current, permanentDisplayDimensions);
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
      if (!vault || !relativePath || !image || !saveIntent || !client) return;
      if (!client.capabilities.nativeFilesystem && !importer) {
        toast.error('Saving edited images is not supported for this vault.');
        return;
      }
      if (!client.capabilities.nativeFilesystem && overwrite) {
        toast.error('Hosted images can only be saved as a new file.');
        return;
      }
      if (saveIntent === 'flatten' && overwrite) {
        toast.error(
          'Baked annotations are exported as a copy so the editable sidecar stays intact.',
        );
        return;
      }
      const canvas =
        saveIntent === 'permanent'
          ? buildPermanentCanvas(image, permanentEdits).canvas
          : (() => {
              const target = document.createElement('canvas');
              target.width = image.naturalWidth;
              target.height = image.naturalHeight;
              target.getContext('2d')?.drawImage(image, 0, 0);
              return target;
            })();
      if (saveIntent === 'flatten' && annotationDoc) {
        const context = canvas.getContext('2d');
        if (context)
          await drawAnnotationsToCanvas(context, annotationDoc, {
            width: image.naturalWidth,
            height: image.naturalHeight,
          });
      }
      const mime = overwrite
        ? getOutputMime(relativePath)
        : saveIntent === 'flatten'
          ? 'image/png'
          : getOutputMime(relativePath);
      const dataUrl = canvas.toDataURL(mime, mime === 'image/jpeg' ? 0.92 : undefined);
      try {
        setSaving(true);
        const savedPath = client.capabilities.nativeFilesystem
          ? await tauriCommands.saveGeneratedImage(
              vault.path,
              relativePath,
              dataUrl,
              overwrite,
              overwrite ? undefined : getOutputFileName(relativePath, mime),
            )
          : await (async () => {
              const folder = outputFolder(relativePath);
              const name = uniqueOutputName(
                await client.listFiles(),
                folder,
                getOutputFileName(relativePath, mime),
              );
              return importer!.importData(dataUrl, name, folder);
            })();
        if (saveIntent === 'permanent') {
          setPermanentEdits(createEmptyEdits());
          setCropMode(false);
          setCropDraft(null);
        }
        await refreshFileTree();
        if (overwrite) {
          const refreshedUrl = await client.readAssetDataUrl(savedPath);
          const refreshed = await loadImage(refreshedUrl);
          setSrc(refreshedUrl);
          setImage(refreshed);
          setDimensions({ width: refreshed.naturalWidth, height: refreshed.naturalHeight });
        } else openTab(savedPath, getBaseName(savedPath), 'image');
        toast.success(overwrite ? 'Image updated' : 'Edited image saved as a new file');
        setSaveIntent(null);
      } catch (reason) {
        toast.error(`Failed to save image: ${reason}`);
      } finally {
        setSaving(false);
      }
    },
    [
      annotationDoc,
      buildPermanentCanvas,
      client,
      drawAnnotationsToCanvas,
      getBaseName,
      getOutputFileName,
      getOutputMime,
      image,
      importer,
      loadImage,
      openTab,
      permanentEdits,
      refreshFileTree,
      relativePath,
      saveIntent,
      setCropDraft,
      setCropMode,
      setDimensions,
      setImage,
      setPermanentEdits,
      setSaveIntent,
      setSaving,
      setSrc,
      vault,
    ],
  );

  const loadRemoteAnnotations = useCallback(() => {
    if (snapshot.conflicted) controller.resolveConflict('load-remote');
    else controller.applyRemoteNow();
  }, [controller, snapshot.conflicted]);
  const keepLocalAnnotations = useCallback(() => {
    if (snapshot.conflicted) controller.resolveConflict('keep-local');
    else controller.discardRemoteCandidate();
  }, [controller, snapshot.conflicted]);

  return {
    annotationStatus: snapshot.status as DocumentStatus,
    canAnnotate,
    permanentDirty,
    saveImageOutput,
    loadRemoteAnnotations,
    keepLocalAnnotations,
  };
}
