import { useEffect, useState } from 'react';

import { createPortal } from 'react-dom';

import { FileImage, FileText, Loader2 } from 'lucide-react';

import { getPdfPreviewDataUrl } from '../../lib/pdfPreview';
import { createVaultClient } from '../../lib/vaultClient';
import { getVaultDocumentTitle } from '../../lib/vaultLinks';
import { useVaultStore } from '../../store/vaultStore';

interface FileTreeHoverPreviewPopoverProps {
  anchorRect: DOMRect | null;
  relativePath: string | null;
  type: 'image' | 'pdf' | null;
  enabled: boolean;
}

const HOVER_PREVIEW_DELAY_MS = 180;

export function FileTreeHoverPreviewPopover({
  anchorRect,
  relativePath,
  type,
  enabled,
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
    setLoading(true);
    setError(null);

    const client = createVaultClient(vault);
    const loader =
      type === 'pdf'
        ? getPdfPreviewDataUrl(client, relativePath)
        : client.readAssetDataUrl(relativePath);

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
    };
  }, [enabled, isVisible, relativePath, type, vault?.path]);

  if (
    !enabled ||
    !anchorRect ||
    !relativePath ||
    !type ||
    !isVisible ||
    typeof document === 'undefined'
  )
    return null;

  const width = 320;
  const preferredLeft = anchorRect.right + 12;
  const fallbackLeft = anchorRect.left - width - 12;
  const opensOnRight = preferredLeft + width + 12 <= window.innerWidth;
  const left = opensOnRight ? preferredLeft : Math.max(12, fallbackLeft);
  const top = Math.min(Math.max(12, anchorRect.top), Math.max(12, window.innerHeight - 240));

  return createPortal(
    <div className="pointer-events-none fixed z-[120] w-[320px]" style={{ top, left }}>
      <div
        className="app-fade-scale-in overflow-hidden rounded-2xl border border-border/60 bg-popover/96 shadow-2xl ring-1 ring-foreground/10 backdrop-blur-sm-webkit"
        style={{
          transformOrigin: opensOnRight ? 'left center' : 'right center',
        }}
      >
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2.5">
          <div className="flex size-8 items-center justify-center rounded-xl bg-primary/12 text-primary">
            {loading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : type === 'image' ? (
              <FileImage size={14} />
            ) : (
              <FileText size={14} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              {getVaultDocumentTitle(relativePath)}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">{relativePath}</div>
          </div>
        </div>
        {previewSrc ? (
          <div className={type === 'pdf' ? 'bg-white/90 p-2' : 'bg-background/35 p-2'}>
            <img
              src={previewSrc}
              alt=""
              className="max-h-52 w-full rounded-lg border border-border/50 object-contain"
              draggable={false}
            />
          </div>
        ) : (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            {loading
              ? `Loading ${type.toUpperCase()} preview…`
              : error
                ? 'Preview unavailable right now.'
                : 'No preview available.'}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
