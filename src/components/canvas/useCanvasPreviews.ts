import { useCallback, useEffect, useRef, useState } from 'react';

import type { Node as FlowNode } from '@xyflow/react';

import { getDocumentPreviewDataUrl, supportsDocumentPreview } from '../../lib/documentPreview';
import { getImagePreviewDataUrl } from '../../lib/imagePreview';
import { listenSafely } from '../../lib/nativeSubscription';
import { getPdfPreviewDataUrl } from '../../lib/pdfPreview';
import { previewIdentity } from '../../lib/previewIdentity';
import { previewScheduler } from '../../lib/previewScheduler';
import { tauriCommands } from '../../lib/tauri';
import { createVaultClient } from '../../lib/vaultClient';
import { onReplicaMutated } from '../../lib/vaultReplica';
import {
  prefetchWebPreviews,
  requestWebPreview as requestCachedWebPreview,
} from '../../lib/webPreviewCache';
import type { CanvasWebCardDefaultMode } from '../../store/uiStore';
import type { CanvasNode, CanvasWebDisplayMode } from '../../types/canvas';
import type { VaultMeta } from '../../types/vault';

import type { CanvasNodeData } from './CanvasNodeTypes';
import {
  buildNodePreviewState,
  buildWebPreviewState,
  canPreviewText,
  cleanPreviewText,
  getPreviewKey,
  isImageExtension,
  normalizeWebUrl,
  type PreviewState,
  resolveWebDisplayMode,
} from './CanvasPreviewUtils';

interface UseCanvasPreviewsOptions {
  vault: VaultMeta | null;
  nodes: FlowNode<CanvasNodeData>[];
  setNodes: React.Dispatch<React.SetStateAction<FlowNode<CanvasNodeData>[]>>;
  isMountedRef: React.RefObject<boolean>;
  fromFlowNode: (node: FlowNode<CanvasNodeData>) => CanvasNode;
  renderPdfPreview?: (dataUrl: string) => Promise<string>;
  openRelativePath: (path: string) => void;
  canvasWebCardDefaultMode: CanvasWebCardDefaultMode;
  canvasWebCardAutoLoad: boolean;
  webPreviewsEnabled: boolean;
  hoverWebLinkPreviewsEnabled: boolean;
  backgroundWebPreviewPrefetchEnabled: boolean;
  isVisible?: (node: FlowNode<CanvasNodeData>) => boolean;
}

export function useCanvasPreviews({
  vault,
  nodes,
  setNodes,
  isMountedRef,
  fromFlowNode,
  openRelativePath,
  canvasWebCardDefaultMode,
  canvasWebCardAutoLoad,
  webPreviewsEnabled,
  hoverWebLinkPreviewsEnabled,
  backgroundWebPreviewPrefetchEnabled,
  isVisible,
}: UseCanvasPreviewsOptions) {
  const generationRef = useRef(0);
  const loadingPreviewPathsRef = useRef(new Set<string>());
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({});
  const [requestedWebPreviewIds, setRequestedWebPreviewIds] = useState<Record<string, boolean>>({});

  const requestWebPreview = useCallback((nodeId: string) => {
    setRequestedWebPreviewIds((prev) => ({ ...prev, [nodeId]: true }));
  }, []);

  const updateWebUrl = useCallback(
    (nodeId: string, url: string) => {
      setRequestedWebPreviewIds((prev) => {
        if (!(nodeId in prev)) return prev;
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
      setNodes((prev) =>
        prev.map((node) =>
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
            : node,
        ),
      );
    },
    [setNodes],
  );

  const updateWebDisplayModeOverride = useCallback(
    (nodeId: string, mode: CanvasWebDisplayMode | null) => {
      setNodes((prev) =>
        prev.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                data: {
                  ...node.data,
                  displayModeOverride: mode,
                  displayMode: resolveWebDisplayMode(mode, canvasWebCardDefaultMode),
                },
              }
            : node,
        ),
      );
    },
    [canvasWebCardDefaultMode, setNodes],
  );

  const openExternalUrl = useCallback((url: string) => {
    const normalized = normalizeWebUrl(url);
    if (!normalized) return;
    void tauriCommands.openExternalUrl(normalized);
  }, []);

  const previewRequests = useRef(new Set<AbortController>());
  const hydratePreview = useCallback(
    async (node: CanvasNode) => {
      if (!vault && node.type !== 'web') return;
      const previewKey = getPreviewKey(node);
      if (loadingPreviewPathsRef.current.has(previewKey)) return;

      const request = new AbortController();
      previewRequests.current.add(request);
      const generation = generationRef.current;
      const loading = loadingPreviewPathsRef.current;
      const current = () => isMountedRef.current && generationRef.current === generation;
      loading.add(previewKey);
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
                ...buildWebPreviewState(
                  node,
                  { ...(previews[previewKey] ?? {}), loading: true, loaded: false },
                  canvasWebCardDefaultMode,
                  canvasWebCardAutoLoad,
                  webPreviewsEnabled,
                ),
                onRequestWebPreview: requestWebPreview,
                onOpenUrl: openExternalUrl,
              },
            };
          }),
        );
      }

      try {
        const nextPreview = await (async () => {
          if (!current()) throw new DOMException('Cancelled', 'AbortError');
          let nextPreview: PreviewState = {};

          if (node.type === 'web') {
            const normalizedUrl = normalizeWebUrl(node.url);
            if (!normalizedUrl) {
              nextPreview = { previewError: null };
            } else {
              const linkPreview = await requestCachedWebPreview(normalizedUrl, {
                signal: request.signal,
              });
              nextPreview = {
                linkPreview,
                imageSrc: linkPreview.imageUrl ?? null,
                faviconSrc: linkPreview.faviconUrl ?? null,
              };
            }
          } else if ('relativePath' in node && vault) {
            const client = createVaultClient(vault);
            const path = node.relativePath;
            const extension = path.split('.').pop()?.toLowerCase() ?? '';
            if (node.type === 'file' && isImageExtension(extension)) {
              nextPreview = {
                imageSrc: await getImagePreviewDataUrl(client, path, { signal: request.signal }),
              };
            } else if (node.type === 'file' && extension === 'pdf') {
              nextPreview = {
                imageSrc: await getPdfPreviewDataUrl(client, path, { signal: request.signal }),
              };
            } else if (node.type === 'note') {
              const { content } = await previewScheduler.run(
                previewIdentity(client, path, 'text'),
                async (signal) => {
                  if (signal.aborted || !current())
                    throw new DOMException('Cancelled', 'AbortError');
                  return client.readDocument(path);
                },
                { signal: request.signal },
              );
              nextPreview = {
                excerpt: cleanPreviewText(content),
                markdownContent: content.slice(0, 32_000),
              };
            } else if (supportsDocumentPreview(path)) {
              nextPreview = {
                imageSrc: await getDocumentPreviewDataUrl(client, path, { signal: request.signal }),
              };
            } else if (canPreviewText(extension)) {
              const { content } = await previewScheduler.run(
                previewIdentity(client, path, 'text'),
                async (signal) => {
                  if (signal.aborted || !current())
                    throw new DOMException('Cancelled', 'AbortError');
                  return client.readDocument(path);
                },
                { signal: request.signal },
              );
              nextPreview = { excerpt: cleanPreviewText(content) };
            }
          }

          return nextPreview;
        })();
        const resolvedPreview: PreviewState = { ...nextPreview, loading: false, loaded: true };
        if (!current()) return;

        setPreviews((prev) => ({
          ...prev,
          [previewKey]: resolvedPreview,
        }));
        setNodes((prev) =>
          prev.map((flowNode) => {
            const key =
              flowNode.type === 'webCard'
                ? `web:${normalizeWebUrl(flowNode.data.url ?? '')}`
                : `vault:${flowNode.data.relativePath ?? ''}`;
            if (key !== previewKey) return flowNode;
            const sourceNode = fromFlowNode(flowNode);
            return {
              ...flowNode,
              data: {
                ...flowNode.data,
                ...(sourceNode.type === 'web'
                  ? buildWebPreviewState(
                      sourceNode,
                      resolvedPreview,
                      canvasWebCardDefaultMode,
                      canvasWebCardAutoLoad,
                      webPreviewsEnabled,
                    )
                  : buildNodePreviewState(
                      sourceNode as Extract<CanvasNode, { relativePath: string }>,
                      resolvedPreview,
                    )),
                onOpen: openRelativePath,
                onWikilinkClick: openRelativePath,
                onOpenUrl: openExternalUrl,
                onRequestWebPreview: requestWebPreview,
              },
            };
          }),
        );
      } catch (error) {
        if (!current()) return;
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
                  ...buildWebPreviewState(
                    node,
                    failedPreview,
                    canvasWebCardDefaultMode,
                    canvasWebCardAutoLoad,
                    webPreviewsEnabled,
                  ),
                  onRequestWebPreview: requestWebPreview,
                  onOpenUrl: openExternalUrl,
                },
              };
            }),
          );
        }
      } finally {
        previewRequests.current.delete(request);
        loading.delete(previewKey);
      }
    },
    [
      canvasWebCardAutoLoad,
      canvasWebCardDefaultMode,
      fromFlowNode,
      isMountedRef,
      openExternalUrl,
      openRelativePath,
      previews,
      requestWebPreview,
      setNodes,
      vault,
      webPreviewsEnabled,
    ],
  );

  useEffect(() => {
    if (!webPreviewsEnabled || !hoverWebLinkPreviewsEnabled || !backgroundWebPreviewPrefetchEnabled)
      return;
    const urls = nodes
      .filter((node) => !isVisible || isVisible(node))
      .filter((node) => node.type === 'webCard')
      .map((node) => normalizeWebUrl(node.data.url ?? ''))
      .filter((url) => /^https?:\/\//i.test(url));
    if (urls.length === 0) return;
    prefetchWebPreviews(urls);
  }, [
    backgroundWebPreviewPrefetchEnabled,
    isVisible,
    fromFlowNode,
    hoverWebLinkPreviewsEnabled,
    nodes,
    webPreviewsEnabled,
  ]);

  useEffect(() => {
    for (const flowNode of nodes) {
      if (isVisible && !isVisible(flowNode)) continue;
      if (
        flowNode.type !== 'webCard' &&
        flowNode.type !== 'noteCard' &&
        flowNode.type !== 'fileCard'
      )
        continue;
      if (flowNode.type !== 'webCard' && !vault) continue;
      const key =
        flowNode.type === 'webCard'
          ? `web:${normalizeWebUrl(flowNode.data.url ?? '')}`
          : `vault:${flowNode.data.relativePath ?? ''}`;
      const existing = previews[key];
      if (existing?.loading || existing?.loaded) continue;
      const sourceNode = fromFlowNode(flowNode);
      if (sourceNode.type === 'web' && !sourceNode.url.trim()) continue;
      if (sourceNode.type === 'web' && !webPreviewsEnabled) continue;
      if (
        sourceNode.type === 'web' &&
        !canvasWebCardAutoLoad &&
        !requestedWebPreviewIds[sourceNode.id]
      )
        continue;
      void hydratePreview(sourceNode);
    }
  }, [
    canvasWebCardAutoLoad,
    isVisible,
    fromFlowNode,
    hydratePreview,
    nodes,
    previews,
    requestedWebPreviewIds,
    vault,
    webPreviewsEnabled,
  ]);

  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  useEffect(() => {
    if (!vault) return;
    const invalidate = (paths?: string[]) => {
      const affects = (key: string) =>
        key.startsWith('vault:') && (!paths || paths.includes(key.slice(6)));
      if (!Object.keys(previewsRef.current).some(affects)) return;
      generationRef.current++;
      for (const request of previewRequests.current) request.abort();
      previewRequests.current.clear();
      loadingPreviewPathsRef.current = new Set();
      setPreviews((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(([key, value]) => !affects(key) && !value.loading),
        ),
      );
    };
    const offReplica = onReplicaMutated((event) => invalidate(event.relativePaths), {
      kinds: ['manifest'],
    });
    const offFile =
      vault.kind === 'hosted'
        ? () => {}
        : listenSafely<{ path?: string }>('vault:file-modified', ({ payload }) =>
            invalidate(payload.path ? [payload.path] : undefined),
          );
    return () => {
      offReplica();
      offFile();
    };
  }, [vault]);

  const resetPreviewState = useCallback(() => {
    generationRef.current++;
    for (const request of previewRequests.current) request.abort();
    previewRequests.current.clear();
    loadingPreviewPathsRef.current = new Set();
    setPreviews({});
    setRequestedWebPreviewIds({});
  }, []);

  useEffect(
    () => () => {
      generationRef.current++;
      for (const request of previewRequests.current) request.abort();
      previewRequests.current.clear();
    },
    [],
  );

  return {
    openExternalUrl,
    previews,
    requestWebPreview,
    resetPreviewState,
    updateWebDisplayModeOverride,
    updateWebUrl,
  };
}
