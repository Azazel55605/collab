import { useCallback, useEffect, useRef, useState } from 'react';

import {
  EMPTY_LINK_PREVIEW,
  findMarkdownLinkAnchor,
  resolveMarkdownLinkPreview,
} from '../../lib/markdownLinkPreview';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';

export function useMarkdownLinkPreviews(currentDocumentRelativePath?: string) {
  const enabled = useUiStore((s) => s.hoverWebLinkPreviewsEnabled);
  const webEnabled = useUiStore((s) => s.webPreviewsEnabled);
  const vault = useVaultStore((s) => s.vault);
  const fileTree = useVaultStore((s) => s.fileTree);
  const [preview, setPreview] = useState(EMPTY_LINK_PREVIEW);
  const lastAnchor = useRef<HTMLElement | null>(null);
  const clear = useCallback(() => {
    lastAnchor.current = null;
    setPreview(EMPTY_LINK_PREVIEW);
  }, []);
  const move = useCallback(
    (event: { target: EventTarget | null }) => {
      const anchor = findMarkdownLinkAnchor(event.target);
      if (anchor === lastAnchor.current) return;
      lastAnchor.current = anchor;
      const next = resolveMarkdownLinkPreview(anchor, currentDocumentRelativePath, fileTree, {
        enabled,
        webEnabled,
      });
      // Keep the anchor rect stable across mouse moves so the preview's hover delay
      // does not restart on every pixel of movement over the same link.
      setPreview(next);
    },
    [currentDocumentRelativePath, fileTree, enabled, webEnabled],
  );

  useEffect(clear, [clear, currentDocumentRelativePath, vault, fileTree, enabled, webEnabled]);
  useEffect(() => {
    if (!preview.anchor) return;
    window.addEventListener('scroll', clear, true);
    window.addEventListener('resize', clear);
    return () => {
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
    };
  }, [clear, preview.anchor]);
  return { preview, move, clear };
}
