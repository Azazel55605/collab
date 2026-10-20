import type { NoteFile } from '../types/vault';

import { type FilePreviewType, getFilePreviewType } from './filePreviewType';
import { resolveVaultRelativeLinkTarget, resolveVaultWikilinkTarget } from './vaultLinks';

export interface MarkdownLinkPreviewState {
  anchor: Element | null;
  url: string | null;
  file: { relativePath: string; type: FilePreviewType } | null;
  rect: DOMRect | null;
}

export const EMPTY_LINK_PREVIEW: MarkdownLinkPreviewState = {
  anchor: null,
  url: null,
  file: null,
  rect: null,
};

export function findMarkdownLinkAnchor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('.cm-lp-link, .cm-lp-wikilink, a[href], .wikilink[data-path]');
  return anchor instanceof HTMLElement ? anchor : null;
}

/** Resolve existing vault files only; the shared vault client owns all file reads. */
export function resolveMarkdownLinkPreview(
  target: EventTarget | null,
  currentDocumentRelativePath: string | undefined,
  fileTree: NoteFile[],
  { enabled, webEnabled }: { enabled: boolean; webEnabled: boolean },
): MarkdownLinkPreviewState {
  if (!enabled) return EMPTY_LINK_PREVIEW;
  const anchor = findMarkdownLinkAnchor(target);
  if (!anchor) return EMPTY_LINK_PREVIEW;
  const href = anchor.dataset.url ?? anchor.getAttribute('href');
  if (href && /^https?:\/\//i.test(href)) {
    return webEnabled
      ? { anchor, url: href, file: null, rect: anchor.getBoundingClientRect() }
      : EMPTY_LINK_PREVIEW;
  }
  if (!currentDocumentRelativePath) return EMPTY_LINK_PREVIEW;
  const file = anchor.dataset.path
    ? resolveVaultWikilinkTarget(anchor.dataset.path, fileTree)
    : href
      ? resolveVaultRelativeLinkTarget(href, currentDocumentRelativePath, fileTree)
      : null;
  const type = file && getFilePreviewType(file.relativePath);
  if (!file || !type) return EMPTY_LINK_PREVIEW;
  return {
    anchor,
    url: null,
    file: { relativePath: file.relativePath, type },
    rect: anchor.getBoundingClientRect(),
  };
}
