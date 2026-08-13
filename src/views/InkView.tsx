import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Group,
  Loader2,
  Maximize2,
  Minimize2,
  PenLine,
  Plus,
  Redo2,
  Save,
  Trash2,
  Ungroup,
  Undo2,
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
import InkToolRail from '../components/ink/InkToolRail';
import InkSidePanel from '../components/ink/InkSidePanel';
import { useEditorStore } from '../store/editorStore';
import { useDocumentStatusRegistration } from '../store/documentStatusStore';
import { useVaultStore } from '../store/vaultStore';
import { isVaultReadOnly } from '../types/vault';
import { INK_LIMITS, INK_SCHEMA_VERSION, INK_UNITS_PER_PX } from '../types/ink';
import type { InkBrushKind, InkDocument, InkSample, InkScene } from '../types/ink';
import type {
  DocumentSessionController,
  DocumentSessionSnapshot,
} from '../lib/documentSessionController';
import { createInkPage, inkDocumentStats } from '../lib/ink/document';
import { INK_DEFAULT_BRUSHES } from '../lib/ink/document';
import {
  addLayer,
  addObject,
  addPage,
  boundsOf,
  groupObjects,
  mergeLayerDown,
  onPage,
  removeLayer,
  removeObjects,
  removePage,
  reorderLayer,
  reorderObjects,
  ungroupObject,
  updateLayer,
  updateObject,
} from '../lib/ink/operations';
import type { InkEdit } from '../lib/ink/operations';
import { encodeSamples } from '../lib/ink/codec';
import { applyErase, planErase } from '../lib/ink/erase';
import type { InkEraserMode } from '../lib/ink/erase';
import { InkHistory } from '../lib/ink/history';
import { copySelection, duplicateSelection, pasteClipboard } from '../lib/ink/clipboard';
import type { InkClipboard } from '../lib/ink/clipboard';
import { alignObjects, distributeObjects } from '../lib/ink/align';
import type { InkAlignment, InkDistribution } from '../lib/ink/align';
import {
  boundsToBounds,
  resizeBounds,
  transformObject,
  translation,
} from '../lib/ink/transform';
import type { InkResizeHandle } from '../lib/ink/transform';
import {
  INK_DEFAULT_PEN_BUTTONS,
  defaultToolState,
  drawsBehindInk,
  resolveInkCommand,
} from '../lib/ink/tools';
import type { InkCommand, InkToolId, InkToolState } from '../lib/ink/tools';
import { useInkSession } from '../lib/ink/useInkSession';

interface InkViewProps {
  relativePath: string;
}

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8];

/** Autosave delay, matching the repo's `saveDebounce`. */
const AUTOSAVE_MS = 600;

/**
 * The `.ink` drawing editor.
 *
 * Owns the tool state, the selection, and the local undo stack; every actual
 * document mutation goes through the pure operations in `src/lib/ink/`, so this
 * file decides *when* an edit happens and never *what* the edit means.
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
    [session.controller, session.readOnly, session.saveMineAsNew, session.snapshot, session.status],
  );
  useDocumentStatusRegistration(relativePath, documentStatus);

  const stored = inkViewStates[relativePath];
  const [pageId, setPageId] = useState<string | null>(stored?.pageId ?? null);
  const [viewport, setViewport] = useState({
    originX: stored?.originX ?? 0,
    originY: stored?.originY ?? 0,
    zoom: stored?.zoom ?? 1,
  });
  const [tool, setTool] = useState<InkToolState>(() => defaultToolState());
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [focusMode, setFocusMode] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);

  const historyRef = useRef(new InkHistory<InkDocument>());
  const clipboardRef = useRef<InkClipboard | null>(null);
  const idCounter = useRef(0);
  const nextId = useCallback((prefix: string) => {
    idCounter.current += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter.current}`;
  }, []);

  const activePageId = useMemo(() => {
    if (!document) return null;
    if (pageId && document.pages[pageId]) return pageId;
    return document.pageOrder[0] ?? null;
  }, [document, pageId]);

  const page = activePageId ? (document?.pages[activePageId] ?? null) : null;
  const pageIndex = activePageId ? (document?.pageOrder.indexOf(activePageId) ?? -1) : -1;
  const scene: InkScene | null = page?.scene ?? null;

  const activeLayerId = useMemo(() => {
    if (!scene) return null;
    if (tool.activeLayerId && scene.layers[tool.activeLayerId]) return tool.activeLayerId;
    return scene.layerOrder[scene.layerOrder.length - 1] ?? null;
  }, [scene, tool.activeLayerId]);

  /* --------------------------------------------------------------------- */
  /* Editing                                                                */
  /* --------------------------------------------------------------------- */

  /**
   * Applies a document edit and records its inverse.
   *
   * Everything that changes the drawing funnels through here, so undo can never
   * miss an edit and the dirty flag can never disagree with the document.
   */
  const commit = useCallback(
    (label: string, operation: (current: InkDocument) => InkEdit<InkDocument>) => {
      if (session.readOnly) return;
      session.updateDocument((current) => {
        const edit = operation(current);
        if (edit.result === current) return current;
        historyRef.current.push(edit, label);
        setHistoryVersion((version) => version + 1);
        return edit.result;
      });
    },
    [session],
  );

  /** Applies a scene edit on the active page. */
  const commitScene = useCallback(
    (label: string, operation: (current: InkScene) => InkEdit<InkScene>) => {
      if (!activePageId) return;
      commit(label, (current) => onPage(current, activePageId, operation));
    },
    [activePageId, commit],
  );

  // A new document invalidates every inverse in the stack: they describe a
  // document that no longer exists.
  useEffect(() => {
    historyRef.current.clear();
    setHistoryVersion((version) => version + 1);
    setSelectedIds([]);
  }, [relativePath]);

  const undo = useCallback(() => {
    if (session.readOnly) return;
    session.updateDocument((current) => {
      const reverted = historyRef.current.undo(current);
      setHistoryVersion((version) => version + 1);
      return reverted ?? current;
    });
    setSelectedIds([]);
  }, [session]);

  const redo = useCallback(() => {
    if (session.readOnly) return;
    session.updateDocument((current) => {
      const reapplied = historyRef.current.redo(current);
      setHistoryVersion((version) => version + 1);
      return reapplied ?? current;
    });
    setSelectedIds([]);
  }, [session]);

  const history = useMemo(
    () => historyRef.current.snapshot(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyVersion],
  );

  /* --------------------------------------------------------------------- */
  /* Drawing                                                                */
  /* --------------------------------------------------------------------- */

  const commitStroke = useCallback(
    (samples: InkSample[]) => {
      if (!activeLayerId || samples.length === 0) return;
      const brush = { ...tool.brush };
      commitScene('Draw', (current) => {
        // A highlighter goes *under* the ink already on its layer — that is
        // what a highlighter is, not a rendering special case.
        const index = drawsBehindInk(brush)
          ? current.objectOrder.findIndex((id) => current.objects[id].layerId === activeLayerId)
          : undefined;
        return addObject(
          current,
          {
            id: nextId('stroke'),
            type: 'stroke',
            layerId: activeLayerId,
            brush,
            samples: encodeSamples(samples),
            createdAt: Date.now(),
          },
          index === undefined || index < 0 ? undefined : index,
        );
      });
    },
    [activeLayerId, commitScene, nextId, tool.brush],
  );

  const erase = useCallback(
    (path: Array<{ x: number; y: number }>, radius: number) => {
      if (!scene) return;
      const plan = planErase(scene, path, radius, tool.eraserMode);
      if (plan.removedIds.length === 0 && plan.replacements.length === 0) return;
      commitScene('Erase', (current) => applyErase(current, plan));
    },
    [commitScene, scene, tool.eraserMode],
  );

  /* --------------------------------------------------------------------- */
  /* Selection                                                              */
  /* --------------------------------------------------------------------- */

  const changeSelection = useCallback((ids: string[], additive: boolean) => {
    setSelectedIds((current) => {
      if (!additive) return ids;
      const merged = new Set(current);
      for (const id of ids) {
        if (merged.has(id)) merged.delete(id);
        else merged.add(id);
      }
      return [...merged];
    });
  }, []);

  const moveSelection = useCallback(
    (dx: number, dy: number) => {
      if (selectedIds.length === 0) return;
      commitScene('Move', (current) => {
        const edits: Array<InkEdit<InkScene>> = [];
        let result = current;
        for (const id of selectedIds) {
          if (!result.objects[id]) continue;
          const edit = updateObject(result, id, (object) =>
            transformObject(object, translation(dx, dy)),
          );
          edits.push(edit);
          result = edit.result;
        }
        return { result, inverse: reverseAll(edits) };
      });
    },
    [commitScene, selectedIds],
  );

  const resizeSelection = useCallback(
    (handle: InkResizeHandle, dx: number, dy: number, uniform: boolean) => {
      if (selectedIds.length === 0 || !scene) return;
      const before = boundsOf(scene, selectedIds);
      if (!before) return;
      const after = resizeBounds(before, handle, dx, dy, uniform);
      const transform = boundsToBounds(before, after);

      commitScene('Resize', (current) => {
        const edits: Array<InkEdit<InkScene>> = [];
        let result = current;
        for (const id of selectedIds) {
          if (!result.objects[id]) continue;
          const edit = updateObject(result, id, (object) => transformObject(object, transform));
          edits.push(edit);
          result = edit.result;
        }
        return { result, inverse: reverseAll(edits) };
      });
    },
    [commitScene, scene, selectedIds],
  );

  const deleteSelection = useCallback(() => {
    if (selectedIds.length === 0) return;
    commitScene('Delete', (current) => removeObjects(current, selectedIds));
    setSelectedIds([]);
  }, [commitScene, selectedIds]);

  /* --------------------------------------------------------------------- */
  /* Clipboard                                                              */
  /* --------------------------------------------------------------------- */

  const copy = useCallback(() => {
    if (!scene) return;
    clipboardRef.current = copySelection(scene, selectedIds);
  }, [scene, selectedIds]);

  const paste = useCallback(() => {
    const clipboard = clipboardRef.current;
    if (!clipboard || !activeLayerId) return;
    try {
      let pastedIds: string[] = [];
      commitScene('Paste', (current) => {
        const edit = pasteClipboard(current, clipboard, {
          layerId: activeLayerId,
          makeId: (_original, index) => nextId(`paste-${index}`),
        });
        pastedIds = edit.pastedIds;
        return edit;
      });
      setSelectedIds(pastedIds);
    } catch (error) {
      toast.error((error as Error).message);
    }
  }, [activeLayerId, commitScene, nextId]);

  const duplicate = useCallback(() => {
    if (!scene || !activeLayerId || selectedIds.length === 0) return;
    try {
      let pastedIds: string[] = [];
      commitScene('Duplicate', (current) => {
        const edit = duplicateSelection(current, selectedIds, activeLayerId, (_original, index) =>
          nextId(`copy-${index}`),
        );
        if (!edit) return { result: current, inverse: (input) => ({ result: input, inverse: noop }) };
        pastedIds = edit.pastedIds;
        return edit;
      });
      if (pastedIds.length > 0) setSelectedIds(pastedIds);
    } catch (error) {
      toast.error((error as Error).message);
    }
  }, [activeLayerId, commitScene, nextId, scene, selectedIds]);

  /* --------------------------------------------------------------------- */
  /* Layers and pages                                                       */
  /* --------------------------------------------------------------------- */

  const layerActions = useMemo(
    () => ({
      add: () => {
        const id = nextId('layer');
        commitScene('Add layer', (current) =>
          addLayer(current, {
            id,
            name: `Layer ${current.layerOrder.length + 1}`,
            visible: true,
            locked: false,
            opacity: 1,
          }),
        );
        setTool((current) => ({ ...current, activeLayerId: id }));
      },
      toggleVisible: (layerId: string) =>
        commitScene('Layer visibility', (current) =>
          updateLayer(current, layerId, (layer) => ({ ...layer, visible: !layer.visible })),
        ),
      toggleLocked: (layerId: string) =>
        commitScene('Lock layer', (current) =>
          updateLayer(current, layerId, (layer) => ({ ...layer, locked: !layer.locked })),
        ),
      rename: (layerId: string, name: string) =>
        commitScene('Rename layer', (current) =>
          updateLayer(current, layerId, (layer) => ({ ...layer, name })),
        ),
      reorder: (layerId: string, direction: 1 | -1) =>
        commitScene('Reorder layer', (current) => {
          const from = current.layerOrder.indexOf(layerId);
          return reorderLayer(current, layerId, from + direction);
        }),
      merge: (layerId: string) =>
        commitScene('Merge layer', (current) => mergeLayerDown(current, layerId)),
      remove: (layerId: string) => {
        try {
          commitScene('Delete layer', (current) => removeLayer(current, layerId));
        } catch (error) {
          toast.error((error as Error).message);
        }
      },
    }),
    [commitScene, nextId],
  );

  const goToPage = useCallback(
    (index: number) => {
      if (!document) return;
      const next = document.pageOrder[index];
      if (!next) return;
      setPageId(next);
      setSelectedIds([]);
      setViewport((current) => ({ ...current, originX: 0, originY: 0 }));
    },
    [document],
  );

  const addNewPage = useCallback(() => {
    if (!document) return;
    const id = nextId('page');
    commit('Add page', (current) => {
      const template = current.pages[current.pageOrder[current.pageOrder.length - 1]];
      const created = createInkPage(id, { mode: template?.mode ?? 'fixed' });
      const sized = template
        ? { ...created, width: template.width, height: template.height, background: template.background }
        : created;
      return addPage(current, sized, pageIndex + 1);
    });
    setPageId(id);
  }, [commit, document, nextId, pageIndex]);

  const deleteCurrentPage = useCallback(() => {
    if (!document || !activePageId) return;
    try {
      commit('Delete page', (current) => removePage(current, activePageId));
      setPageId(null);
    } catch (error) {
      toast.error((error as Error).message);
    }
  }, [activePageId, commit, document]);

  /* --------------------------------------------------------------------- */
  /* View                                                                   */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    if (!activePageId) return;
    setInkViewState(relativePath, {
      pageId: activePageId,
      originX: viewport.originX,
      originY: viewport.originY,
      zoom: viewport.zoom,
    });
  }, [activePageId, relativePath, setInkViewState, viewport]);

  useEffect(() => {
    if (session.warnings.length === 0) return;
    toast.warning(
      session.warnings.length === 1
        ? session.warnings[0]
        : `This drawing was repaired while opening (${session.warnings.length} issues).`,
      {
        description:
          session.warnings.length > 1 ? session.warnings.slice(0, 4).join('\n') : undefined,
      },
    );
  }, [session.warnings]);

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

  /* --------------------------------------------------------------------- */
  /* Autosave                                                               */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    if (!session.dirty || session.readOnly) return;
    const timer = window.setTimeout(() => {
      void session.save();
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [session]);

  /* --------------------------------------------------------------------- */
  /* Keyboard                                                               */
  /* --------------------------------------------------------------------- */

  const runCommand = useCallback(
    (command: InkCommand) => {
      switch (command) {
        case 'tool.pen':
        case 'tool.eraser':
        case 'tool.select':
        case 'tool.lasso':
        case 'tool.pan':
          setTool((current) => ({ ...current, tool: command.split('.')[1] as InkToolId }));
          return true;
        case 'edit.undo': undo(); return true;
        case 'edit.redo': redo(); return true;
        case 'edit.delete': deleteSelection(); return true;
        case 'edit.selectAll':
          setSelectedIds(scene ? [...scene.objectOrder] : []);
          return true;
        case 'edit.copy': copy(); return true;
        case 'edit.cut': copy(); deleteSelection(); return true;
        case 'edit.paste': paste(); return true;
        case 'edit.duplicate': duplicate(); return true;
        case 'edit.group':
          if (selectedIds.length > 1) {
            commitScene('Group', (current) => groupObjects(current, selectedIds, nextId('group')));
          }
          return true;
        case 'edit.ungroup':
          for (const id of selectedIds) {
            if (scene?.objects[id]?.type === 'group') {
              commitScene('Ungroup', (current) => ungroupObject(current, id));
            }
          }
          return true;
        case 'order.front':
          commitScene('Bring to front', (current) => reorderObjects(current, selectedIds, 'front'));
          return true;
        case 'order.back':
          commitScene('Send to back', (current) => reorderObjects(current, selectedIds, 'back'));
          return true;
        case 'view.zoomIn': zoomBy(1); return true;
        case 'view.zoomOut': zoomBy(-1); return true;
        case 'view.fitPage': fitPage(); return true;
        case 'view.focusMode': setFocusMode((current) => !current); return true;
        case 'page.next': goToPage(pageIndex + 1); return true;
        case 'page.previous': goToPage(pageIndex - 1); return true;
        case 'document.save': void session.save(); return true;
        default:
          return false;
      }
    },
    [commitScene, copy, deleteSelection, duplicate, fitPage, goToPage, nextId, pageIndex, paste, redo, scene, selectedIds, session, undo, zoomBy],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal a key from a field the user is typing in.
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        return;
      }
      const command = resolveInkCommand(event);
      if (!command) return;
      if (runCommand(command)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [runCommand]);

  /* --------------------------------------------------------------------- */
  /* Render                                                                 */
  /* --------------------------------------------------------------------- */

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
      {selectedIds.length > 0 ? <span>{selectedIds.length} selected</span> : null}
      <span>{Math.round(viewport.zoom * 100)}%</span>
    </>
  ) : undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {isVaultReadOnly(vault) && <ReadOnlyBanner />}
      {session.schemaSupport === 'newer' && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
          This drawing was written by a newer version of Collab (schema{' '}
          {session.schemaVersion} against {INK_SCHEMA_VERSION}). It is open read-only so
          nothing that version stored is lost.
        </div>
      )}

      {!focusMode && (
        <DocumentTopBar
          icon={<PenLine size={15} className="text-violet-400/80" />}
          title={getDocumentBaseName(relativePath, 'Drawing')}
          subtitle={getDocumentFolderPath(relativePath)}
          meta={meta}
          secondary={(
            <>
              <div className={documentTopBarGroupClass}>
                <DocumentTopBarIconButton
                  onClick={undo}
                  disabled={session.readOnly || !history.canUndo}
                  aria-label={history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo'}
                >
                  <Undo2 size={14} />
                </DocumentTopBarIconButton>
                <DocumentTopBarIconButton
                  onClick={redo}
                  disabled={session.readOnly || !history.canRedo}
                  aria-label={history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo'}
                >
                  <Redo2 size={14} />
                </DocumentTopBarIconButton>
              </div>

              <div className={documentTopBarGroupClass}>
                <DocumentTopBarButton
                  onClick={duplicate}
                  disabled={session.readOnly || selectedIds.length === 0}
                >
                  <Copy size={13} />
                  Duplicate
                </DocumentTopBarButton>
                <DocumentTopBarButton
                  onClick={() => runCommand('edit.group')}
                  disabled={session.readOnly || selectedIds.length < 2}
                >
                  <Group size={13} />
                  Group
                </DocumentTopBarButton>
                <DocumentTopBarButton
                  onClick={() => runCommand('edit.ungroup')}
                  disabled={session.readOnly || selectedIds.length === 0}
                >
                  <Ungroup size={13} />
                  Ungroup
                </DocumentTopBarButton>
                <DocumentTopBarButton
                  onClick={deleteSelection}
                  disabled={session.readOnly || selectedIds.length === 0}
                >
                  <Trash2 size={13} />
                  Delete
                </DocumentTopBarButton>
              </div>

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
                <DocumentTopBarButton onClick={addNewPage} disabled={session.readOnly || !document}>
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
                <DocumentTopBarButton onClick={() => setFocusMode(true)} aria-label="Focus mode">
                  <Minimize2 size={13} />
                  Focus
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
      )}

      <div className="flex min-h-0 flex-1">
        {!focusMode && (
          <InkToolRail
            tool={tool}
            readOnly={session.readOnly}
            onSelectTool={(next) => setTool((current) => ({ ...current, tool: next }))}
            onSelectBrush={(kind: InkBrushKind) =>
              setTool((current) => ({
                ...current,
                tool: 'pen',
                brushId: kind,
                brush: { ...(INK_DEFAULT_BRUSHES[kind] ?? current.brush) },
              }))
            }
          />
        )}

        <div className="relative min-w-0 flex-1 overflow-hidden">
          <InkCanvas
            page={page}
            originX={viewport.originX}
            originY={viewport.originY}
            zoom={viewport.zoom}
            tool={{ ...tool, activeLayerId }}
            penButtons={INK_DEFAULT_PEN_BUTTONS}
            selectedIds={selectedIds}
            readOnly={session.readOnly}
            onViewportChange={setViewport}
            onCommitStroke={commitStroke}
            onErase={erase}
            onSelectionChange={changeSelection}
            onMoveSelection={moveSelection}
            onResizeSelection={resizeSelection}
            className="absolute inset-0"
          />
          {focusMode && (
            <button
              type="button"
              onClick={() => setFocusMode(false)}
              aria-label="Leave focus mode"
              className="absolute right-3 top-3 rounded-full border border-border/60 bg-card/80 p-1.5 text-muted-foreground shadow-sm transition-colors app-motion-fast hover:text-foreground"
            >
              <Maximize2 size={14} />
            </button>
          )}
        </div>

        {!focusMode && (
          <InkSidePanel
            scene={scene}
            tool={tool}
            readOnly={session.readOnly}
            selectedIds={selectedIds}
            activeLayerId={activeLayerId}
            onBrushChange={(change) =>
              setTool((current) => ({ ...current, brush: { ...current.brush, ...change } }))
            }
            onEraserChange={(change: { mode?: InkEraserMode; radius?: number }) =>
              setTool((current) => ({
                ...current,
                eraserMode: change.mode ?? current.eraserMode,
                eraserRadius: change.radius ?? current.eraserRadius,
              }))
            }
            onActiveLayerChange={(layerId) =>
              setTool((current) => ({ ...current, activeLayerId: layerId }))
            }
            onAddLayer={layerActions.add}
            onToggleLayerVisible={layerActions.toggleVisible}
            onToggleLayerLocked={layerActions.toggleLocked}
            onRenameLayer={layerActions.rename}
            onReorderLayer={layerActions.reorder}
            onMergeLayerDown={layerActions.merge}
            onDeleteLayer={layerActions.remove}
            onAlign={(alignment: InkAlignment) =>
              commitScene('Align', (current) => alignObjects(current, selectedIds, alignment))
            }
            onDistribute={(axis: InkDistribution) =>
              commitScene('Distribute', (current) => distributeObjects(current, selectedIds, axis))
            }
          />
        )}
      </div>
    </div>
  );
}

/** Undoes a batch of scene edits in reverse order. */
function reverseAll(edits: Array<InkEdit<InkScene>>) {
  return (input: InkScene): InkEdit<InkScene> => {
    let reverted = input;
    for (let index = edits.length - 1; index >= 0; index -= 1) {
      reverted = edits[index].inverse(reverted).result;
    }
    return { result: reverted, inverse: (next) => ({ result: next, inverse: noop }) };
  };
}

function noop<T>(input: T): InkEdit<T> {
  return { result: input, inverse: noop };
}
