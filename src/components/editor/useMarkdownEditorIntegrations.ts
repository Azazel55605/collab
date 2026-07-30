import { useEffect, useRef, type MutableRefObject } from 'react';
import { EditorView } from '@codemirror/view';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { toast } from 'sonner';

import { createVaultClient } from '../../lib/vaultClient';
import {
  getVaultDocumentView,
  resolveVaultRelativeLinkTarget,
  resolveVaultWikilinkTarget,
} from '../../lib/vaultLinks';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

type HoverPreviewState = {
  url: string | null;
  pdfRelativePath: string | null;
  rect: DOMRect | null;
};

type ImportDroppedImagesArgs = {
  sourcePaths: string[];
  dropPos: number;
  view: EditorView;
  importAsset: ((sourcePath: string, targetFolder?: string) => Promise<string>) | null;
  isImageLikePath: (path: string) => boolean;
  buildImageMarkdown: (relativePath: string) => string;
  onError?: (message: string) => void;
};

type NativeDropState = {
  lastDropKey: string;
  lastDropAt: number;
};

type ClipboardImageSource =
  | {
      kind: 'blob';
      blob: Blob;
      mime: string;
      suggestedFileName: string;
    }
  | {
      kind: 'dataUrl';
      dataUrl: string;
      suggestedFileName: string;
    };

export function getLocalPathsFromUriList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      try {
        return line.startsWith('file://') ? decodeURIComponent(line.slice(7)) : '';
      } catch {
        return '';
      }
    })
    .filter((path) => path.length > 0);
}

export function getClipboardFileUriPaths(clipboardData: DataTransfer | null | undefined): string[] {
  if (!clipboardData) return [];

  const uriListPaths = getLocalPathsFromUriList(clipboardData.getData('text/uri-list') ?? '');
  if (uriListPaths.length > 0) return uriListPaths;

  return getLocalPathsFromUriList(clipboardData.getData('text/plain') ?? '');
}

async function getNavigatorClipboardFileUriPaths(): Promise<string[]> {
  const readText = navigator.clipboard?.readText?.bind(navigator.clipboard);
  if (!readText) return [];

  try {
    return getLocalPathsFromUriList(await readText());
  } catch {
    return [];
  }
}

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
  currentDocumentRelativePath?: string,
): HoverPreviewState {
  if (!enabled) {
    return { url: null, pdfRelativePath: null, rect: null };
  }

  const target = event.target instanceof Element ? event.target : null;
  const linkEl = target?.closest('.cm-lp-link') as HTMLElement | null;
  const wikiEl = target?.closest('.cm-lp-wikilink') as HTMLElement | null;
  const url = linkEl?.dataset.url ?? null;
  if (url && linkEl && /^https?:\/\//i.test(url)) {
    return {
      url,
      pdfRelativePath: null,
      rect: linkEl.getBoundingClientRect(),
    };
  }

  if (currentDocumentRelativePath) {
    const fileTree = useVaultStore.getState().fileTree;
    const linkTarget = wikiEl?.dataset.path
      ? resolveVaultWikilinkTarget(wikiEl.dataset.path, fileTree)
      : linkEl?.dataset.url
      ? resolveVaultRelativeLinkTarget(linkEl.dataset.url, currentDocumentRelativePath, fileTree)
      : null;
    if (linkTarget?.type === 'pdf') {
      const anchor = wikiEl ?? linkEl;
      return {
        url: null,
        pdfRelativePath: linkTarget.relativePath,
        rect: anchor?.getBoundingClientRect() ?? null,
      };
    }
  }

  return { url: null, pdfRelativePath: null, rect: null };
}

function extensionForClipboardMime(mime: string) {
  switch (mime.toLowerCase()) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    case 'image/svg+xml': return 'svg';
    case 'image/bmp': return 'bmp';
    case 'image/x-icon':
    case 'image/vnd.microsoft.icon': return 'ico';
    case 'image/avif': return 'avif';
    default: return 'png';
  }
}

function buildClipboardSuggestedFileName(mime: string, index = 0) {
  const ext = extensionForClipboardMime(mime);
  return index > 0 ? `clipboard-image-${index + 1}.${ext}` : `clipboard-image.${ext}`;
}

async function blobToDataUrl(blob: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read clipboard image'));
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Clipboard image did not produce a data URL'));
    };
    reader.readAsDataURL(blob);
  });
}

export function getClipboardEventImageSources(clipboardData: DataTransfer | null | undefined): ClipboardImageSource[] {
  if (!clipboardData) return [];

  const files = Array.from(clipboardData.files ?? []);
  if (files.length > 0) {
    return files
      .filter((file) => file.type.startsWith('image/'))
      .map((file, index) => ({
        kind: 'blob' as const,
        blob: file,
        mime: file.type || 'image/png',
        suggestedFileName: file.name || buildClipboardSuggestedFileName(file.type || 'image/png', index),
      }));
  }

  const items = Array.from(clipboardData.items ?? []);
  return items.reduce<ClipboardImageSource[]>((sources, item, index) => {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) return sources;
    const file = item.getAsFile();
    if (!file) return sources;
    sources.push({
      kind: 'blob',
      blob: file,
      mime: file.type || item.type || 'image/png',
      suggestedFileName: file.name || buildClipboardSuggestedFileName(file.type || item.type || 'image/png', index),
    });
    return sources;
  }, []);
}

export function getClipboardHtmlImageSources(html: string): ClipboardImageSource[] {
  if (!html.trim()) return [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const images = Array.from(doc.querySelectorAll('img[src]'));
  const sources: ClipboardImageSource[] = [];

  images.forEach((image, index) => {
    const src = image.getAttribute('src')?.trim() ?? '';
    const match = src.match(/^data:(image\/[^;,]+);base64,/i);
    if (!match) return;
    const mime = match[1] || 'image/png';
    sources.push({
      kind: 'dataUrl',
      dataUrl: src,
      suggestedFileName: buildClipboardSuggestedFileName(mime, index),
    });
  });

  return sources;
}

async function getNavigatorClipboardImageSources(): Promise<ClipboardImageSource[]> {
  const read = navigator.clipboard?.read?.bind(navigator.clipboard);
  if (!read) return [];

  try {
    const items = await read();
    const sources: ClipboardImageSource[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const imageType = item.types.find((type) => type.startsWith('image/'));
      if (!imageType) continue;
      const blob = await item.getType(imageType);
      sources.push({
        kind: 'blob',
        blob,
        mime: imageType,
        suggestedFileName: buildClipboardSuggestedFileName(imageType, index),
      });
    }
    return sources;
  } catch {
    return [];
  }
}

export async function importDroppedImagesIntoEditor({
  sourcePaths,
  dropPos,
  view,
  importAsset,
  isImageLikePath,
  buildImageMarkdown,
  onError = (message) => toast.error(message),
}: ImportDroppedImagesArgs) {
  if (!importAsset) return false;

  const imagePaths = sourcePaths.filter(isImageLikePath);
  if (imagePaths.length === 0) return false;

  try {
    const insertedPaths: string[] = [];
    for (const sourcePath of imagePaths) {
      const imported = await importAsset(sourcePath, 'Pictures');
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

type ImportClipboardImagesArgs = {
  clipboardImages: ClipboardImageSource[];
  insertPos: number;
  view: EditorView;
  importData: ((dataUrl: string, suggestedName: string, targetFolder?: string) => Promise<string>) | null;
  currentDocumentRelativePath: string;
  buildImageMarkdown: (relativePath: string, currentDocumentRelativePath: string) => string;
  onError?: (message: string) => void;
};

export async function importClipboardImagesIntoEditor({
  clipboardImages,
  insertPos,
  view,
  importData,
  currentDocumentRelativePath,
  buildImageMarkdown,
  onError = (message) => toast.error(message),
}: ImportClipboardImagesArgs) {
  if (!importData || clipboardImages.length === 0) return false;

  try {
    const insertedPaths: string[] = [];
    for (const image of clipboardImages) {
      const dataUrl = image.kind === 'dataUrl'
        ? image.dataUrl
        : await blobToDataUrl(image.blob);
      const imported = await importData(dataUrl, image.suggestedFileName, 'Pictures');
      insertedPaths.push(imported);
    }

    const insertText = insertedPaths
      .map((relativePath) => buildImageMarkdown(relativePath, currentDocumentRelativePath))
      .join('\n');
    view.dispatch({
      changes: { from: insertPos, to: insertPos, insert: insertText },
      selection: { anchor: insertPos + insertText.length },
    });
    view.focus();
    return true;
  } catch (err) {
    onError(`Failed to import clipboard image: ${String(err)}`);
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

export function handleEditorDocumentLinkMouseDown(event: MouseEvent, currentDocumentRelativePath: string) {
  if (event.button !== 0) return false;

  const target = event.target instanceof Element ? event.target : null;
  const wikiEl = target?.closest('.cm-lp-wikilink') as HTMLElement | null;
  const linkEl = target?.closest('.cm-lp-link') as HTMLElement | null;
  if (!wikiEl && !linkEl) return false;

  const fileTree = useVaultStore.getState().fileTree;
  const linkTarget = wikiEl?.dataset.path
    ? resolveVaultWikilinkTarget(wikiEl.dataset.path, fileTree)
    : linkEl?.dataset.url
    ? resolveVaultRelativeLinkTarget(linkEl.dataset.url, currentDocumentRelativePath, fileTree)
    : null;

  if (!linkTarget) return false;

  if (linkTarget.type === 'sheet' && linkEl?.dataset.url) {
    const match = linkEl.dataset.url.match(/#range=([^&]+)/i);
    if (match) {
      try {
        useEditorStore.getState().setPendingSheetJump({
          relativePath: linkTarget.relativePath,
          range: decodeURIComponent(match[1]),
        });
      } catch {
        // Malformed fragments still open the workbook without a range jump.
      }
    }
  }
  useEditorStore.getState().openTab(linkTarget.relativePath, linkTarget.title, linkTarget.type);
  useUiStore.getState().setActiveView(getVaultDocumentView(linkTarget.type));
  event.preventDefault();
  event.stopPropagation();
  return true;
}

type UseMarkdownEditorIntegrationsArgs = {
  view: EditorView | null;
  webPreviewsEnabled: boolean;
  hoverWebLinkPreviewsEnabled: boolean;
  setHoveredUrl: (url: string | null) => void;
  setHoveredPdfRelativePath: (path: string | null) => void;
  setHoverRect: (rect: DOMRect | null) => void;
  getDroppedFilePaths: (event: DragEvent) => string[];
  isImageLikePath: (path: string) => boolean;
  buildImageMarkdown: (relativePath: string) => string;
  currentDocumentRelativePath: string;
  /** When true, drag-dropping images must not import or insert (viewer access). */
  readOnly?: boolean;
};

export function useMarkdownEditorIntegrations({
  view,
  webPreviewsEnabled,
  hoverWebLinkPreviewsEnabled,
  setHoveredUrl,
  setHoveredPdfRelativePath,
  setHoverRect,
  getDroppedFilePaths,
  isImageLikePath,
  buildImageMarkdown,
  currentDocumentRelativePath,
  readOnly = false,
}: UseMarkdownEditorIntegrationsArgs) {
  const nativeDropStateRef = useRef<NativeDropState>({ lastDropKey: '', lastDropAt: 0 });

  useEffect(() => {
    if (!view) return;

    const editorDom = view.dom;
    const webview = getCurrentWebview();
    const appWindow = getCurrentWindow();
    let unlistenWebviewDragDrop: (() => void) | null = null;
    let unlistenWindowDragDrop: (() => void) | null = null;

    const resolveAssetImport = () => {
      const vault = useVaultStore.getState().vault;
      return vault ? createVaultClient(vault).runtime.externalAssetImport ?? null : null;
    };

    const importDroppedImages = (sourcePaths: string[], dropPos: number) => {
      // A viewer cannot modify the note; dropped images must not be imported.
      if (readOnly) return;
      void importDroppedImagesIntoEditor({
        sourcePaths,
        dropPos,
        view,
        importAsset: resolveAssetImport()?.import ?? null,
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
    const handlePaste = (event: ClipboardEvent) => {
      const insertPos = view.state.selection.main.from;
      const clipboardFileUriPaths = getClipboardFileUriPaths(event.clipboardData);
      const imageUriPaths = clipboardFileUriPaths.filter(isImageLikePath);
      if (imageUriPaths.length > 0) {
        event.preventDefault();
        importDroppedImages(imageUriPaths, insertPos);
        return;
      }

      const directImages = getClipboardEventImageSources(event.clipboardData);
      if (directImages.length > 0) {
        event.preventDefault();
        void importClipboardImagesIntoEditor({
          clipboardImages: directImages,
          insertPos,
          view,
          importData: resolveAssetImport()?.importData ?? null,
          currentDocumentRelativePath,
          buildImageMarkdown,
        });
        return;
      }

      const htmlImages = getClipboardHtmlImageSources(event.clipboardData?.getData('text/html') ?? '');
      if (htmlImages.length > 0) {
        event.preventDefault();
        void importClipboardImagesIntoEditor({
          clipboardImages: htmlImages,
          insertPos,
          view,
          importData: resolveAssetImport()?.importData ?? null,
          currentDocumentRelativePath,
          buildImageMarkdown,
        });
        return;
      }

      const clipboardText = event.clipboardData?.getData('text/plain') ?? '';
      if (clipboardText) return;

      event.preventDefault();
      void (async () => {
        const navigatorClipboardImages = await getNavigatorClipboardImageSources();
        if (navigatorClipboardImages.length > 0) {
          await importClipboardImagesIntoEditor({
            clipboardImages: navigatorClipboardImages,
            insertPos,
            view,
            importData: resolveAssetImport()?.importData ?? null,
            currentDocumentRelativePath,
            buildImageMarkdown,
          });
          return;
        }

        const navigatorClipboardUriPaths = await getNavigatorClipboardFileUriPaths();
        const navigatorImageUriPaths = navigatorClipboardUriPaths.filter(isImageLikePath);
        if (navigatorImageUriPaths.length > 0) {
          importDroppedImages(navigatorImageUriPaths, insertPos);
          return;
        }

        const navigatorClipboardText = navigator.clipboard?.readText
          ? await navigator.clipboard.readText().catch(() => '')
          : '';
        if (!navigatorClipboardText) return;

        view.dispatch({
          changes: { from: insertPos, to: view.state.selection.main.to, insert: navigatorClipboardText },
          selection: { anchor: insertPos + navigatorClipboardText.length },
        });
        view.focus();
      })();
    };
    const handlePreviewHover = (event: MouseEvent) => {
      const next = resolveHoverPreviewState(event, hoverWebLinkPreviewsEnabled, currentDocumentRelativePath);
      const nextUrl = webPreviewsEnabled ? next.url : null;
      setHoveredUrl(nextUrl);
      setHoveredPdfRelativePath(next.pdfRelativePath);
      setHoverRect(next.rect);
    };
    const handlePreviewLeave = () => {
      setHoveredUrl(null);
      setHoveredPdfRelativePath(null);
      setHoverRect(null);
    };
    const handleMouseDown = (event: MouseEvent) => {
      handleEditorImageShiftClick(event);
    };

    editorDom.addEventListener('drop', handleDrop);
    editorDom.addEventListener('paste', handlePaste, true);
    editorDom.addEventListener('mousemove', handlePreviewHover);
    editorDom.addEventListener('mouseleave', handlePreviewLeave);
    editorDom.addEventListener('mousedown', handleMouseDown, true);

    return () => {
      editorDom.removeEventListener('drop', handleDrop);
      editorDom.removeEventListener('paste', handlePaste, true);
      editorDom.removeEventListener('mousemove', handlePreviewHover);
      editorDom.removeEventListener('mouseleave', handlePreviewLeave);
      editorDom.removeEventListener('mousedown', handleMouseDown, true);
      unlistenWebviewDragDrop?.();
      unlistenWindowDragDrop?.();
    };
  }, [
    buildImageMarkdown,
    currentDocumentRelativePath,
    getDroppedFilePaths,
    hoverWebLinkPreviewsEnabled,
    isImageLikePath,
    readOnly,
    setHoverRect,
    setHoveredPdfRelativePath,
    setHoveredUrl,
    view,
    webPreviewsEnabled,
  ]);
}
