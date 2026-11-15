import { createPortal } from 'react-dom';

import { Globe, Loader2 } from 'lucide-react';

import { cn } from '../../lib/utils';
import { getWebPreviewHostname, useWebPreview } from '../../lib/webPreviewCache';
import { PreviewCard } from '../ui/popover-patterns';

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
  const description =
    preview?.description?.trim() ||
    preview?.embedBlockReason?.trim() ||
    error ||
    'No preview metadata available for this link.';

  return createPortal(
    <PreviewCard
      style={{ top, left, width }}
      icon={
        preview?.faviconUrl ? (
          <img
            src={preview.faviconUrl}
            alt=""
            className="size-4 rounded-sm object-contain"
            draggable={false}
          />
        ) : loading ? (
          <Loader2 className="animate-spin" />
        ) : (
          <Globe />
        )
      }
      title={title}
      detail={subtitle}
      media={
        preview?.imageUrl ? (
          <img
            src={preview.imageUrl}
            alt=""
            className="h-28 w-full rounded-md object-cover"
            draggable={false}
          />
        ) : undefined
      }
    >
      <span className={cn(loading && 'text-foreground/80')}>
        {loading ? 'Loading preview…' : description}
      </span>
    </PreviewCard>,
    document.body,
  );
}
