import { useEffect, useRef, type MutableRefObject } from 'react';
import { EditorView } from '@codemirror/view';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { toast } from 'sonner';

import { tauriCommands } from '../../lib/tauri';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

type HoverPreviewState = {
  url: string | null;
  rect: DOMRect | null;
};

type ImportDroppedImagesArgs = {
  sourcePaths: string[];
  dropPos: number;
  view: EditorView;
  vaultPath: string | null;
  isImageLikePath: (path: string) => boolean;
  buildImageMarkdown: (relativePath: string) => string;
  importAssetIntoVault?: typeof tauriCommands.importAssetIntoVault;
  onError?: (message: string) => void;
};

type NativeDropState = {
  lastDropKey: string;
  lastDropAt: number;
};

type NativeDropArgs = {
  paths: string[];
  clientX: number;
  clientY: number;
  editorDom: HTMLElement;
  view: EditorView;
  stateRef: MutableRefObject<NativeDropState>;
  importDroppedImages: (sourcePaths: string[], dropPos: number) => void;
};

export function resolveHoverPreviewState(
  event: MouseEvent,
  enabled: boolean,
): HoverPreviewState {
  if (!enabled) {
    return { url: null, rect: null };
  }

  const target = event.target instanceof Element ? event.target : null;
  const linkEl = target?.closest('.cm-lp-link') as HTMLElement | null;
  const url = linkEl?.dataset.url ?? null;
  if (url && linkEl && /^https?:\/\//i.test(url)) {
    return {
      url,
      rect: linkEl.getBoundingClientRect(),
    };
  }

  return { url: null, rect: null };
}

export async function importDroppedImagesIntoEditor({
  sourcePaths,
  dropPos,
  view,
  vaultPath,
  isImageLikePath,
  buildImageMarkdown,
  importAssetIntoVault = tauriCommands.importAssetIntoVault,
  onError = (message) => toast.error(message),
}: ImportDroppedImagesArgs) {
  if (!vaultPath) return false;

  const imagePaths = sourcePaths.filter(isImageLikePath);
  if (imagePaths.length === 0) return false;

  try {
    const insertedPaths: string[] = [];
    for (const sourcePath of imagePaths) {
      const imported = await importAssetIntoVault(vaultPath, sourcePath, 'Pictures');
      insertedPaths.push(imported);
    }

    const insertText = insertedPaths.map(buildImageMarkdown).join('\n');
    view.dispatch({
      changes: { from: dropPos, to: dropPos, insert: insertText },
      selection: { anchor: dropPos + insertText.length },
    });
    view.focus();
    return true;
  } catch (err) {
    onError(`Failed to import image: ${String(err)}`);
    return false;
  }
}

export function handleNativeEditorDrop({
  paths,
  clientX,
  clientY,
  editorDom,
  view,
  stateRef,
  importDroppedImages,
}: NativeDropArgs) {
  const rect = editorDom.getBoundingClientRect();
  const insideEditor =
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom;

  if (!insideEditor) return false;

  const dropPos = view.state.selection.main.from;
  const dropKey = `${paths.join('\n')}@@${Math.round(clientX)}:${Math.round(clientY)}`;
  const now = Date.now();
  if (dropKey === stateRef.current.lastDropKey && now - stateRef.current.lastDropAt < 300) {
    return false;
  }
  stateRef.current.lastDropKey = dropKey;
  stateRef.current.lastDropAt = now;
  importDroppedImages(paths, dropPos);
  return true;
}

export function handleEditorImageShiftClick(event: MouseEvent) {
  if (!event.shiftKey) return false;

  const target = event.target instanceof Element ? event.target : null;
  const imageEl = target?.closest('.cm-lp-image') as HTMLElement | null;
  if (!imageEl) return false;

  const assetKind = imageEl.dataset.assetKind;
  const assetValue = imageEl.dataset.assetValue;
  if (assetKind !== 'vault' || !assetValue) return false;

  const title = assetValue.split('/').pop()?.replace(/\.[^.]+$/, '') ?? assetValue;
  useEditorStore.getState().openTab(assetValue, title, 'image');
  useUiStore.getState().setActiveView('editor');
  event.preventDefault();
  event.stopPropagation();
  return true;
}

type UseMarkdownEditorIntegrationsArgs = {
  view: EditorView | null;
  webPreviewsEnabled: boolean;
  hoverWebLinkPreviewsEnabled: boolean;
  setHoveredUrl: (url: string | null) => void;
  setHoverRect: (rect: DOMRect | null) => void;
  getDroppedFilePaths: (event: DragEvent) => string[];
  isImageLikePath: (path: string) => boolean;
  buildImageMarkdown: (relativePath: string) => string;
};

export function useMarkdownEditorIntegrations({
  view,
  webPreviewsEnabled,
  hoverWebLinkPreviewsEnabled,
  setHoveredUrl,
  setHoverRect,
  getDroppedFilePaths,
  isImageLikePath,
  buildImageMarkdown,
}: UseMarkdownEditorIntegrationsArgs) {
  const nativeDropStateRef = useRef<NativeDropState>({ lastDropKey: '', lastDropAt: 0 });

  useEffect(() => {
    if (!view) return;

    const editorDom = view.dom;
    const webview = getCurrentWebview();
    const appWindow = getCurrentWindow();
    let unlistenWebviewDragDrop: (() => void) | null = null;
    let unlistenWindowDragDrop: (() => void) | null = null;

    const importDroppedImages = (sourcePaths: string[], dropPos: number) => {
      const vaultPath = useVaultStore.getState().vault?.path ?? null;
      void importDroppedImagesIntoEditor({
        sourcePaths,
        dropPos,
        view,
        vaultPath,
        isImageLikePath,
        buildImageMarkdown,
      });
    };

    const handleImageDrop = async (event: DragEvent) => {
      const sourcePaths = getDroppedFilePaths(event);
      if (sourcePaths.length === 0) return;

      event.preventDefault();
      importDroppedImages(sourcePaths, view.state.selection.main.from);
    };

    const attachDropListener = (
      subscribe: (handler: (event: {
        payload: { type: 'enter' | 'over' | 'drop' | 'leave'; paths?: string[]; position?: { x: number; y: number } };
      }) => void) => Promise<() => void>,
      setUnlisten: (unlisten: (() => void) | null) => void,
      label: string,
    ) => {
      void subscribe((event) => {
        if (event.payload.type !== 'drop' || !event.payload.paths || !event.payload.position) return;
        const clientX = event.payload.position.x / window.devicePixelRatio;
        const clientY = event.payload.position.y / window.devicePixelRatio;
        handleNativeEditorDrop({
          paths: event.payload.paths,
          clientX,
          clientY,
          editorDom,
          view,
          stateRef: nativeDropStateRef,
          importDroppedImages,
        });
      }).then((unlisten) => {
        setUnlisten(unlisten);
      }).catch((err) => {
        console.error(`[MarkdownEditor] failed to attach ${label} drag-drop listener:`, err);
      });
    };

    attachDropListener(
      (handler) => webview.onDragDropEvent(handler),
      (unlisten) => { unlistenWebviewDragDrop = unlisten; },
      'webview',
    );
    attachDropListener(
      (handler) => appWindow.onDragDropEvent(handler),
      (unlisten) => { unlistenWindowDragDrop = unlisten; },
      'window',
    );

    const handleDrop = (event: DragEvent) => { void handleImageDrop(event); };
    const handlePreviewHover = (event: MouseEvent) => {
      const next = resolveHoverPreviewState(event, webPreviewsEnabled && hoverWebLinkPreviewsEnabled);
      setHoveredUrl(next.url);
      setHoverRect(next.rect);
    };
    const handlePreviewLeave = () => {
      setHoveredUrl(null);
      setHoverRect(null);
    };
    const handleMouseDown = (event: MouseEvent) => {
      handleEditorImageShiftClick(event);
    };

    editorDom.addEventListener('drop', handleDrop);
    editorDom.addEventListener('mousemove', handlePreviewHover);
    editorDom.addEventListener('mouseleave', handlePreviewLeave);
    editorDom.addEventListener('mousedown', handleMouseDown, true);

    return () => {
      editorDom.removeEventListener('drop', handleDrop);
      editorDom.removeEventListener('mousemove', handlePreviewHover);
      editorDom.removeEventListener('mouseleave', handlePreviewLeave);
      editorDom.removeEventListener('mousedown', handleMouseDown, true);
      unlistenWebviewDragDrop?.();
      unlistenWindowDragDrop?.();
    };
  }, [
    buildImageMarkdown,
    getDroppedFilePaths,
    hoverWebLinkPreviewsEnabled,
    isImageLikePath,
    setHoverRect,
    setHoveredUrl,
    view,
    webPreviewsEnabled,
  ]);
}
