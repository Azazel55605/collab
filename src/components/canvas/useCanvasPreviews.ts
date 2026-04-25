import { openUrl } from '@tauri-apps/plugin-opener';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Node as FlowNode } from '@xyflow/react';

import { tauriCommands } from '../../lib/tauri';
import { prefetchWebPreviews, requestWebPreview as requestCachedWebPreview } from '../../lib/webPreviewCache';
import type { VaultMeta } from '../../types/vault';
import type { CanvasNode, CanvasWebDisplayMode, WebCanvasNode } from '../../types/canvas';
import type { CanvasWebCardDefaultMode } from '../../store/uiStore';
import type { CanvasNodeData } from './CanvasNodeTypes';
import {
  buildNodePreviewState,
  buildWebPreviewState,
  canPreviewText,
  cleanPreviewText,
  getPreviewKey,
  isImageExtension,
  normalizeWebUrl,
  resolveWebDisplayMode,
  type PreviewState,
} from './CanvasPreviewUtils';

interface UseCanvasPreviewsOptions {
  vault: VaultMeta | null;
  nodes: FlowNode<CanvasNodeData>[];
  setNodes: React.Dispatch<React.SetStateAction<FlowNode<CanvasNodeData>[]>>;
  isMountedRef: React.RefObject<boolean>;
  fromFlowNode: (node: FlowNode<CanvasNodeData>) => CanvasNode;
  renderPdfPreview: (dataUrl: string) => Promise<string>;
  openRelativePath: (path: string) => void;
  canvasWebCardDefaultMode: CanvasWebCardDefaultMode;
  canvasWebCardAutoLoad: boolean;
  webPreviewsEnabled: boolean;
  hoverWebLinkPreviewsEnabled: boolean;
  backgroundWebPreviewPrefetchEnabled: boolean;
}

export function useCanvasPreviews({
  vault,
  nodes,
  setNodes,
  isMountedRef,
  fromFlowNode,
  renderPdfPreview,
  openRelativePath,
  canvasWebCardDefaultMode,
  canvasWebCardAutoLoad,
  webPreviewsEnabled,
  hoverWebLinkPreviewsEnabled,
  backgroundWebPreviewPrefetchEnabled,
}: UseCanvasPreviewsOptions) {
  const loadingPreviewPathsRef = useRef(new Set<string>());
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const [requestedWebPreviewIds, setRequestedWebPreviewIds] = useState<Record<string, boolean>>({});

  const requestWebPreview = useCallback((nodeId: string) => {
    setRequestedWebPreviewIds((prev) => ({ ...prev, [nodeId]: true }));
  }, []);

  const updateWebUrl = useCallback((nodeId: string, url: string) => {
    setRequestedWebPreviewIds((prev) => {
      if (!(nodeId in prev)) return prev;
      const next = { ...prev };
      delete next[nodeId];
      return next;
    });
    setNodes((prev) =>
      prev.map((node) => (
        node.id === nodeId
          ? {
              ...node,
              data: {
                ...node.data,
                url,
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
              },
            }
          : node
      )),
    );
  }, [setNodes]);

  const updateWebDisplayModeOverride = useCallback((nodeId: string, mode: CanvasWebDisplayMode | null) => {
    setNodes((prev) =>
      prev.map((node) => (
        node.id === nodeId
          ? { ...node, data: { ...node.data, displayModeOverride: mode, displayMode: resolveWebDisplayMode(mode, canvasWebCardDefaultMode) } }
          : node
      )),
    );
  }, [canvasWebCardDefaultMode, setNodes]);

  const openExternalUrl = useCallback((url: string) => {
    const normalized = normalizeWebUrl(url);
    if (!normalized) return;
    void openUrl(normalized);
  }, []);

  const hydratePreview = useCallback(async (node: CanvasNode) => {
    if (!vault && node.type !== 'web') return;
    const previewKey = getPreviewKey(node);
    if (loadingPreviewPathsRef.current.has(previewKey)) return;

    loadingPreviewPathsRef.current.add(previewKey);
    setPreviews((prev) => ({
      ...prev,
      [previewKey]: { ...(prev[previewKey] ?? {}), loading: true },
    }));
    if (node.type === 'web') {
      setNodes((prev) =>
        prev.map((flowNode) => {
          if (flowNode.id !== node.id) return flowNode;
          return {
            ...flowNode,
            data: {
              ...flowNode.data,
              ...buildWebPreviewState(node, { ...(previews[previewKey] ?? {}), loading: true, loaded: false }, canvasWebCardDefaultMode, canvasWebCardAutoLoad, webPreviewsEnabled),
              onRequestWebPreview: requestWebPreview,
              onOpenUrl: openExternalUrl,
            },
          };
        }),
      );
    }

    try {
      let nextPreview: PreviewState = {};

      if (node.type === 'web') {
        const normalizedUrl = normalizeWebUrl(node.url);
        if (!normalizedUrl) {
          nextPreview = { previewError: null };
        } else {
          const linkPreview = await requestCachedWebPreview(normalizedUrl);
          nextPreview = {
            linkPreview,
            imageSrc: linkPreview.imageUrl ?? null,
            faviconSrc: linkPreview.faviconUrl ?? null,
          };
        }
      } else if ('relativePath' in node && vault) {
        const path = node.relativePath;
        const extension = path.split('.').pop()?.toLowerCase() ?? '';
        if (node.type === 'file' && isImageExtension(extension)) {
          nextPreview = { imageSrc: await tauriCommands.readNoteAssetDataUrl(vault.path, path) };
        } else if (node.type === 'file' && extension === 'pdf') {
          const pdfDataUrl = await tauriCommands.readNoteAssetDataUrl(vault.path, path);
          nextPreview = { imageSrc: await renderPdfPreview(pdfDataUrl) };
        } else if (node.type === 'note') {
          const { content } = await tauriCommands.readNote(vault.path, path);
          nextPreview = { excerpt: cleanPreviewText(content), markdownContent: content };
        } else if (canPreviewText(extension)) {
          const { content } = await tauriCommands.readNote(vault.path, path);
          nextPreview = { excerpt: cleanPreviewText(content) };
        }
      }

      const resolvedPreview: PreviewState = { ...nextPreview, loading: false, loaded: true };
      if (!isMountedRef.current) return;

      setPreviews((prev) => ({
        ...prev,
        [previewKey]: resolvedPreview,
      }));
      setNodes((prev) =>
        prev.map((flowNode) => {
          if (getPreviewKey(fromFlowNode(flowNode)) !== previewKey) return flowNode;
          const sourceNode = fromFlowNode(flowNode);
          return {
            ...flowNode,
            data: {
              ...flowNode.data,
              ...(sourceNode.type === 'web'
                ? buildWebPreviewState(sourceNode, resolvedPreview, canvasWebCardDefaultMode, canvasWebCardAutoLoad, webPreviewsEnabled)
                : buildNodePreviewState(sourceNode as Extract<CanvasNode, { relativePath: string }>, resolvedPreview)),
              onOpen: openRelativePath,
              onWikilinkClick: openRelativePath,
              onOpenUrl: openExternalUrl,
              onRequestWebPreview: requestWebPreview,
            },
          };
        }),
      );
    } catch (error) {
      if (!isMountedRef.current) return;
      const failedPreview: PreviewState = {
        ...(previews[previewKey] ?? {}),
        previewError: error instanceof Error ? error.message : String(error),
        loading: false,
        loaded: true,
      };
      setPreviews((prev) => ({
        ...prev,
        [previewKey]: failedPreview,
      }));
      if (node.type === 'web') {
        setNodes((prev) =>
          prev.map((flowNode) => {
            if (flowNode.id !== node.id) return flowNode;
            return {
              ...flowNode,
              data: {
                ...flowNode.data,
                ...buildWebPreviewState(node, failedPreview, canvasWebCardDefaultMode, canvasWebCardAutoLoad, webPreviewsEnabled),
                onRequestWebPreview: requestWebPreview,
                onOpenUrl: openExternalUrl,
              },
            };
          }),
        );
      }
    } finally {
      loadingPreviewPathsRef.current.delete(previewKey);
    }
  }, [
    canvasWebCardAutoLoad,
    canvasWebCardDefaultMode,
    fromFlowNode,
    isMountedRef,
    openExternalUrl,
    openRelativePath,
    previews,
    renderPdfPreview,
    requestWebPreview,
    setNodes,
    vault,
    webPreviewsEnabled,
  ]);

  useEffect(() => {
    if (!webPreviewsEnabled || !hoverWebLinkPreviewsEnabled || !backgroundWebPreviewPrefetchEnabled) return;
    const urls = nodes
      .map((flowNode) => fromFlowNode(flowNode))
      .filter((node): node is WebCanvasNode => node.type === 'web')
      .map((node) => normalizeWebUrl(node.url))
      .filter((url) => /^https?:\/\//i.test(url));
    if (urls.length === 0) return;
    prefetchWebPreviews(urls);
  }, [backgroundWebPreviewPrefetchEnabled, fromFlowNode, hoverWebLinkPreviewsEnabled, nodes, webPreviewsEnabled]);

  useEffect(() => {
    for (const flowNode of nodes) {
      const sourceNode = fromFlowNode(flowNode);
      if (sourceNode.type !== 'web' && !vault) continue;
      if (sourceNode.type !== 'web' && flowNode.type !== 'noteCard' && flowNode.type !== 'fileCard') continue;
      const existing = previews[getPreviewKey(sourceNode)];
      if (existing?.loading || existing?.loaded) continue;
      if (sourceNode.type === 'web' && !sourceNode.url.trim()) continue;
      if (sourceNode.type === 'web' && !webPreviewsEnabled) continue;
      if (sourceNode.type === 'web' && !canvasWebCardAutoLoad && !requestedWebPreviewIds[sourceNode.id]) continue;
      void hydratePreview(sourceNode);
    }
  }, [canvasWebCardAutoLoad, fromFlowNode, hydratePreview, nodes, previews, requestedWebPreviewIds, vault, webPreviewsEnabled]);

  const resetPreviewState = useCallback(() => {
    setPreviews({});
    setRequestedWebPreviewIds({});
  }, []);

  return {
    openExternalUrl,
    previews,
    requestWebPreview,
    resetPreviewState,
    updateWebDisplayModeOverride,
    updateWebUrl,
  };
}
