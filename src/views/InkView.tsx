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
import InkTextDialog from '../components/ink/InkTextDialog';
import type { InkTextDraft } from '../components/ink/InkTextDialog';
import { useEditorStore } from '../store/editorStore';
import { useDocumentStatusRegistration } from '../store/documentStatusStore';
import { useVaultStore } from '../store/vaultStore';
import { useUiStore } from '../store/uiStore';
import { isVaultReadOnly } from '../types/vault';
import { INK_LIMITS, INK_SCHEMA_VERSION, INK_UNITS_PER_PX } from '../types/ink';
import type { InkBrushKind, InkDocument, InkSample, InkScene, InkText } from '../types/ink';
import type { InkBrushPreset, InkImage, InkObjectLink, InkStamp, InkSwatch } from '../types/ink';
import type {
  DocumentSessionController,
  DocumentSessionSnapshot,
} from '../lib/documentSessionController';
import { createInkPage, inkDocumentStats, isVaultRelativePath } from '../lib/ink/document';
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
  updatePage,
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
import {
  createInkConnector,
  createInkShape,
  createInkStamp,
  inkObjectColor,
  recognizeInkShape,
  recolorInkObject,
  smoothInkStroke,
  snapInkPoint,
  snapPointToAngle,
} from '../lib/ink/advancedTools';
import { createVaultClient } from '../lib/vaultClient';
import { tauriCommands } from '../lib/tauri';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVaultDocumentTabType, getVaultDocumentView } from '../lib/vaultLinks';
import {
  createInkTemplate,
  deleteInkTemplate,
  instantiateInkTemplate,
  loadInkTemplates,
  parseInkTemplate,
  saveInkTemplate,
  serializeInkTemplate,
} from '../lib/ink/templates';

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
  const setActiveView = useUiStore((state) => state.setActiveView);
  const { markDirty, setSavedHash, inkViewStates, setInkViewState, openTab, setActiveTab } = useEditorStore();
  const vaultClient = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  const readAssetDataUrl = useCallback(
    (path: string) => vaultClient
      ? vaultClient.readAssetDataUrl(path)
      : Promise.reject(new Error('No vault is open.')),
    [vaultClient],
  );

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
  const [textDraft, setTextDraft] = useState<InkTextDraft | null>(null);
  const [templates, setTemplates] = useState(() => loadInkTemplates());

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
    (samples: InkSample[], options?: { straighten?: boolean }) => {
      if (!activeLayerId || samples.length === 0) return;
      const brush = { ...tool.brush };
      commitScene('Draw', (current) => {
        const id = nextId('stroke');
        if (options?.straighten && samples.length >= 2) {
          const shape = createInkShape({
            id,
            layerId: activeLayerId,
            kind: 'line',
            from: samples[0],
            to: samples[samples.length - 1],
            style: { stroke: brush },
            sourceStrokeId: id,
          });
          return addObject(current, shape);
        }
        // A highlighter goes *under* the ink already on its layer — that is
        // what a highlighter is, not a rendering special case.
        const index = drawsBehindInk(brush)
          ? current.objectOrder.findIndex((id) => current.objects[id].layerId === activeLayerId)
          : undefined;
        return addObject(
          current,
          {
            id,
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

  const createAdvancedObject = useCallback(
    (
      kind: 'shape' | 'connector' | 'text' | 'sticky' | 'image' | 'stamp' | 'equation' | 'ruler' | 'protractor' | 'compass' | 'guide',
      rawFrom: { x: number; y: number },
      rawTo: { x: number; y: number },
      uniform: boolean,
    ) => {
      if (!activeLayerId) return;
      const snap = { enabled: tool.snapToGrid, spacing: tool.snapSpacing };
      const from = snapInkPoint(rawFrom, snap);
      const to = snapInkPoint(rawTo, snap);
      const width = Math.max(1_280, Math.abs(to.x - from.x));
      const height = Math.max(960, Math.abs(to.y - from.y));
      const x = Math.min(from.x, to.x);
      const y = Math.min(from.y, to.y);

      if (kind === 'text' || kind === 'sticky' || kind === 'equation') {
        setTextDraft({ kind, x, y, width, height });
        return;
      }

      if (kind === 'image') {
        void (async () => {
          const importer = vaultClient?.runtime?.externalAssetImport;
          if (!importer) return;
          const paths = await tauriCommands.showOpenFilesDialog(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
          const sourcePath = paths?.[0];
          if (!sourcePath) return;
          try {
            const relativePath = await importer.import(sourcePath, 'Pictures');
            const object: InkImage = {
              id: nextId('image'), type: 'image', layerId: activeLayerId,
              x, y, width: Math.max(width, 6_400), height: Math.max(height, 4_800),
              relativePath, createdAt: Date.now(),
            };
            commitScene('Add image', (current) => addObject(current, object));
            setSelectedIds([object.id]);
          } catch (error) {
            toast.error(`Could not add image: ${(error as Error).message}`);
          }
        })();
        return;
      }

      if (kind === 'stamp') {
        const object: InkStamp = createInkStamp({
          id: nextId('stamp'), layerId: activeLayerId, symbolId: tool.stampSymbolId,
          from, to, color: tool.brush.color,
        });
        commitScene('Add stamp', (current) => addObject(current, object));
        setSelectedIds([object.id]);
        return;
      }

      if (kind === 'ruler' || kind === 'protractor' || kind === 'guide') {
        const end = kind === 'protractor' ? snapPointToAngle(from, to, 15) : to;
        const object = createInkShape({
          id: nextId(kind), layerId: activeLayerId, kind: 'line', from, to: end,
          style: {
            stroke: kind === 'guide'
              ? { ...tool.brush, color: '#8b7dff', opacity: 0.75, width: 32, dash: 'dashed' }
              : tool.brush,
          },
        });
        if (kind === 'guide') object.guide = true;
        commitScene(kind === 'guide' ? 'Add guide' : 'Draw precise line', (current) => addObject(current, object));
        setSelectedIds([object.id]);
        return;
      }

      if (kind === 'compass') {
        const radiusX = Math.abs(to.x - from.x);
        const radiusY = Math.abs(to.y - from.y);
        const radius = Math.max(radiusX, radiusY);
        const object = createInkShape({
          id: nextId('compass'), layerId: activeLayerId, kind: 'ellipse',
          from: { x: from.x - radius, y: from.y - radius },
          to: { x: from.x + radius, y: from.y + radius },
          style: { stroke: tool.brush }, uniform: true,
        });
        commitScene('Draw circle', (current) => addObject(current, object));
        setSelectedIds([object.id]);
        return;
      }

      const object = kind === 'connector'
        ? createInkConnector({
            id: nextId('connector'), layerId: activeLayerId, from, to,
            stroke: tool.brush, arrowStart: tool.arrowStart, arrowEnd: tool.arrowEnd === 'none' ? 'arrow' : tool.arrowEnd,
          })
        : createInkShape({
            id: nextId('shape'), layerId: activeLayerId, kind: tool.shapeKind,
            from, to, uniform,
            style: {
              stroke: tool.brush,
              ...(tool.shapeFill ? { fill: tool.shapeFill, fillOpacity: tool.shapeFillOpacity } : {}),
              arrowStart: tool.arrowStart,
              arrowEnd: tool.arrowEnd,
            },
          });
      commitScene(kind === 'connector' ? 'Add connector' : 'Add shape', (current) => addObject(current, object));
      setSelectedIds([object.id]);
    },
    [activeLayerId, commitScene, nextId, tool, vaultClient],
  );

  const createTextFromDraft = useCallback((text: string) => {
    if (!textDraft || !activeLayerId) return;
    const object: InkText = {
      id: nextId(textDraft.kind),
      type: 'text',
      layerId: activeLayerId,
      x: textDraft.x,
      y: textDraft.y,
      width: textDraft.width,
      height: textDraft.height,
      text: text.slice(0, INK_LIMITS.textLength),
      color: tool.brush.color,
      fontSize: 768,
      ...(textDraft.kind === 'sticky' ? { sticky: true, backgroundColor: '#fef3a7' } : {}),
      ...(textDraft.kind === 'equation' ? { equation: true } : {}),
      createdAt: Date.now(),
    };
    commitScene(textDraft.kind === 'sticky' ? 'Add sticky note' : textDraft.kind === 'equation' ? 'Add equation' : 'Add text', (current) => addObject(current, object));
    setSelectedIds([object.id]);
    setTextDraft(null);
  }, [activeLayerId, commitScene, nextId, textDraft, tool.brush.color]);

  const recognizeSelection = useCallback(() => {
    if (!scene || selectedIds.length !== 1) return;
    const id = selectedIds[0];
    const object = scene.objects[id];
    if (object?.type !== 'stroke') return;
    const proposal = recognizeInkShape(object);
    if (!proposal) {
      toast.info('This stroke is not close enough to a supported shape.');
      return;
    }
    commitScene('Recognize shape', (current) => updateObject(current, id, () => proposal));
  }, [commitScene, scene, selectedIds]);

  const smoothSelection = useCallback(() => {
    commitScene('Smooth strokes', (current) => {
      let result = current;
      const edits: Array<InkEdit<InkScene>> = [];
      for (const id of selectedIds) {
        if (result.objects[id]?.type !== 'stroke') continue;
        const edit = updateObject(result, id, (object) => object.type === 'stroke' ? smoothInkStroke(object) : object);
        edits.push(edit);
        result = edit.result;
      }
      return { result, inverse: reverseAll(edits) };
    });
  }, [commitScene, selectedIds]);

  const recolorSelection = useCallback((color: string) => {
    commitScene('Recolor selection', (current) => {
      let result = current;
      const edits: Array<InkEdit<InkScene>> = [];
      for (const id of selectedIds) {
        if (!result.objects[id]) continue;
        const edit = updateObject(result, id, (object) => recolorInkObject(object, color));
        edits.push(edit);
        result = edit.result;
      }
      return { result, inverse: reverseAll(edits) };
    });
  }, [commitScene, selectedIds]);

  const updateSelectedText = useCallback((change: { text?: string; backgroundColor?: string }) => {
    if (selectedIds.length !== 1) return;
    commitScene('Edit text', (current) => updateObject(current, selectedIds[0], (object) =>
      object.type === 'text'
        ? { ...object, ...change, text: (change.text ?? object.text).slice(0, INK_LIMITS.textLength), updatedAt: Date.now() }
        : object,
    ));
  }, [commitScene, selectedIds]);

  const eyedropObject = useCallback((objectId: string) => {
    const object = scene?.objects[objectId];
    if (!object) return;
    const color = inkObjectColor(object);
    if (color) setTool((current) => ({ ...current, brush: { ...current.brush, color }, tool: 'pen' }));
  }, [scene]);

  const activateObjectLink = useCallback((objectId: string) => {
    const link = scene?.objects[objectId]?.link;
    if (!link) return;
    if (link.kind === 'url') {
      void openUrl(link.target).catch((error) => toast.error((error as Error).message));
      return;
    }
    const type = getVaultDocumentTabType(link.target);
    const title = link.target.split('/').pop()?.replace(/\.[^.]+$/, '') ?? link.target;
    openTab(link.target, title, type);
    setActiveTab(link.target);
    setActiveView(getVaultDocumentView(type));
  }, [openTab, scene, setActiveTab, setActiveView]);

  const setSelectedLink = useCallback((target: string | null) => {
    if (selectedIds.length !== 1) return;
    let link: InkObjectLink | undefined;
    if (target) {
      if (isVaultRelativePath(target)) link = { kind: 'vault', target };
      else {
        try {
          const url = new URL(target);
          if (url.protocol !== 'https:') throw new Error('Only HTTPS links are supported.');
          link = { kind: 'url', target: url.toString() };
        } catch {
          toast.error('Use a vault-relative path or a valid HTTPS URL.');
          return;
        }
      }
    }
    commitScene(target ? 'Set link' : 'Remove link', (current) => updateObject(current, selectedIds[0], (object) => ({ ...object, link })));
  }, [commitScene, selectedIds]);

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
        case 'tool.shape':
        case 'tool.connector':
        case 'tool.text':
        case 'tool.image':
        case 'tool.stamp':
        case 'tool.equation':
        case 'tool.ruler':
        case 'tool.protractor':
        case 'tool.compass':
        case 'tool.guide':
        case 'tool.loupe':
        case 'tool.eyedropper':
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
            onCreateAdvancedObject={createAdvancedObject}
            onEyedropObject={eyedropObject}
            onActivateObjectLink={activateObjectLink}
            readAssetDataUrl={readAssetDataUrl}
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
            page={page}
            brushes={document ? Object.values(document.brushes) : []}
            swatches={document?.swatches ?? []}
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
            onAdvancedToolChange={(change) => setTool((current) => ({ ...current, ...change }))}
            onRecognizeSelection={recognizeSelection}
            onSmoothSelection={smoothSelection}
            onRecolorSelection={recolorSelection}
            onUpdateSelectedText={updateSelectedText}
            onPageBackgroundChange={(change) => {
              if (!activePageId) return;
              commit('Change page background', (current) => updatePage(current, activePageId, (currentPage) => ({
                ...currentPage,
                background: { ...currentPage.background, ...change },
              })));
            }}
            onSelectBrushPreset={(preset) => {
              const { id, name: _name, ...brush } = preset;
              setTool((current) => ({ ...current, tool: 'pen', brushId: id, brush: { ...brush, presetId: id } }));
            }}
            onSaveBrushFavorite={() => {
              const id = nextId('brush');
              commit('Save brush favourite', (current) => {
                return setDocumentBrushes(current, {
                    ...current.brushes,
                    [id]: { ...tool.brush, id, name: `${tool.brush.kind} ${Object.keys(current.brushes).length + 1}` },
                  });
              });
              setTool((current) => ({ ...current, brushId: id, brush: { ...current.brush, presetId: id } }));
            }}
            onAddSwatch={() => {
              const id = nextId('swatch');
              commit('Add swatch', (current) => {
                return setDocumentSwatches(current, [...current.swatches, { id, color: tool.brush.color }]);
              });
            }}
            onSetSelectedLink={setSelectedLink}
            templates={templates}
            onSavePageTemplate={(name) => {
              if (!page) return;
              try {
                const template = createInkTemplate(nextId('template'), name, page);
                setTemplates(saveInkTemplate(template));
                toast.success(`Saved drawing template “${template.name}”.`);
              } catch (error) {
                toast.error((error as Error).message);
              }
            }}
            onAddPageFromTemplate={(templateId) => {
              const template = templates.find((entry) => entry.id === templateId);
              if (!template || !document) return;
              const id = nextId('page');
              const templatePage = instantiateInkTemplate(template, id, nextId);
              commit('Add page from template', (current) => addPage(current, templatePage, pageIndex + 1));
              setPageId(id);
            }}
            onDeleteTemplate={(templateId) => setTemplates(deleteInkTemplate(templateId))}
            onImportTemplate={async () => {
              try {
                const paths = await tauriCommands.showOpenFilesDialog(['json', 'ink-template']);
                if (!paths?.[0]) return;
                const payload = await tauriCommands.readFileForUpload(paths[0]);
                const imported = parseInkTemplate(base64ToUtf8(payload.contentBase64));
                const template = { ...imported, id: nextId('template'), createdAt: new Date().toISOString() };
                setTemplates(saveInkTemplate(template));
                toast.success(`Imported drawing template “${template.name}”.`);
              } catch (error) {
                toast.error((error as Error).message);
              }
            }}
            onExportTemplate={async (templateId) => {
              const template = templates.find((entry) => entry.id === templateId);
              if (!template) return;
              try {
                const safeName = template.name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-|-$/g, '') || 'drawing-template';
                const destination = await tauriCommands.showDownloadDialog(`${safeName}.ink-template.json`);
                if (!destination) return;
                await tauriCommands.writeDownloadedFile(destination, utf8ToBase64(serializeInkTemplate(template)));
                toast.success('Drawing template exported.');
              } catch (error) {
                toast.error((error as Error).message);
              }
            }}
          />
        )}
      </div>
      <InkTextDialog
        draft={textDraft}
        onOpenChange={(open) => { if (!open) setTextDraft(null); }}
        onCreate={createTextFromDraft}
      />
    </div>
  );
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUtf8(value: string): string {
  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
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

function setDocumentBrushes(
  document: InkDocument,
  brushes: Record<string, InkBrushPreset>,
): InkEdit<InkDocument> {
  const previous = document.brushes;
  return {
    result: { ...document, brushes },
    inverse: (input) => setDocumentBrushes(input, previous),
  };
}

function setDocumentSwatches(document: InkDocument, swatches: InkSwatch[]): InkEdit<InkDocument> {
  const previous = document.swatches;
  return {
    result: { ...document, swatches },
    inverse: (input) => setDocumentSwatches(input, previous),
  };
}
