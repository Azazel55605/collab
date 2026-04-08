import { useEffect, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { tauriCommands } from '../lib/tauri';
import { useVaultStore } from '../store/vaultStore';

interface Props {
  relativePath: string | null;
}

export default function ImageView({ relativePath }: Props) {
  const { vault } = useVaultStore();
  const [src, setSrc] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vault || !relativePath) {
      setSrc(null);
      setError('No image selected');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);
    setDimensions(null);

    tauriCommands.readNoteAssetDataUrl(vault.path, relativePath)
      .then((dataUrl) => {
        if (cancelled) return;
        setSrc(dataUrl);
      })
      .catch((err) => {
        if (cancelled) return;
        setSrc(null);
        setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [vault, relativePath]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background app-fade-slide-in">
      <div className="flex items-center justify-between border-b border-border/40 bg-sidebar/35 px-4 py-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <ImageIcon size={13} className="shrink-0 text-sky-400/80" />
          <span className="truncate">{relativePath ?? 'Image'}</span>
        </div>
        {dimensions && (
          <span className="shrink-0 tabular-nums">
            {dimensions.width} x {dimensions.height}
          </span>
        )}
      </div>

      <div className="relative flex-1 overflow-auto bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.08)_1px,transparent_0)] [background-size:18px_18px]">
        {loading && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading image…
          </div>
        )}

        {!loading && error && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
            <ImageIcon size={28} className="opacity-35" />
            <p>Failed to load image.</p>
            <p className="text-xs opacity-70">{error}</p>
          </div>
        )}

        {!loading && src && (
          <div className="flex min-h-full items-center justify-center p-6">
            <img
              src={src}
              alt={relativePath ?? 'Image'}
              className="max-h-full max-w-full rounded-lg border border-border/40 bg-background/70 shadow-xl"
              onLoad={(event) => {
                const target = event.currentTarget;
                setDimensions({ width: target.naturalWidth, height: target.naturalHeight });
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
