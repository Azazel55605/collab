import { createPortal } from 'react-dom';
import { Globe, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { getWebPreviewHostname, useWebPreview } from '../../lib/webPreviewCache';

interface WebLinkPreviewPopoverProps {
  anchorRect: DOMRect | null;
  url: string | null;
  enabled: boolean;
}

export function WebLinkPreviewPopover({ anchorRect, url, enabled }: WebLinkPreviewPopoverProps) {
  const { normalizedUrl, preview, error, loading } = useWebPreview(url, enabled);

  if (!enabled || !anchorRect || !normalizedUrl || typeof document === 'undefined') return null;

  const width = 320;
  const left = Math.min(
    Math.max(12, anchorRect.left),
    Math.max(12, window.innerWidth - width - 12),
  );
  const top = Math.min(anchorRect.bottom + 10, window.innerHeight - 24 - 180);
  const title = preview?.title?.trim() || getWebPreviewHostname(normalizedUrl);
  const subtitle = preview?.siteName?.trim() || normalizedUrl;
  const description = preview?.description?.trim()
    || preview?.embedBlockReason?.trim()
    || error
    || 'No preview metadata available for this link.';

  return createPortal(
    <div
      className="pointer-events-none fixed z-[120] w-80"
      style={{ top, left }}
    >
      <div className="overflow-hidden rounded-2xl border border-border/60 bg-popover/96 shadow-2xl ring-1 ring-foreground/10 backdrop-blur-sm">
        {preview?.imageUrl ? (
          <div className="h-28 w-full border-b border-border/50 bg-muted/20">
            <img src={preview.imageUrl} alt="" className="h-full w-full object-cover" draggable={false} />
          </div>
        ) : null}
        <div className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center overflow-hidden rounded-xl bg-primary/12 text-primary">
              {preview?.faviconUrl ? (
                <img src={preview.faviconUrl} alt="" className="size-4 rounded-sm object-contain" draggable={false} />
              ) : loading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Globe size={14} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">{title}</div>
              <div className="truncate text-[11px] text-muted-foreground">{subtitle}</div>
            </div>
          </div>
          <div className={cn('text-xs leading-relaxed text-muted-foreground', loading && 'text-foreground/80')}>
            {loading ? 'Loading preview…' : description}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
