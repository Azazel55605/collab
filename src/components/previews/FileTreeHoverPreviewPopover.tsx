import { useEffect, useState } from 'react';

import { createPortal } from 'react-dom';

import { FileImage, FileText, Loader2 } from 'lucide-react';

import { getDocumentPreviewDataUrl } from '../../lib/documentPreview';
import type { FilePreviewType } from '../../lib/filePreviewType';
import { getImagePreviewDataUrl } from '../../lib/imagePreview';
import { getPdfPreviewDataUrl } from '../../lib/pdfPreview';
import { createVaultClient } from '../../lib/vaultClient';
import { getVaultDocumentTitle } from '../../lib/vaultLinks';
import { useVaultStore } from '../../store/vaultStore';
import { PreviewCard } from '../ui/popover-patterns';

interface FileTreeHoverPreviewPopoverProps {
  anchorRect: DOMRect | null;
  relativePath: string | null;
  type: FilePreviewType | null;
  placement?: 'side' | 'below';
  enabled: boolean;
}

const HOVER_PREVIEW_DELAY_MS = 180;

export function FileTreeHoverPreviewPopover({
  anchorRect,
  relativePath,
  type,
  enabled,
  placement = 'side',
}: FileTreeHoverPreviewPopoverProps) {
  const vault = useVaultStore((state) => state.vault);
  const [isVisible, setIsVisible] = useState(false);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !anchorRect || !relativePath || !type) {
      setIsVisible(false);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setIsVisible(true);
    }, HOVER_PREVIEW_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
      setIsVisible(false);
    };
  }, [anchorRect, enabled, relativePath, type]);

  useEffect(() => {
    if (!enabled || !isVisible || !vault?.path || !relativePath || !type) {
      setPreviewSrc(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const request = new AbortController();
    setLoading(true);
    setPreviewSrc(null);
    setError(null);

    const client = createVaultClient(vault);
    const loader =
      type === 'pdf'
        ? getPdfPreviewDataUrl(client, relativePath, { signal: request.signal })
        : type === 'document'
          ? getDocumentPreviewDataUrl(client, relativePath, { signal: request.signal })
          : getImagePreviewDataUrl(client, relativePath, { signal: request.signal });

    void loader
      .then((rendered) => {
        if (cancelled) return;
        setPreviewSrc(rendered);
      })
      .catch((nextError) => {
        if (cancelled) return;
        setPreviewSrc(null);
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      request.abort();
    };
  }, [enabled, isVisible, relativePath, type, vault]);

  if (
    !enabled ||
    !anchorRect ||
    !relativePath ||
    !type ||
    !isVisible ||
    typeof document === 'undefined'
  )
    return null;

  const width = Math.min(320, window.innerWidth - 24);
  const preferredLeft = anchorRect.right + 12;
  const fallbackLeft = anchorRect.left - width - 12;
  const opensOnRight = preferredLeft + width + 12 <= window.innerWidth;
  const left =
    placement === 'below'
      ? Math.min(Math.max(12, anchorRect.left), Math.max(12, window.innerWidth - width - 12))
      : opensOnRight
        ? preferredLeft
        : Math.max(12, fallbackLeft);
  const preferredTop = placement === 'below' ? anchorRect.bottom + 10 : anchorRect.top;
  const top = Math.min(Math.max(12, preferredTop), Math.max(12, window.innerHeight - 300));

  return createPortal(
    <PreviewCard
      role="tooltip"
      aria-label="File preview"
      data-preview-path={relativePath}
      style={{ top, left, width }}
      icon={
        loading ? (
          <Loader2 className="animate-spin" />
        ) : type === 'image' ? (
          <FileImage />
        ) : (
          <FileText />
        )
      }
      title={getVaultDocumentTitle(relativePath)}
      detail={relativePath}
      mediaClassName={type === 'pdf' ? 'bg-white/90' : undefined}
      media={
        previewSrc ? (
          <img
            src={previewSrc}
            alt=""
            className="max-h-[min(13rem,calc(100dvh-7rem))] w-full rounded-md object-contain"
            draggable={false}
          />
        ) : undefined
      }
    >
      {previewSrc
        ? undefined
        : loading
          ? `Loading ${type.toUpperCase()} preview…`
          : error
            ? 'Preview unavailable right now.'
            : 'No preview available.'}
    </PreviewCard>,
    document.body,
  );
}
