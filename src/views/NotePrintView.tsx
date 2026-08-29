import { useCallback, useEffect, useMemo, useState } from 'react';

import { getCurrentWindow } from '@tauri-apps/api/window';
import { Printer, X } from 'lucide-react';

import { MarkdownPreview } from '../components/editor/MarkdownPreview';
import { Button } from '../components/ui/button';
import { resolveNoteAssetTarget } from '../lib/noteAssets';
import { createVaultClient } from '../lib/vaultClient';
import { getVaultDocumentTitle } from '../lib/vaultLinks';
import { useVaultStore } from '../store/vaultStore';
import type { NoteFile, VaultMeta } from '../types/vault';

interface NotePrintViewProps {
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

function stripAssetSuffix(relativePath: string) {
  return relativePath.split(/[?#]/, 1)[0];
}

function splitMarkdownImageDestination(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<')) {
    const end = trimmed.indexOf('>');
    if (end > 0) {
      return {
        path: trimmed.slice(1, end),
        suffix: trimmed.slice(end + 1),
        wrapped: true,
      };
    }
  }
  const match = trimmed.match(/^(\S+)([\s\S]*)$/);
  return {
    path: match?.[1] ?? trimmed,
    suffix: match?.[2] ?? '',
    wrapped: false,
  };
}

async function inlinePrintableImages(
  content: string,
  vault: VaultMeta,
  currentDocumentRelativePath: string,
  fileTree: NoteFile[],
) {
  const client = createVaultClient(vault);
  const replacements = new Map<string, string>();

  async function resolveSource(rawSource: string) {
    if (replacements.has(rawSource)) return replacements.get(rawSource) ?? rawSource;
    const target = resolveNoteAssetTarget(rawSource, currentDocumentRelativePath, fileTree);
    if (!target || target.kind !== 'vault') {
      replacements.set(rawSource, rawSource);
      return rawSource;
    }
    try {
      const dataUrl = await client.readAssetDataUrl(stripAssetSuffix(target.value));
      replacements.set(rawSource, dataUrl);
      return dataUrl;
    } catch {
      replacements.set(rawSource, rawSource);
      return rawSource;
    }
  }

  let next = content;
  const markdownImages = Array.from(content.matchAll(/!\[([^\]]*)\]\(([^)\n]+)\)/g));
  for (const match of markdownImages) {
    const [full, alt, rawDestination] = match;
    const destination = splitMarkdownImageDestination(rawDestination);
    const dataUrl = await resolveSource(destination.path);
    const wrappedDestination = destination.wrapped
      ? `<${dataUrl}>${destination.suffix}`
      : `${dataUrl}${destination.suffix}`;
    next = next.replace(full, `![${alt}](${wrappedDestination})`);
  }

  const htmlImages = Array.from(next.matchAll(/<img\b([^>]*?)\bsrc=(["'])(.*?)\2([^>]*)>/gi));
  for (const match of htmlImages) {
    const [full, before, quote, rawSource, after] = match;
    const dataUrl = await resolveSource(rawSource);
    next = next.replace(full, `<img${before}src=${quote}${dataUrl}${quote}${after}>`);
  }

  return next;
}

export default function NotePrintView({
  relativePath,
  standalone = false,
  onClose,
}: NotePrintViewProps) {
  const vault = useVaultStore((state) => state.vault);
  const fileTree = useVaultStore((state) => state.fileTree);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [didAutoPrint, setDidAutoPrint] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const title = useMemo(() => getVaultDocumentTitle(relativePath), [relativePath]);

  useEffect(() => {
    document.title = `${title} · PDF Export`;
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

    createVaultClient(vault)
      .readDocument(relativePath)
      .then(async (doc) => {
        if (cancelled) return;
        const printableContent = await inlinePrintableImages(
          doc.content,
          vault,
          relativePath,
          fileTree,
        );
        if (cancelled) return;
        setContent(printableContent);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [fileTree, relativePath, vault]);

  const printWhenReady = useCallback(async () => {
    await waitForPrintableFonts();
    window.print();
  }, []);

  const handlePreviewReady = useCallback(() => {
    setPreviewReady(true);
  }, []);

  useEffect(() => {
    if (content === null || !previewReady || didAutoPrint) return;
    const handle = window.setTimeout(() => {
      setDidAutoPrint(true);
      void printWhenReady();
    }, 80);
    return () => window.clearTimeout(handle);
  }, [content, didAutoPrint, previewReady, printWhenReady]);

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
      <div className="note-print-toolbar">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{title}</div>
          <div className="truncate text-xs text-muted-foreground">{relativePath}</div>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void printWhenReady()}>
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

      <div className="note-print-page">
        <div className="note-print-document">
          <div className="note-print-header">
            <h1>{title}</h1>
            <div>{relativePath}</div>
          </div>
          <MarkdownPreview
            content={content}
            currentDocumentRelativePath={relativePath}
            className="note-print-markdown"
            onReady={handlePreviewReady}
          />
        </div>
      </div>
    </div>
  );
}
