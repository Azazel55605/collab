import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize2,
  PenLine,
  Plus,
  Save,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  DocumentTopBar,
  DocumentTopBarButton,
  DocumentTopBarIconButton,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../components/layout/DocumentTopBar';
import { ReadOnlyBanner } from '../components/layout/ReadOnlyBanner';
import InkCanvas from '../components/ink/InkCanvas';
import { useEditorStore } from '../store/editorStore';
import { useDocumentStatusRegistration } from '../store/documentStatusStore';
import { useVaultStore } from '../store/vaultStore';
import { isVaultReadOnly } from '../types/vault';
import { INK_LIMITS, INK_SCHEMA_VERSION, INK_UNITS_PER_PX } from '../types/ink';
import type { InkDocument } from '../types/ink';
import type {
  DocumentSessionController,
  DocumentSessionSnapshot,
} from '../lib/documentSessionController';
import { createInkPage } from '../lib/ink/document';
import { addPage, removePage } from '../lib/ink/operations';
import { useInkSession } from '../lib/ink/useInkSession';
import { inkDocumentStats } from '../lib/ink/document';

interface InkViewProps {
  relativePath: string;
}

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8];

/**
 * The `.ink` drawing tab.
 *
 * Phase 2 delivers the document lifecycle: open, display, navigate and manage
 * pages, save, and report status. The tool rail, brushes, erasers, selection,
 * and layers panel are Phase 3 — this view is where they attach.
 */
export default function InkView({ relativePath }: InkViewProps) {
  const { vault } = useVaultStore();
  const { markDirty, setSavedHash, inkViewStates, setInkViewState } = useEditorStore();

  const session = useInkSession({
    vault,
    relativePath,
    markDirty,
    markSaved: (path, hash) => setSavedHash(path, hash),
  });
  const { document } = session;

  const documentStatus = useMemo(
    () => ({
      status: session.status,
      controller: session.controller as DocumentSessionController<unknown>,
      snapshot: session.snapshot as DocumentSessionSnapshot<unknown>,
      onSaveAsNew: session.saveMineAsNew,
      readOnly: session.readOnly,
    }),
    [
      session.controller,
      session.readOnly,
      session.saveMineAsNew,
      session.snapshot,
      session.status,
    ],
  );
  useDocumentStatusRegistration(relativePath, documentStatus);

  // Viewport and current page are device-local: they belong to this machine's
  // editor session, never to the shared document.
  const stored = inkViewStates[relativePath];
  const [pageId, setPageId] = useState<string | null>(stored?.pageId ?? null);
  const [viewport, setViewport] = useState({
    originX: stored?.originX ?? 0,
    originY: stored?.originY ?? 0,
    zoom: stored?.zoom ?? 1,
  });

  const activePageId = useMemo(() => {
    if (!document) return null;
    if (pageId && document.pages[pageId]) return pageId;
    return document.pageOrder[0] ?? null;
  }, [document, pageId]);

  const page = activePageId ? (document?.pages[activePageId] ?? null) : null;
  const pageIndex = activePageId ? (document?.pageOrder.indexOf(activePageId) ?? -1) : -1;

  useEffect(() => {
    if (!activePageId) return;
    setInkViewState(relativePath, {
      pageId: activePageId,
      originX: viewport.originX,
      originY: viewport.originY,
      zoom: viewport.zoom,
    });
  }, [activePageId, relativePath, setInkViewState, viewport]);

  // Repairs applied while opening are surfaced, never silent: the user's file
  // was changed on their behalf and they are entitled to know.
  useEffect(() => {
    if (session.warnings.length === 0) return;
    toast.warning(
      session.warnings.length === 1
        ? session.warnings[0]
        : `This drawing was repaired while opening (${session.warnings.length} issues).`,
      { description: session.warnings.length > 1 ? session.warnings.slice(0, 4).join('\n') : undefined },
    );
  }, [session.warnings]);

  const goToPage = useCallback(
    (index: number) => {
      if (!document) return;
      const next = document.pageOrder[index];
      if (!next) return;
      setPageId(next);
      setViewport((current) => ({ ...current, originX: 0, originY: 0 }));
    },
    [document],
  );

  const zoomBy = useCallback((direction: 1 | -1) => {
    setViewport((current) => {
      const sorted = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
      const next =
        sorted.find((step) => (direction > 0 ? step > current.zoom : step < current.zoom)) ??
        current.zoom;
      return {
        ...current,
        zoom: Math.min(INK_LIMITS.maxZoom, Math.max(INK_LIMITS.minZoom, next)),
      };
    });
  }, []);

  /** Fits the current page into the surface and centres it. */
  const fitPage = useCallback(() => {
    if (!page) return;
    const host = window.document.querySelector<HTMLElement>('[data-testid="ink-canvas-host"]');
    const width = host?.clientWidth ?? 0;
    const height = host?.clientHeight ?? 0;
    if (width === 0 || height === 0) return;

    const zoom = Math.min(
      (width * INK_UNITS_PER_PX) / page.width,
      (height * INK_UNITS_PER_PX) / page.height,
    );
    const clamped = Math.min(INK_LIMITS.maxZoom, Math.max(INK_LIMITS.minZoom, zoom));
    const unitsPerPixel = INK_UNITS_PER_PX / clamped;
    setViewport({
      zoom: clamped,
      originX: (page.width - width * unitsPerPixel) / 2,
      originY: (page.height - height * unitsPerPixel) / 2,
    });
  }, [page]);

  const addNewPage = useCallback(() => {
    if (session.readOnly || !document) return;
    const id = `page-${Date.now().toString(36)}`;
    try {
      session.updateDocument((current: InkDocument) => {
        const template = current.pages[current.pageOrder[current.pageOrder.length - 1]];
        const created = createInkPage(id, { mode: template?.mode ?? 'fixed' });
        const sized = template
          ? { ...created, width: template.width, height: template.height, background: template.background }
          : created;
        return addPage(current, sized, pageIndex + 1).result;
      });
      setPageId(id);
    } catch (error) {
      toast.error(`Could not add a page: ${(error as Error).message}`);
    }
  }, [document, pageIndex, session]);

  const deleteCurrentPage = useCallback(() => {
    if (session.readOnly || !document || !activePageId) return;
    try {
      session.updateDocument((current) => removePage(current, activePageId).result);
      setPageId(null);
    } catch (error) {
      toast.error(`Could not delete the page: ${(error as Error).message}`);
    }
  }, [activePageId, document, session]);

  const stats = useMemo(() => (document ? inkDocumentStats(document) : null), [document]);

  if (session.loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={15} className="animate-spin" />
        Opening drawing…
      </div>
    );
  }

  if (session.error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="max-w-lg text-center text-sm text-destructive">{session.error}</p>
      </div>
    );
  }

  const meta = document ? (
    <>
      <span>
        Page {pageIndex + 1} of {document.pageOrder.length}
      </span>
      {stats ? <span>{stats.strokes.toLocaleString()} strokes</span> : null}
      <span>{Math.round(viewport.zoom * 100)}%</span>
    </>
  ) : undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {isVaultReadOnly(vault) && <ReadOnlyBanner />}
      {session.schemaSupport === 'newer' && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          This drawing was written by a newer version of Collab (schema{' '}
          {session.schemaVersion} against {INK_SCHEMA_VERSION}). It is open read-only
          so nothing that version stored is lost.
        </div>
      )}

      <DocumentTopBar
        icon={<PenLine size={15} className="text-violet-400/80" />}
        title={getDocumentBaseName(relativePath, 'Drawing')}
        subtitle={getDocumentFolderPath(relativePath)}
        meta={meta}
        secondary={(
          <>
            <div className={documentTopBarGroupClass}>
              <DocumentTopBarIconButton
                onClick={() => goToPage(pageIndex - 1)}
                disabled={pageIndex <= 0}
                aria-label="Previous page"
              >
                <ChevronLeft size={14} />
              </DocumentTopBarIconButton>
              <DocumentTopBarIconButton
                onClick={() => goToPage(pageIndex + 1)}
                disabled={!document || pageIndex >= document.pageOrder.length - 1}
                aria-label="Next page"
              >
                <ChevronRight size={14} />
              </DocumentTopBarIconButton>
              <DocumentTopBarButton
                onClick={addNewPage}
                disabled={session.readOnly || !document}
              >
                <Plus size={13} />
                Add page
              </DocumentTopBarButton>
              <DocumentTopBarButton
                onClick={deleteCurrentPage}
                disabled={session.readOnly || !document || document.pageOrder.length <= 1}
              >
                <Trash2 size={13} />
                Delete page
              </DocumentTopBarButton>
            </div>

            <div className={documentTopBarGroupClass}>
              <DocumentTopBarIconButton onClick={() => zoomBy(-1)} aria-label="Zoom out">
                <ZoomOut size={14} />
              </DocumentTopBarIconButton>
              <DocumentTopBarIconButton onClick={() => zoomBy(1)} aria-label="Zoom in">
                <ZoomIn size={14} />
              </DocumentTopBarIconButton>
              <DocumentTopBarButton onClick={fitPage}>
                <Maximize2 size={13} />
                Fit page
              </DocumentTopBarButton>
            </div>

            <div className={documentTopBarGroupClass}>
              <DocumentTopBarButton
                onClick={() => void session.save()}
                disabled={session.readOnly || !session.dirty}
              >
                {session.saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                Save
              </DocumentTopBarButton>
            </div>
          </>
        )}
      />

      <div className="relative flex-1 overflow-hidden">
        <InkCanvas
          page={page}
          originX={viewport.originX}
          originY={viewport.originY}
          zoom={viewport.zoom}
          onViewportChange={setViewport}
          className="absolute inset-0"
        />
        {/* Phase 3 replaces this with the tool rail and properties panel. */}
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border/60 bg-card/80 px-3 py-1 text-[11px] text-muted-foreground shadow-sm">
          Drag to pan, scroll to zoom. Drawing tools arrive in the next phase.
        </div>
      </div>
    </div>
  );
}
