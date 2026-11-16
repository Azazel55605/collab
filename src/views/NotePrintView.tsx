import { useCallback, useEffect, useMemo, useState } from 'react';

import { getCurrentWindow } from '@tauri-apps/api/window';
import { Printer, X } from 'lucide-react';

import { NotePageControls } from '../components/editor/NotePageControls';
import { PaginatedNotePreview } from '../components/editor/PaginatedNotePreview';
import { Button } from '../components/ui/button';
import { notePageGeometry } from '../lib/notePageLayout';
import { createVaultClient } from '../lib/vaultClient';
import { getVaultDocumentTitle } from '../lib/vaultLinks';
import { useNotePageStore } from '../store/notePageStore';
import { useVaultStore } from '../store/vaultStore';

interface NotePrintViewProps {
  contentSnapshot?: string;
  relativePath: string;
  standalone?: boolean;
  onClose?: () => void;
}

async function waitForPrintableFonts() {
  const fonts = document.fonts;
  if (!fonts) return;
  try {
    await Promise.race([fonts.ready, new Promise((resolve) => window.setTimeout(resolve, 1600))]);
  } catch {
    // Font readiness is best-effort; do not block printing forever.
  }
}

export default function NotePrintView({
  relativePath,
  standalone = false,
  onClose,
  contentSnapshot,
}: NotePrintViewProps) {
  const vault = useVaultStore((state) => state.vault);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewReady, setPreviewReady] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  const settings = useNotePageStore((state) => state.settings);
  const geometry = notePageGeometry(settings);
  const title = useMemo(() => getVaultDocumentTitle(relativePath), [relativePath]);

  useEffect(() => {
    const previous = document.title;
    const exportTitle = `${title} · PDF Export`;
    document.title = exportTitle;
    return () => {
      if (document.title === exportTitle) document.title = previous;
    };
  }, [title]);

  useEffect(() => {
    document.documentElement.dataset.notePrintMode = 'true';
    return () => {
      delete document.documentElement.dataset.notePrintMode;
    };
  }, []);

  useEffect(() => {
    if (!vault) return;
    let cancelled = false;
    setPreviewReady(false);
    setContent(null);
    setError(null);

    (contentSnapshot === undefined
      ? createVaultClient(vault).readDocument(relativePath)
      : Promise.resolve({ content: contentSnapshot })
    )
      .then((doc) => {
        if (!cancelled) setContent(doc.content);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [relativePath, vault, contentSnapshot]);

  const printWhenReady = useCallback(async () => {
    await waitForPrintableFonts();
    window.print();
  }, []);

  const handlePreviewReady = useCallback((pages: number) => {
    setPageCount(pages);
    setPreviewReady(true);
  }, []);

  useEffect(() => {
    setPreviewReady(false);
  }, [settings]);

  const handleClose = () => {
    if (standalone) {
      void getCurrentWindow()
        .close()
        .catch(() => window.close());
      return;
    }
    onClose?.();
  };

  if (!vault) {
    return (
      <div className="note-print-shell">
        <div className="note-print-state">Opening vault…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="note-print-shell">
        <div className="note-print-state">
          Failed to prepare PDF export.
          <div className="mt-2 text-xs opacity-70">{error}</div>
        </div>
      </div>
    );
  }

  if (content === null) {
    return (
      <div className="note-print-shell">
        <div className="note-print-state">Loading note…</div>
      </div>
    );
  }

  return (
    <div className="note-print-shell">
      <style>{`@page { size: ${geometry.widthMm}mm ${geometry.heightMm}mm; margin: 0; }`}</style>
      <div className="note-print-toolbar">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{title}</div>
          <div className="truncate text-xs text-muted-foreground">{relativePath}</div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!previewReady}
            onClick={() => void printWhenReady()}
          >
            <Printer size={14} />
            Print / Save PDF
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleClose}
            aria-label={standalone ? 'Close export window' : 'Close export preview'}
          >
            <X size={14} />
          </Button>
        </div>
      </div>
      <div className="note-print-layout-toolbar">
        <NotePageControls />
        <span role="status">
          {previewReady ? `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` : 'Preparing pages…'}
        </span>
      </div>
      <PaginatedNotePreview
        content={content}
        relativePath={relativePath}
        settings={settings}
        onReady={handlePreviewReady}
      />
    </div>
  );
}
