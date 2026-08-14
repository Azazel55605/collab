/**
 * Mobile `.ink` drawing screen (Phase 4, Digital Ink).
 *
 * Bounded in the same spirit as the mobile workbook screen: this is for
 * *drawing*, which is what a phone or tablet with a pen is genuinely better at
 * than a laptop. Selection, transforms, grouping, alignment, and clipboard stay
 * desktop capabilities — they need precision a fingertip does not have, and
 * leaving them out keeps the surface uncluttered rather than cramming a desktop
 * toolbar onto a phone.
 *
 * Everything about the document is shared with desktop: schema, normalization,
 * operations, erasing, capture, rendering, and the tool model. The load/save
 * lifecycle follows the same REST-with-offline-queue path as the note, Kanban,
 * and workbook screens, with the shared Ink CRDT taking over while a live
 * document session is available.
 */

import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  Eraser,
  Hand,
  Layers,
  Maximize2,
  PenLine,
  Plus,
  Redo2,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Banner, ReadOnlyBadge, Spinner } from '../components/ui';
import { InkTouchCanvas } from '../components/InkTouchCanvas';
import { useBackDismiss } from '../lib/backStack';
import { isReadOnlyRole } from '../lib/format';
import {
  clampInkScale,
  drawingName,
  INK_MOBILE_SCALE,
  inspectInkContent,
  loadInkViewState,
  readInkDrawing,
  saveInkDrawing,
  saveInkViewState,
  serializeInk,
  type InkDocument,
} from '../lib/ink';
import {
  openMobileLiveJsonSession,
  type JsonObject,
  type LiveStatus,
  type MobileLiveJsonSession,
} from '../lib/liveNote';
import {
  enqueueDocumentEdit,
  isLikelyConnectivityError,
  pendingEditsForFile,
} from '../lib/sync';
import { replicaCacheDocument, type HostedFileEntry, type PendingOperation } from '../mobileTauri';
import { useMobileStore } from '../state/store';
import { INK_UNITS_PER_PX } from '../../../../src/types/ink';
import type { InkBrushKind, InkSample, InkScene } from '../../../../src/types/ink';
import { INK_DEFAULT_BRUSHES, createInkPage, inkDocumentStats } from '../../../../src/lib/ink/document';
import { encodeSamples } from '../../../../src/lib/ink/codec';
import { addObject, addPage, onPage } from '../../../../src/lib/ink/operations';
import type { InkEdit } from '../../../../src/lib/ink/operations';
import { applyErase, planErase } from '../../../../src/lib/ink/erase';
import type { InkEraserMode } from '../../../../src/lib/ink/erase';
import { InkHistory } from '../../../../src/lib/ink/history';
import {
  INK_BRUSH_ORDER,
  INK_BRUSH_WIDTHS,
  INK_DEFAULT_SWATCHES,
  INK_ERASER_SIZES,
  defaultToolState,
  drawsBehindInk,
} from '../../../../src/lib/ink/tools';
import type { InkToolState } from '../../../../src/lib/ink/tools';
import type { InkInputSettings } from '../../../../src/lib/ink/pointer';
import { useLivePeers, type InkInteraction } from '../../../../src/lib/liveAwareness';
import { userColorForId } from '../../../../src/lib/userColor';
import { inkColorLabel, inkPaletteForTheme, resolveInkColor } from '../../../../src/lib/ink/colors';
import type { Theme } from '../lib/theme';

const SAVE_DEBOUNCE_MS = 600;

type ActivePanel = 'none' | 'brush' | 'eraser' | 'layers';

export function InkScreen({ file, theme = 'dark' }: { file: HostedFileEntry; theme?: Theme }) {
  const selected = useMobileStore((s) => s.selected);
  const statuses = useMobileStore((s) => s.statuses);
  const closeSheet = useMobileStore((s) => s.closeSheet);
  const replaceFile = useMobileStore((s) => s.replaceFile);

  const serverUrl = selected?.serverUrl ?? '';
  const vaultId = selected?.vault.id ?? '';
  const connected = selected ? !!statuses[serverUrl]?.connected : false;
  const vaultReadOnly = selected ? isReadOnlyRole(selected.vault.role) : true;
  const manifestSequence = selected?.vault.manifestSequence ?? 0;

  const [document, setDocument] = useState<InkDocument | null>(null);
  const [schemaNewer, setSchemaNewer] = useState(false);
  const [repairs, setRepairs] = useState<string[]>([]);
  const [currentFile, setCurrentFile] = useState(file);
  const [pageId, setPageId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<{ originX: number; originY: number; zoom: number }>({
    originX: 0,
    originY: 0,
    zoom: INK_MOBILE_SCALE.default,
  });
  const [tool, setTool] = useState<InkToolState>(() => defaultToolState());
  const [panel, setPanel] = useState<ActivePanel>('none');
  const [fingerDrawing, setFingerDrawing] = useState(false);
  const [source, setSource] = useState<'network' | 'cache'>('network');
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [liveSession, setLiveSession] = useState<MobileLiveJsonSession | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);

  const readOnly = vaultReadOnly || schemaNewer;
  const localUser = statuses[serverUrl]?.user;
  const localUserId = localUser?.id ?? 'mobile';
  const remotePeers = useLivePeers(liveSession);

  const documentRef = useRef<InkDocument | null>(null);
  documentRef.current = document;
  const fileRef = useRef(currentFile);
  fileRef.current = currentFile;
  const savedContentRef = useRef('');
  const savingRef = useRef(false);
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const mountedRef = useRef(true);
  const saveTimerRef = useRef<number | null>(null);
  const historyRef = useRef(new InkHistory<InkDocument>());
  const liveSessionRef = useRef<MobileLiveJsonSession | null>(null);
  liveSessionRef.current = liveSession;
  const idCounter = useRef(0);
  const awarenessSentAtRef = useRef(0);

  const nextId = useCallback((prefix: string) => {
    idCounter.current += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter.current}`;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Back closes an open panel before it closes the drawing.
  useBackDismiss(panel !== 'none', () => setPanel('none'));

  const markSaved = useCallback((content: string) => {
    savedContentRef.current = content;
  }, []);

  /* --------------------------------------------------------------------- */
  /* Load                                                                   */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!selected) return;
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const loaded = await readInkDrawing(serverUrl, vaultId, file, connected);
        if (cancelled) return;
        if (liveSessionRef.current) return;
        setCurrentFile(loaded.file);
        setDocument(loaded.document);
        setSchemaNewer(loaded.support === 'newer');
        setRepairs(loaded.warnings);
        markSaved(serializeInk(loaded.document));
        setSource(loaded.source);

        // Android recreates the activity freely; restoring the page and
        // viewport is what stops a rotation feeling like the drawing reset.
        const restored = loadInkViewState(file.id);
        if (restored && restored.pageId && loaded.document.pages[restored.pageId]) {
          setPageId(restored.pageId);
          setViewport({
            originX: restored.originX,
            originY: restored.originY,
            zoom: restored.zoom,
          });
        } else {
          setPageId(loaded.document.pageOrder[0] ?? null);
        }

        const queued = await pendingEditsForFile(serverUrl, vaultId, file.id).catch(
          () => [] as PendingOperation[],
        );
        if (!cancelled) setPending(queued[0] ?? null);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // Keyed on the file *id*, not the entry object. Saving calls `replaceFile`,
    // which hands this screen a fresh `HostedFileEntry` for the same document —
    // depending on that object identity reloaded the whole drawing after every
    // save, which is what made the canvas flash back to a spinner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, file.id, selected?.serverUrl, selected?.vault.id]);

  useEffect(() => {
    let cancelled = false;
    let opened: MobileLiveJsonSession | null = null;
    let offStatus: (() => void) | undefined;
    let offChange: (() => void) | undefined;

    setLiveSession(null);
    setLiveStatus(null);
    if (!selected || !connectedRef.current || schemaNewer) {
      return () => {
        cancelled = true;
      };
    }

    const applyLiveDocument = (value: JsonObject, nextSource: 'network' | 'cache') => {
      if (Object.keys(value).length === 0) return;
      const inspected = inspectInkContent(JSON.stringify(value));
      if (inspected.support === 'newer') {
        setSchemaNewer(true);
        return;
      }
      const content = serializeInk(inspected.document);
      documentRef.current = inspected.document;
      setDocument(inspected.document);
      setRepairs(inspected.warnings);
      markSaved(content);
      setSource(nextSource);
      setError(null);
      setPageId((previous) =>
        previous && inspected.document.pages[previous]
          ? previous
          : (inspected.document.pageOrder[0] ?? null),
      );
      void replicaCacheDocument(serverUrl, vaultId, file.id, content).catch(() => {});
    };

    openMobileLiveJsonSession(serverUrl, vaultId, file.id, 'ink')
      .then((session) => {
        if (cancelled || !session) {
          session?.destroy();
          return;
        }
        opened = session;
        setLiveSession(session);
        setLiveStatus(session.getStatus());
        offStatus = session.onStatus((status) => {
          if (!cancelled) setLiveStatus(status);
        });
        applyLiveDocument(session.readJson(), 'network');
        offChange = session.onChange((json) => {
          if (!cancelled) {
            applyLiveDocument(json, session.getStatus() === 'connected' ? 'network' : 'cache');
          }
        });
      })
      .catch(() => {
        // Best effort. REST plus the durable offline queue remains available.
      });

    return () => {
      cancelled = true;
      offChange?.();
      offStatus?.();
      opened?.destroy();
      setLiveSession(null);
      setLiveStatus(null);
    };
  }, [file.id, markSaved, schemaNewer, selected?.serverUrl, selected?.vault.id, serverUrl, vaultId]);

  const activePageId = useMemo(() => {
    if (!document) return null;
    if (pageId && document.pages[pageId]) return pageId;
    return document.pageOrder[0] ?? null;
  }, [document, pageId]);

  const page = activePageId ? (document?.pages[activePageId] ?? null) : null;
  const colorPalette = useMemo(
    () => inkPaletteForTheme(theme, page?.background.color),
    [page?.background.color, theme],
  );
  const pageIndex = activePageId ? (document?.pageOrder.indexOf(activePageId) ?? -1) : -1;
  const scene: InkScene | null = page?.scene ?? null;

  const activeLayerId = useMemo(() => {
    if (!scene) return null;
    if (tool.activeLayerId && scene.layers[tool.activeLayerId]) return tool.activeLayerId;
    return scene.layerOrder[scene.layerOrder.length - 1] ?? null;
  }, [scene, tool.activeLayerId]);

  useEffect(() => {
    if (!activePageId) return;
    saveInkViewState(file.id, {
      pageId: activePageId,
      originX: viewport.originX,
      originY: viewport.originY,
      zoom: viewport.zoom,
    });
  }, [activePageId, file.id, viewport]);

  /* --------------------------------------------------------------------- */
  /* Save                                                                   */
  /* --------------------------------------------------------------------- */

  const queueOffline = useCallback(
    async (content: string) => {
      const operation = await enqueueDocumentEdit(
        serverUrl,
        vaultId,
        fileRef.current,
        content,
        manifestSequence,
      );
      markSaved(content);
      if (!mountedRef.current) return;
      setSource('cache');
      setPending(operation);
      setMessage('Saved offline. This drawing will sync when you reconnect.');
    },
    [manifestSequence, markSaved, serverUrl, vaultId],
  );

  const flushSave = useCallback(async () => {
    const current = documentRef.current;
    if (!current || savingRef.current || readOnlyRef.current || liveSessionRef.current) return;
    const content = serializeInk(current);
    if (content === savedContentRef.current) return;
    savingRef.current = true;
    if (mountedRef.current) setSaving(true);
    try {
      if (connectedRef.current) {
        try {
          const saved = await saveInkDrawing(serverUrl, vaultId, fileRef.current, current);
          fileRef.current = saved.file;
          markSaved(content);
          if (mountedRef.current) {
            setCurrentFile(saved.file);
            setSource('network');
            setPending(null);
          }
          replaceFile(saved.file);
        } catch (reason) {
          if (!isLikelyConnectivityError(reason)) throw reason;
          await queueOffline(content);
        }
      } else {
        await queueOffline(content);
      }
    } catch (reason) {
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
    const latest = documentRef.current;
    if (latest && serializeInk(latest) !== savedContentRef.current) void flushSave();
  }, [markSaved, queueOffline, replaceFile, serverUrl, vaultId]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Leaving the screen must not lose an unsaved stroke — Android can tear the
  // activity down between the debounce firing and the write starting.
  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const latest = documentRef.current;
      if (latest && serializeInk(latest) !== savedContentRef.current) void flushSave();
    },
    [flushSave],
  );

  /* --------------------------------------------------------------------- */
  /* Editing                                                                */
  /* --------------------------------------------------------------------- */

  const commit = useCallback(
    (label: string, operation: (current: InkDocument) => InkEdit<InkDocument>) => {
      if (readOnly) return;
      const current = documentRef.current;
      if (!current) return;
      const edit = operation(current);
      if (edit.result === current) return;
      historyRef.current.push(edit, label);
      setHistoryVersion((version) => version + 1);
      const stamped = { ...edit.result, updatedAt: new Date().toISOString() };
      documentRef.current = stamped;
      setDocument(stamped);
      if (liveSessionRef.current) {
        liveSessionRef.current.writeJson(stamped as unknown as JsonObject);
      } else {
        scheduleSave();
      }
    },
    [readOnly, scheduleSave],
  );

  const commitScene = useCallback(
    (label: string, operation: (current: InkScene) => InkEdit<InkScene>) => {
      if (!activePageId) return;
      commit(label, (current) => onPage(current, activePageId, operation));
    },
    [activePageId, commit],
  );

  const commitStroke = useCallback(
    (samples: InkSample[]) => {
      if (!activeLayerId || samples.length === 0) return;
      const brush = { ...tool.brush };
      commitScene('Draw', (current) => {
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
      const current = documentRef.current;
      if (!current || !activePageId) return;
      const currentScene = current.pages[activePageId]?.scene;
      if (!currentScene) return;
      const plan = planErase(currentScene, path, radius, tool.eraserMode);
      if (plan.removedIds.length === 0 && plan.replacements.length === 0) return;
      commitScene('Erase', (target) => applyErase(target, plan));
    },
    [activePageId, commitScene, tool.eraserMode],
  );

  const undo = useCallback(() => {
    const current = documentRef.current;
    if (!current || readOnly) return;
    const reverted = historyRef.current.undo(current);
    setHistoryVersion((version) => version + 1);
    if (!reverted) return;
    documentRef.current = reverted;
    setDocument(reverted);
    if (liveSessionRef.current) {
      liveSessionRef.current.writeJson(reverted as unknown as JsonObject);
    } else {
      scheduleSave();
    }
  }, [readOnly, scheduleSave]);

  const redo = useCallback(() => {
    const current = documentRef.current;
    if (!current || readOnly) return;
    const reapplied = historyRef.current.redo(current);
    setHistoryVersion((version) => version + 1);
    if (!reapplied) return;
    documentRef.current = reapplied;
    setDocument(reapplied);
    if (liveSessionRef.current) {
      liveSessionRef.current.writeJson(reapplied as unknown as JsonObject);
    } else {
      scheduleSave();
    }
  }, [readOnly, scheduleSave]);

  const history = useMemo(
    () => historyRef.current.snapshot(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyVersion],
  );

  const addNewPage = useCallback(() => {
    const current = documentRef.current;
    if (!current) return;
    const id = nextId('page');
    commit('Add page', (target) => {
      const template = target.pages[target.pageOrder[target.pageOrder.length - 1]];
      const created = createInkPage(id, { mode: template?.mode ?? 'fixed' });
      const sized = template
        ? { ...created, width: template.width, height: template.height, background: template.background }
        : created;
      return addPage(target, sized, pageIndex + 1);
    });
    setPageId(id);
  }, [commit, nextId, pageIndex]);

  const goToPage = useCallback(
    (index: number) => {
      const current = documentRef.current;
      const next = current?.pageOrder[index];
      if (!next) return;
      setPageId(next);
      setViewport((state) => ({ ...state, originX: 0, originY: 0 }));
    },
    [],
  );

  const fitPage = useCallback(() => {
    if (!page) return;
    const host = window.document.querySelector<HTMLElement>('[data-testid="ink-touch-canvas"]');
    const width = host?.clientWidth ?? 0;
    const height = host?.clientHeight ?? 0;
    if (width === 0 || height === 0) return;

    const zoom = clampInkScale(
      Math.min((width * INK_UNITS_PER_PX) / page.width, (height * INK_UNITS_PER_PX) / page.height),
    );
    const unitsPerPixel = INK_UNITS_PER_PX / zoom;
    setViewport({
      zoom,
      originX: (page.width - width * unitsPerPixel) / 2,
      originY: (page.height - height * unitsPerPixel) / 2,
    });
  }, [page]);

  const inputSettings: InkInputSettings = useMemo(
    () => ({ fingerDrawing, palmRejection: true, barrelButton: 'erase' }),
    [fingerDrawing],
  );

  const stats = useMemo(() => (document ? inkDocumentStats(document) : null), [document]);

  useEffect(() => {
    const awareness = liveSession?.awareness;
    if (!awareness || !activePageId) return;
    awareness.setLocalStateField('user', {
      id: localUserId,
      name: localUser?.displayName || localUser?.username || 'Mobile',
      color: userColorForId(localUserId),
    });
    awareness.setLocalStateField('document', { kind: 'ink', relativePath: file.relativePath });
    awareness.setLocalStateField('ink', {
      activePageId,
      tool:
        tool.tool === 'pen'
          ? 'draw'
          : tool.tool === 'eraser'
            ? 'erase'
            : tool.tool === 'pan'
              ? 'navigate'
              : 'other',
      viewport,
      preview: null,
    } satisfies InkInteraction);
  }, [activePageId, file.relativePath, liveSession, localUser, localUserId, tool.tool, viewport]);

  const publishInkAwareness = useCallback(
    (interaction: Pick<InkInteraction, 'cursor' | 'preview'>) => {
      const awareness = liveSessionRef.current?.awareness;
      if (!awareness || !activePageId) return;
      const now = performance.now();
      if (now - awarenessSentAtRef.current < 50 && interaction.preview) return;
      awarenessSentAtRef.current = now;
      const current = awareness.getLocalState()?.ink as InkInteraction | undefined;
      awareness.setLocalStateField('ink', {
        ...(current ?? { activePageId, tool: 'other' }),
        ...interaction,
        activePageId,
      } satisfies InkInteraction);
    },
    [activePageId],
  );

  /* --------------------------------------------------------------------- */
  /* Render                                                                 */
  /* --------------------------------------------------------------------- */

  if (busy) {
    return (
      <div className="ink-screen ink-screen-centered">
        <Spinner />
      </div>
    );
  }

  if (error && !document) {
    return (
      <div className="ink-screen">
        <header className="ink-header">
          <button type="button" className="icon-button" aria-label="Back" onClick={closeSheet}>
            <ArrowLeft size={18} />
          </button>
          <div className="row-text">
            <strong>{drawingName(currentFile)}</strong>
          </div>
        </header>
        <Banner tone="error">{error}</Banner>
      </div>
    );
  }

  return (
    <div className="ink-screen">
      <header className="ink-header">
        <button type="button" className="icon-button" aria-label="Back" onClick={closeSheet}>
          <ArrowLeft size={18} />
        </button>
        <div className="row-text">
          <strong>{drawingName(currentFile)}</strong>
          <span>
            {`Page ${pageIndex + 1} of ${document?.pageOrder.length ?? 0}`}
            {stats ? ` · ${stats.strokes.toLocaleString()} strokes` : ''}
            {` · ${Math.round(viewport.zoom * 100)}%`}
          </span>
        </div>
        <span className="ink-header-status">
          {readOnly && <ReadOnlyBadge />}
          {source === 'cache' && <CloudOff size={15} aria-label="Offline copy" />}
          {liveStatus === 'connecting' && <Spinner size={15} />}
          {saving && <Spinner size={15} />}
        </span>
      </header>

      {schemaNewer && (
        <Banner tone="info">
          This drawing was made with a newer version of Collab. It is open read-only so nothing
          it stored is lost.
        </Banner>
      )}
      {repairs.length > 0 && (
        <Banner tone="info">
          {repairs.length === 1
            ? repairs[0]
            : `This drawing was repaired while opening (${repairs.length} issues).`}
        </Banner>
      )}
      {message && <Banner tone="info">{message}</Banner>}
      {pending && <Banner tone="info">This drawing has changes waiting to sync.</Banner>}
      {error && document && <Banner tone="error">{error}</Banner>}

      <InkTouchCanvas
        page={page}
        originX={viewport.originX}
        originY={viewport.originY}
        zoom={viewport.zoom}
        tool={{ ...tool, activeLayerId }}
        inputSettings={inputSettings}
        readOnly={readOnly}
        colorPalette={colorPalette}
        onViewportChange={setViewport}
        onCommitStroke={commitStroke}
        onErase={erase}
        remotePeers={remotePeers}
        onInkAwareness={publishInkAwareness}
      />

      <nav className="ink-rail" aria-label="Drawing tools">
        <span className="ink-rail-group">
          <button
            type="button"
            className={`icon-button ink-tool${tool.tool === 'pen' ? ' active' : ''}`}
            aria-label={tool.tool === 'pen' ? 'Pen options' : 'Pen'}
            aria-pressed={tool.tool === 'pen'}
            disabled={readOnly}
            onClick={() =>
              tool.tool === 'pen'
                ? setPanel('brush')
                : setTool((current) => ({ ...current, tool: 'pen' }))
            }
          >
            <PenLine size={18} />
            {/* The corner mark says this tool has settings behind it, so
                tapping it again is discoverable rather than folklore. */}
            <span className="ink-tool-more" aria-hidden />
          </button>
          <button
            type="button"
            className={`icon-button ink-tool${tool.tool === 'eraser' ? ' active' : ''}`}
            aria-label={tool.tool === 'eraser' ? 'Eraser options' : 'Eraser'}
            aria-pressed={tool.tool === 'eraser'}
            disabled={readOnly}
            onClick={() =>
              tool.tool === 'eraser'
                ? setPanel('eraser')
                : setTool((current) => ({ ...current, tool: 'eraser' }))
            }
          >
            <Eraser size={18} />
            <span className="ink-tool-more" aria-hidden />
          </button>
          <button
            type="button"
            className={`icon-button${tool.tool === 'pan' ? ' active' : ''}`}
            aria-label="Pan"
            aria-pressed={tool.tool === 'pan'}
            onClick={() => setTool((current) => ({ ...current, tool: 'pan' }))}
          >
            <Hand size={18} />
          </button>
        </span>

        <span className="ink-rail-group">
          <button
            type="button"
            className="icon-button"
            aria-label="Undo"
            disabled={readOnly || !history.canUndo}
            onClick={undo}
          >
            <Undo2 size={18} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Redo"
            disabled={readOnly || !history.canRedo}
            onClick={redo}
          >
            <Redo2 size={18} />
          </button>
        </span>

        <span className="ink-rail-group">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous page"
            disabled={pageIndex <= 0}
            onClick={() => goToPage(pageIndex - 1)}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next page"
            disabled={!document || pageIndex >= document.pageOrder.length - 1}
            onClick={() => goToPage(pageIndex + 1)}
          >
            <ChevronRight size={18} />
          </button>
          <button type="button" className="icon-button" aria-label="Fit page" onClick={fitPage}>
            <Maximize2 size={18} />
          </button>
          <button
            type="button"
            className={`icon-button${panel === 'layers' ? ' active' : ''}`}
            aria-label="Layers and pages"
            onClick={() => setPanel('layers')}
          >
            <Layers size={18} />
          </button>
        </span>
      </nav>

      {panel !== 'none' && (
        <div className="sheet-backdrop" onClick={() => setPanel('none')}>
          <div
            className="sheet"
            role="dialog"
            aria-label={
              panel === 'brush' ? 'Pen options' : panel === 'eraser' ? 'Eraser options' : 'Layers and pages'
            }
            onClick={(event) => event.stopPropagation()}
          >
            <span className="sheet-handle" />
            <div className="sheet-head">
              <div className="row-text">
                <strong>
                  {panel === 'brush' ? 'Pen' : panel === 'eraser' ? 'Eraser' : 'Layers and pages'}
                </strong>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => setPanel('none')}
              >
                <X size={16} />
              </button>
            </div>

            {panel === 'brush' && (
              <>
                <div className="field">
                  <span>Colour</span>
                  <div className="ink-swatches" role="radiogroup" aria-label="Colour">
                    {INK_DEFAULT_SWATCHES.map((color) => (
                      <button
                        key={color}
                        type="button"
                        role="radio"
                        aria-checked={tool.brush.color === color}
                        aria-label={inkColorLabel(color)}
                        title={inkColorLabel(color)}
                        className={`ink-swatch${tool.brush.color === color ? ' active' : ''}`}
                        style={{ background: resolveInkColor(color, colorPalette) }}
                        onClick={() =>
                          setTool((current) => ({ ...current, brush: { ...current.brush, color } }))
                        }
                      />
                    ))}
                  </div>
                </div>

                <div className="field">
                  <span>Brush</span>
                  <div className="ink-options" role="radiogroup" aria-label="Brush">
                    {INK_BRUSH_ORDER.map((kind: InkBrushKind) => (
                      <button
                        key={kind}
                        type="button"
                        role="radio"
                        aria-checked={tool.brush.kind === kind}
                        className={`chip${tool.brush.kind === kind ? ' active' : ''}`}
                        onClick={() =>
                          setTool((current) => ({
                            ...current,
                            tool: 'pen',
                            brushId: kind,
                            brush: { ...(INK_DEFAULT_BRUSHES[kind] ?? current.brush) },
                          }))
                        }
                      >
                        {INK_DEFAULT_BRUSHES[kind]?.name ?? kind}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <span>Width</span>
                  <div className="ink-options" role="radiogroup" aria-label="Width">
                    {INK_BRUSH_WIDTHS.map((width) => (
                      <button
                        key={width}
                        type="button"
                        role="radio"
                        aria-checked={tool.brush.width === width}
                        aria-label={`Width ${Math.round(width / 64)} points`}
                        className={`chip${tool.brush.width === width ? ' active' : ''}`}
                        onClick={() =>
                          setTool((current) => ({ ...current, brush: { ...current.brush, width } }))
                        }
                      >
                        {Math.round(width / 64)} pt
                      </button>
                    ))}
                  </div>
                </div>

                <label className="toggle-row">
                  <span className="row-text">
                    <strong>Draw with finger</strong>
                    {/* Off by default: a finger is how you move the page, a pen
                        is how you mark it. Devices with no pen turn this on. */}
                    <span>Otherwise one finger pans and two pinch to zoom.</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={fingerDrawing}
                    onChange={(event) => setFingerDrawing(event.target.checked)}
                  />
                </label>
              </>
            )}

            {panel === 'eraser' && (
              <>
                <div className="field">
                  <span>Mode</span>
                  <div className="segmented-control" role="radiogroup" aria-label="Eraser mode">
                    {(['stroke', 'segment', 'object'] as InkEraserMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={tool.eraserMode === mode}
                        className={tool.eraserMode === mode ? 'selected' : undefined}
                        onClick={() => setTool((current) => ({ ...current, eraserMode: mode }))}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <span>Size</span>
                  <div className="ink-options" role="radiogroup" aria-label="Eraser size">
                    {INK_ERASER_SIZES.map((radius) => (
                      <button
                        key={radius}
                        type="button"
                        role="radio"
                        aria-checked={tool.eraserRadius === radius}
                        aria-label={`Eraser size ${Math.round(radius / 64)} points`}
                        className={`chip${tool.eraserRadius === radius ? ' active' : ''}`}
                        onClick={() => setTool((current) => ({ ...current, eraserRadius: radius }))}
                      >
                        {Math.round(radius / 64)} pt
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {panel === 'layers' && (
              <>
                <div className="field">
                  <span>Layer</span>
                  <ul className="ink-layer-list" aria-label="Layers">
                    {scene &&
                      [...scene.layerOrder].reverse().map((layerId) => {
                        const layer = scene.layers[layerId];
                        if (!layer) return null;
                        const isActive = activeLayerId === layerId;
                        return (
                          <li key={layerId}>
                            <button
                              type="button"
                              className={`ink-layer${isActive ? ' active' : ''}`}
                              aria-pressed={isActive}
                              onClick={() =>
                                setTool((current) => ({ ...current, activeLayerId: layerId }))
                              }
                            >
                              {isActive ? <Check size={15} /> : <Layers size={15} />}
                              {layer.name}
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                </div>
                <button
                  type="button"
                  className="ghost-button"
                  disabled={readOnly}
                  onClick={() => {
                    addNewPage();
                    setPanel('none');
                  }}
                >
                  <Plus size={15} />
                  Add page
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
