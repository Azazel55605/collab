import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';

import { tauriCommands } from '../../lib/tauri';
import { renderPdfPreviewFromDataUrl } from '../../lib/pdfPreview';
import { getVaultDocumentTitle } from '../../lib/vaultLinks';
import { useVaultStore } from '../../store/vaultStore';

interface PdfLinkPreviewPopoverProps {
  anchorRect: DOMRect | null;
  relativePath: string | null;
  enabled: boolean;
}

export function PdfLinkPreviewPopover({ anchorRect, relativePath, enabled }: PdfLinkPreviewPopoverProps) {
  const vault = useVaultStore((state) => state.vault);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !vault?.path || !relativePath) {
      setPreviewSrc(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void tauriCommands.readNoteAssetDataUrl(vault.path, relativePath)
      .then((dataUrl) => renderPdfPreviewFromDataUrl(dataUrl))
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
  }, [enabled, relativePath, vault?.path]);

  if (!enabled || !anchorRect || !relativePath || typeof document === 'undefined') return null;

  const width = 280;
  const left = Math.min(
    Math.max(12, anchorRect.left),
    Math.max(12, window.innerWidth - width - 12),
  );
  const top = Math.min(anchorRect.bottom + 10, window.innerHeight - 24 - 220);

  return createPortal(
    <div
      className="pointer-events-none fixed z-[120] w-[280px]"
      style={{ top, left }}
    >
      <div className="overflow-hidden rounded-2xl border border-border/60 bg-popover/96 shadow-2xl ring-1 ring-foreground/10 backdrop-blur-sm">
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2.5">
          <div className="flex size-8 items-center justify-center rounded-xl bg-primary/12 text-primary">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">{getVaultDocumentTitle(relativePath)}</div>
            <div className="truncate text-[11px] text-muted-foreground">{relativePath}</div>
          </div>
        </div>
        {previewSrc ? (
          <div className="bg-white/90 p-2">
            <img src={previewSrc} alt="" className="max-h-44 w-full rounded-lg border border-border/50 object-contain" draggable={false} />
          </div>
        ) : (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            {loading ? 'Rendering PDF preview…' : error ? 'Preview unavailable right now.' : 'No preview available.'}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
