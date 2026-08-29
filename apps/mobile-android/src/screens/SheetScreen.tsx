/**
 * Mobile `.sheet` workbook screen (Phase 8, Advanced Tables).
 *
 * Deliberately bounded: this is an inspector with the edits people actually make
 * on a phone — values, formulas, a small formatting set, table filters, and
 * validation-backed cells. Structural editing (insert/delete/move rows and
 * columns, merges, charts, named ranges, data connections, protection) stays a
 * desktop capability, so a phone can never restructure a workbook by accident.
 *
 * Everything about the document is shared with desktop: schema, normalization,
 * cell operations, validation, filters, formatting, search, and the native
 * formula runtime. The load/save lifecycle follows the same live-when-connected,
 * REST-with-offline-queue path as the note, Kanban, and logic screens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { flushSync } from 'react-dom';

import {
  ArrowLeft,
  Bold,
  Braces,
  Check,
  ChevronDown,
  ChevronUp,
  CloudOff,
  Filter,
  FilterX,
  Italic,
  Percent,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { formatA1, type SheetPosition } from '../../../../src/lib/sheet/address';
import {
  formatCellEditText,
  formatNumber,
  parseCellInput,
  type SheetDisplayFormatOptions,
} from '../../../../src/lib/sheet/cellValue';
import {
  clearSheetTableFilters,
  setSheetTableColumnFilter,
  tableAtPosition,
  uniqueTableColumnValues,
} from '../../../../src/lib/sheet/dataTools';
import { enforceSheetMutationPolicies } from '../../../../src/lib/sheet/mutationPolicy';
import {
  activeWorksheet as activeWorksheetOf,
  getCell,
  setActiveWorksheet,
  summarizeSelection,
} from '../../../../src/lib/sheet/operations';
import { clearCells } from '../../../../src/lib/sheet/operations';
import { findPopulatedSheetMatches, nextSheetMatch } from '../../../../src/lib/sheet/search';
import {
  createSelection,
  normalizeRange,
  selectCell,
  type SheetSelection,
} from '../../../../src/lib/sheet/selection';
import { applyStyleToSelection } from '../../../../src/lib/sheet/styles';
import { setValidatedCell, validationAt } from '../../../../src/lib/sheet/validation';
import type { SheetColumnFilter } from '../../../../src/types/sheet';
import { sheetFormulaResultKey } from '../../../../src/types/sheetFormula';
import { SheetTouchGrid } from '../components/SheetTouchGrid';
import { Banner, ReadOnlyBadge, Spinner } from '../components/ui';
import { useBackDismiss } from '../lib/backStack';
import { isReadOnlyRole } from '../lib/format';
import {
  type JsonObject,
  type LiveStatus,
  type MobileLiveJsonSession,
  openMobileLiveJsonSession,
} from '../lib/liveNote';
import {
  clampSheetScale,
  inspectSheetContent,
  isSheetFile,
  readSheetWorkbook,
  saveSheetWorkbook,
  serializeSheet,
  SHEET_MOBILE_SCALE,
  type SheetDocument,
  workbookName,
} from '../lib/sheet';
import { useMobileSheetFormula } from '../lib/sheetFormula';
import {
  describePendingFailure,
  discardPendingOperation,
  enqueueDocumentEdit,
  isLikelyConnectivityError,
  pendingEditsForFile,
  retryPendingOperation,
} from '../lib/sync';
import { type HostedFileEntry, type PendingOperation, replicaCacheDocument } from '../mobileTauri';
import { useMobileStore } from '../state/store';

const SAVE_DEBOUNCE_MS = 600;
/** How long a just-opened panel ignores the tap's synthesized ghost click. */
const GHOST_CLICK_WINDOW_MS = 400;

type ActivePanel = 'none' | 'editor' | 'format' | 'filter' | 'search';

function displayFormatFor(): SheetDisplayFormatOptions {
  return { locale: undefined };
}

export function SheetScreen({ file }: { file: HostedFileEntry }) {
  const selected = useMobileStore((s) => s.selected);
  const statuses = useMobileStore((s) => s.statuses);
  const closeSheet = useMobileStore((s) => s.closeSheet);
  const replaceFile = useMobileStore((s) => s.replaceFile);
  const syncServer = useMobileStore((s) => s.syncServer);

  const serverUrl = selected?.serverUrl ?? '';
  const vaultId = selected?.vault.id ?? '';
  const connected = selected ? !!statuses[serverUrl]?.connected : false;
  const vaultReadOnly = selected ? isReadOnlyRole(selected.vault.role) : true;
  const manifestSequence = selected?.vault.manifestSequence ?? 0;

  const [document, setDocument] = useState<SheetDocument | null>(null);
  const [schemaNewer, setSchemaNewer] = useState(false);
  const [repairs, setRepairs] = useState<string[]>([]);
  const [currentFile, setCurrentFile] = useState(file);
  const [selection, setSelection] = useState<SheetSelection>(() =>
    createSelection({ row: 0, column: 0 }),
  );
  const [scale, setScale] = useState<number>(SHEET_MOBILE_SCALE.default);
  const [panel, setPanel] = useState<ActivePanel>('none');
  const [editorText, setEditorText] = useState('');
  const [source, setSource] = useState<'network' | 'cache'>('network');
  const [savedContent, setSavedContent] = useState('');
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [liveSession, setLiveSession] = useState<MobileLiveJsonSession | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showWorksheets, setShowWorksheets] = useState(false);

  const readOnly = vaultReadOnly || schemaNewer;

  const documentRef = useRef<SheetDocument | null>(null);
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
  const liveSessionRef = useRef<MobileLiveJsonSession | null>(null);
  liveSessionRef.current = liveSession;
  const editorInputRef = useRef<HTMLInputElement | null>(null);
  const panelOpenedAtRef = useRef(0);
  const screenRef = useRef<HTMLDivElement | null>(null);

  const formula = useMobileSheetFormula(document);

  const markSaved = useCallback((content: string) => {
    savedContentRef.current = content;
    if (mountedRef.current) setSavedContent(content);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const worksheet = useMemo(
    () => (document && document.worksheets.length > 0 ? activeWorksheetOf(document) : null),
    [document],
  );

  // The layout keeps `.app-main` unscrollable for this screen, but a WebView can
  // still scroll an `overflow: hidden` ancestor when it reveals a focused input.
  // That offset would survive the soft keyboard closing and hide the header, so
  // it is reset whenever the cell editor closes.
  useEffect(() => {
    if (panel === 'editor') return;
    const main = screenRef.current?.closest<HTMLElement>('.app-main');
    if (main && main.scrollTop !== 0) main.scrollTop = 0;
  }, [panel]);

  // ── Load ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!selected) return;
      if (liveSessionRef.current) return;
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const loaded = await readSheetWorkbook(serverUrl, vaultId, file, connected);
        if (cancelled || liveSessionRef.current) return;
        setCurrentFile(loaded.file);
        setDocument(loaded.document);
        setSchemaNewer(loaded.support === 'newer');
        setRepairs(loaded.warnings);
        markSaved(serializeSheet(loaded.document));
        setSource(loaded.source);
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
    // which hands this screen a fresh `HostedFileEntry` for the same document;
    // depending on that identity reloaded the document after every save. A live
    // session masked it, so it only surfaced offline or where live is
    // unavailable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, file.id, selected?.serverUrl, selected?.vault.id]);

  // ── Live session ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let opened: MobileLiveJsonSession | null = null;
    let offStatus: (() => void) | undefined;
    let offChange: (() => void) | undefined;

    setLiveSession(null);
    setLiveStatus(null);

    if (!selected || vaultReadOnly || !connectedRef.current) {
      return () => {
        cancelled = true;
      };
    }

    const applyLive = (json: JsonObject, nextSource: 'network' | 'cache') => {
      let inspected;
      try {
        inspected = inspectSheetContent(JSON.stringify(json), workbookName(fileRef.current));
      } catch {
        // A live root that is not a valid workbook must never replace the REST
        // copy; the REST/offline path stays authoritative instead.
        return;
      }
      if (inspected.support === 'newer') {
        setSchemaNewer(true);
        return;
      }
      const content = serializeSheet(inspected.document);
      setDocument(inspected.document);
      documentRef.current = inspected.document;
      markSaved(content);
      setSource(nextSource);
      setError(null);
      void replicaCacheDocument(serverUrl, vaultId, fileRef.current.id, content).catch(() => {});
    };

    openMobileLiveJsonSession(serverUrl, vaultId, file.id, 'sheet')
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
        const initial = session.readJson();
        // An empty live root means the room has no seeded state yet; keep REST.
        if (Object.keys(initial).length > 0) applyLive(initial, 'network');
        offChange = session.onChange((json) => {
          if (!cancelled) {
            applyLive(json, session.getStatus() === 'connected' ? 'network' : 'cache');
          }
        });
      })
      .catch(() => {
        // Best effort: the REST/offline queue path remains active.
      });

    return () => {
      cancelled = true;
      offChange?.();
      offStatus?.();
      opened?.destroy();
      setLiveSession(null);
      setLiveStatus(null);
    };
  }, [file.id, markSaved, selected, serverUrl, vaultId, vaultReadOnly]);

  // Ephemeral active worksheet/cell/range state belongs in awareness, never in
  // the document. The payload shape matches the desktop `sheet` awareness field.
  useEffect(() => {
    if (!liveSession || !worksheet) return;
    const rowId = worksheet.rowOrder[selection.active.row];
    const columnId = worksheet.columnOrder[selection.active.column];
    const ranges = selection.ranges.flatMap((range) => {
      const rectangle = normalizeRange(range);
      const startRowId = worksheet.rowOrder[rectangle.top];
      const startColumnId = worksheet.columnOrder[rectangle.left];
      const endRowId = worksheet.rowOrder[rectangle.bottom];
      const endColumnId = worksheet.columnOrder[rectangle.right];
      return startRowId && startColumnId && endRowId && endColumnId
        ? [{ startRowId, startColumnId, endRowId, endColumnId }]
        : [];
    });
    liveSession.awareness.setLocalStateField('sheet', {
      worksheetId: worksheet.id,
      ...(rowId && columnId ? { activeCell: { rowId, columnId } } : {}),
      ranges,
    });
  }, [liveSession, selection, worksheet]);

  // ── Save ───────────────────────────────────────────────────────────────────
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
      setMessage('Saved offline. This workbook will sync when you reconnect.');
    },
    [manifestSequence, markSaved, serverUrl, vaultId],
  );

  const flushSave = useCallback(async () => {
    const current = documentRef.current;
    if (!current || savingRef.current || readOnlyRef.current || liveSessionRef.current) return;
    const content = serializeSheet(current);
    if (content === savedContentRef.current) return;
    savingRef.current = true;
    if (mountedRef.current) setSaving(true);
    try {
      if (connectedRef.current) {
        try {
          const saved = await saveSheetWorkbook(serverUrl, vaultId, fileRef.current, current);
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
    if (latest && serializeSheet(latest) !== savedContentRef.current) void flushSave();
  }, [markSaved, queueOffline, replaceFile, serverUrl, vaultId]);

  const scheduleSave = useCallback(() => {
    if (liveSessionRef.current) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const latest = documentRef.current;
      if (latest && serializeSheet(latest) !== savedContentRef.current) void flushSave();
    },
    [flushSave],
  );

  /**
   * Apply a workbook mutation. Every edit goes through the shared mutation
   * policy so protected ranges and strict validations are enforced exactly as
   * they are on desktop, then persists live or through the debounced REST save.
   */
  const mutate = useCallback(
    (updater: (current: SheetDocument, worksheetId: string) => SheetDocument) => {
      const current = documentRef.current;
      if (!current || readOnlyRef.current) return;
      const target = activeWorksheetOf(current);
      let next: SheetDocument;
      try {
        const enforced = enforceSheetMutationPolicies(
          current,
          updater(current, target.id),
          formula.values,
        );
        next = enforced.document;
        if (enforced.warnings.length > 0) setMessage(enforced.warnings[0]);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return;
      }
      if (next === current) return;
      setDocument(next);
      documentRef.current = next;
      setError(null);
      const content = serializeSheet(next);
      const live = liveSessionRef.current;
      if (live) {
        live.writeJson(JSON.parse(content) as JsonObject);
        markSaved(content);
        setSource(live.getStatus() === 'connected' ? 'network' : 'cache');
        void replicaCacheDocument(serverUrl, vaultId, fileRef.current.id, content).catch(() => {});
        return;
      }
      scheduleSave();
    },
    [formula.values, markSaved, scheduleSave, serverUrl, vaultId],
  );

  // ── Derived cell state ─────────────────────────────────────────────────────
  const activeCell = worksheet ? getCell(worksheet, selection.active) : undefined;
  const activeComputed = worksheet
    ? formula.values.get(
        sheetFormulaResultKey(
          worksheet.id,
          worksheet.rowOrder[selection.active.row] ?? '',
          worksheet.columnOrder[selection.active.column] ?? '',
        ),
      )
    : undefined;
  const activeValidation = worksheet ? validationAt(worksheet, selection.active) : null;
  const activeTable = worksheet ? tableAtPosition(worksheet, selection.active) : null;
  const summary = useMemo(
    () => (document && worksheet ? summarizeSelection(worksheet, selection, formula.values) : null),
    [document, worksheet, selection, formula.values],
  );

  const matches = useMemo(
    () => (worksheet && query.trim() ? findPopulatedSheetMatches(worksheet, query.trim()) : []),
    [worksheet, query],
  );

  /**
   * A tap on the grid is handled on `touchend`, and the WebView then synthesizes
   * a compatibility click at the same point — which now lands on the freshly
   * mounted backdrop. Without this window that ghost click would dismiss the
   * panel the tap just opened.
   */
  const dismissPanel = useCallback(() => {
    if (Date.now() - panelOpenedAtRef.current < GHOST_CLICK_WINDOW_MS) return;
    setPanel('none');
  }, []);

  const openPanel = useCallback((next: Exclude<ActivePanel, 'none'>) => {
    panelOpenedAtRef.current = Date.now();
    setPanel(next);
  }, []);

  // Back closes the open panel or the worksheet list before leaving the
  // workbook, so it never jumps straight to the quit prompt mid-edit.
  useBackDismiss(panel !== 'none', () => setPanel('none'));
  useBackDismiss(showWorksheets, () => setShowWorksheets(false));

  /**
   * Open the cell editor and focus its input *inside the same user gesture*.
   *
   * The Android WebView only raises the soft keyboard for a focus that happens
   * synchronously within a touch/click handler. A React state update alone
   * mounts the input on a later commit — outside the gesture — so `autoFocus`
   * silently leaves the keyboard closed. `flushSync` commits the panel first so
   * the input exists and is visible, then focus still counts as user-initiated.
   */
  const openEditor = useCallback(
    (position: SheetPosition) => {
      if (readOnly || !worksheet) return;
      flushSync(() => {
        setEditorText(formatCellEditText(getCell(worksheet, position)));
        panelOpenedAtRef.current = Date.now();
        setPanel('editor');
      });
      editorInputRef.current?.focus();
    },
    [readOnly, worksheet],
  );

  const commitEditor = useCallback(() => {
    const position = selection.active;
    const text = editorText;
    mutate((current, worksheetId) => {
      const result = setValidatedCell(current, worksheetId, position, parseCellInput(text));
      if (result.warning) setMessage(result.warning);
      return result.document;
    });
    setPanel('none');
  }, [editorText, mutate, selection.active]);

  const dirty = !liveSession && document !== null && serializeSheet(document) !== savedContent;
  const statusLabel =
    pending?.status === 'failed'
      ? 'Sync failed'
      : pending
        ? 'Queued to sync'
        : liveSession
          ? liveStatus === 'connected'
            ? 'Live'
            : 'Live offline'
          : saving
            ? 'Saving…'
            : formula.calculating
              ? 'Calculating…'
              : source === 'cache'
                ? 'Cached workbook'
                : dirty
                  ? 'Unsaved changes'
                  : 'Saved';

  const reload = useCallback(async () => {
    const loaded = await readSheetWorkbook(
      serverUrl,
      vaultId,
      fileRef.current,
      connectedRef.current,
    );
    if (!mountedRef.current) return;
    setCurrentFile(loaded.file);
    fileRef.current = loaded.file;
    setDocument(loaded.document);
    documentRef.current = loaded.document;
    setSchemaNewer(loaded.support === 'newer');
    setRepairs(loaded.warnings);
    markSaved(serializeSheet(loaded.document));
    setSource(loaded.source);
  }, [markSaved, serverUrl, vaultId]);

  async function retrySync() {
    if (!pending || recovering) return;
    setRecovering(true);
    setError(null);
    setMessage(null);
    try {
      await retryPendingOperation(serverUrl, vaultId, pending.id);
      await syncServer(serverUrl);
      const queued = await pendingEditsForFile(serverUrl, vaultId, fileRef.current.id);
      setPending(queued[0] ?? null);
      if (queued.length === 0) {
        await reload();
        setMessage('Synced.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRecovering(false);
    }
  }

  async function discardQueued() {
    if (!pending || recovering) return;
    setRecovering(true);
    setError(null);
    setMessage(null);
    try {
      await discardPendingOperation(serverUrl, vaultId, pending.id);
      setPending(null);
      await reload();
      setMessage('Discarded the queued change.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRecovering(false);
    }
  }

  if (!selected || !isSheetFile(currentFile)) return null;

  return (
    <div className="screen workbook-screen" ref={screenRef}>
      <header className="note-header">
        <button type="button" className="icon-button" aria-label="Back" onClick={closeSheet}>
          <ArrowLeft size={18} aria-hidden />
        </button>
        <div className="note-title">
          <h1 className="truncate">{workbookName(currentFile)}</h1>
          <p>
            {statusLabel}
            {worksheet ? ` · ${worksheet.name}` : ''}
          </p>
        </div>
        <div className="header-side">
          {vaultReadOnly ? <ReadOnlyBadge /> : null}
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom out"
            onClick={() => setScale((current) => clampSheetScale(current - 0.2))}
          >
            <ZoomOut size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Zoom in"
            onClick={() => setScale((current) => clampSheetScale(current + 0.2))}
          >
            <ZoomIn size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Find in workbook"
            onClick={() => (panel === 'search' ? setPanel('none') : openPanel('search'))}
          >
            <Search size={16} aria-hidden />
          </button>
        </div>
      </header>

      {schemaNewer ? (
        <Banner tone="info">
          This workbook uses a newer schema than this app build. It is open read-only so no fields
          are lost.
        </Banner>
      ) : null}
      {repairs.length > 0 ? <Banner tone="info">{repairs[0]}</Banner> : null}
      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}
      {source === 'cache' && !pending ? (
        <div className="offline-strip">
          <CloudOff size={14} aria-hidden />
          <span>Offline — showing the cached copy.</span>
        </div>
      ) : null}

      {pending ? (
        <div className="workbook-pending">
          <span>
            {pending.status === 'failed'
              ? describePendingFailure(pending)
              : 'This workbook has an offline change waiting to sync.'}
          </span>
          <div className="workbook-pending-actions">
            <button
              type="button"
              className="workbook-chip"
              disabled={recovering}
              onClick={() => void retrySync()}
            >
              {recovering ? <Spinner size={14} /> : <RefreshCw size={14} aria-hidden />} Retry
            </button>
            <button
              type="button"
              className="workbook-chip"
              disabled={recovering}
              onClick={() => void discardQueued()}
            >
              <Trash2 size={14} aria-hidden /> Discard
            </button>
          </div>
        </div>
      ) : null}

      {busy ? (
        <div className="loading-block">
          <Spinner size={22} />
          <span>Loading workbook…</span>
        </div>
      ) : null}

      {!busy && document && worksheet ? (
        <>
          {/* Formula / result inspection for the active cell. */}
          <div className="workbook-inspector">
            <span className="workbook-address">{formatA1(selection.active)}</span>
            <button
              type="button"
              className="workbook-inspector-value"
              disabled={readOnly}
              onClick={() => openEditor(selection.active)}
            >
              {activeCell?.formula ? (
                <span className="workbook-formula">
                  <Braces size={13} aria-hidden /> {activeCell.formula}
                </span>
              ) : (
                <span>{formatCellEditText(activeCell) || 'Empty cell'}</span>
              )}
            </button>
            {activeCell?.formula ? (
              <span
                className={`workbook-result ${activeComputed?.type === 'error' ? 'error' : ''}`}
                aria-label="Formula result"
              >
                {activeComputed
                  ? activeComputed.type === 'blank'
                    ? '—'
                    : String(activeComputed.value)
                  : '…'}
              </span>
            ) : null}
          </div>

          <SheetTouchGrid
            document={document}
            worksheet={worksheet}
            selection={selection}
            onSelectionChange={setSelection}
            onActivateCell={openEditor}
            onLongPressCell={() => openPanel('format')}
            computedValues={formula.values}
            displayFormat={displayFormatFor()}
            scale={scale}
            onScaleChange={setScale}
          />

          <div className="workbook-toolbar">
            <button
              type="button"
              className="workbook-chip"
              aria-label="Worksheets"
              onClick={() => setShowWorksheets((current) => !current)}
            >
              <Table2 size={14} aria-hidden /> {worksheet.name}
              {showWorksheets ? (
                <ChevronDown size={13} aria-hidden />
              ) : (
                <ChevronUp size={13} aria-hidden />
              )}
            </button>
            {summary && summary.selected > 1 ? (
              <span className="workbook-summary">
                {summary.selected} cells
                {summary.numeric > 0 ? ` · Σ ${formatNumber(summary.sum)}` : ''}
              </span>
            ) : null}
            {!readOnly ? (
              <button type="button" className="workbook-chip" onClick={() => openPanel('format')}>
                <Bold size={14} aria-hidden /> Format
              </button>
            ) : null}
            {!readOnly && activeTable ? (
              <button type="button" className="workbook-chip" onClick={() => openPanel('filter')}>
                <Filter size={14} aria-hidden /> Filter
              </button>
            ) : null}
          </div>

          {showWorksheets ? (
            <nav className="workbook-worksheets" aria-label="Worksheets">
              {document.worksheets
                .filter((candidate) => !candidate.hidden)
                .map((candidate) => (
                  <button
                    type="button"
                    key={candidate.id}
                    className={`workbook-chip ${candidate.id === worksheet.id ? 'active' : ''}`}
                    onClick={() => {
                      // Switching worksheets is view state, but the active
                      // worksheet is part of the document, so it goes through
                      // the normal mutation path.
                      mutate((current) => setActiveWorksheet(current, candidate.id));
                      setSelection(createSelection({ row: 0, column: 0 }));
                      setShowWorksheets(false);
                    }}
                  >
                    {candidate.name}
                  </button>
                ))}
            </nav>
          ) : null}
        </>
      ) : null}

      {panel === 'search' && worksheet ? (
        <div className="sheet-backdrop" onClick={dismissPanel}>
          <div
            className="sheet"
            role="dialog"
            aria-label="Find in workbook"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="sheet-head">
              <div className="row-text">
                <strong>Find</strong>
                <span>{query.trim() ? `${matches.length} matches` : 'Search populated cells'}</span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => setPanel('none')}
              >
                <X size={18} aria-hidden />
              </button>
            </div>
            <label className="field">
              <span>Text</span>
              <input
                autoFocus
                value={query}
                placeholder="Find in this worksheet"
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="workbook-pending-actions">
              <button
                type="button"
                className="workbook-chip"
                disabled={matches.length === 0}
                onClick={() => {
                  const next = nextSheetMatch(matches, selection.active, 'previous');
                  if (next) setSelection(selectCell(next));
                }}
              >
                <ChevronUp size={14} aria-hidden /> Previous
              </button>
              <button
                type="button"
                className="workbook-chip"
                disabled={matches.length === 0}
                onClick={() => {
                  const next = nextSheetMatch(matches, selection.active, 'next');
                  if (next) setSelection(selectCell(next));
                }}
              >
                <ChevronDown size={14} aria-hidden /> Next
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {panel === 'editor' && worksheet ? (
        <div className="sheet-backdrop" onClick={dismissPanel}>
          <form
            className="sheet workbook-editor-sheet"
            aria-label={`Edit ${formatA1(selection.active)}`}
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              commitEditor();
            }}
          >
            <div className="sheet-handle" />
            <div className="sheet-head">
              <div className="row-text">
                <strong>{formatA1(selection.active)}</strong>
                <span>{activeValidation ? 'Validated cell' : 'Value or formula'}</span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => setPanel('none')}
              >
                <X size={18} aria-hidden />
              </button>
            </div>

            {activeValidation?.kind === 'list' && activeValidation.options ? (
              <div className="workbook-validation-options">
                {activeValidation.options.map((option) => (
                  <button
                    type="button"
                    key={option}
                    className={`workbook-chip ${editorText === option ? 'active' : ''}`}
                    onClick={() => setEditorText(option)}
                  >
                    {editorText === option ? <Check size={13} aria-hidden /> : null} {option}
                  </button>
                ))}
              </div>
            ) : null}

            <label className="field">
              <span>Content</span>
              <input
                ref={editorInputRef}
                autoFocus
                // Always the full text keyboard. A cell takes text, numbers, or
                // a formula, and the numeric keypad has no letters and no `=`,
                // so it cannot type most of what a cell accepts. Autocapitalize,
                // autocorrect, and spellcheck stay off so what reaches the
                // document is exactly what was typed.
                type="text"
                inputMode="text"
                enterKeyHint="done"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={editorText}
                placeholder="Value or =FORMULA()"
                onChange={(event) => setEditorText(event.target.value)}
              />
            </label>
            {activeValidation?.message ? (
              <div className="sheet-note">
                <span>{activeValidation.message}</span>
              </div>
            ) : null}
            <button className="primary-button" type="submit">
              <Check size={16} aria-hidden /> Apply
            </button>
            <button
              type="button"
              className="workbook-chip"
              onClick={() => {
                mutate((current, worksheetId) => clearCells(current, worksheetId, selection));
                setPanel('none');
              }}
            >
              <Trash2 size={14} aria-hidden /> Clear cell
            </button>
          </form>
        </div>
      ) : null}

      {panel === 'format' && worksheet ? (
        <div className="sheet-backdrop" onClick={dismissPanel}>
          <div
            className="sheet"
            role="dialog"
            aria-label="Cell formatting"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="sheet-head">
              <div className="row-text">
                <strong>Formatting</strong>
                <span>{formatA1(selection.active)}</span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => setPanel('none')}
              >
                <X size={18} aria-hidden />
              </button>
            </div>
            <div className="workbook-format-actions">
              <button
                type="button"
                className="workbook-chip"
                aria-label="Bold"
                onClick={() =>
                  mutate((current, worksheetId) =>
                    applyStyleToSelection(current, worksheetId, selection, { bold: true }),
                  )
                }
              >
                <Bold size={14} aria-hidden /> Bold
              </button>
              <button
                type="button"
                className="workbook-chip"
                aria-label="Italic"
                onClick={() =>
                  mutate((current, worksheetId) =>
                    applyStyleToSelection(current, worksheetId, selection, { italic: true }),
                  )
                }
              >
                <Italic size={14} aria-hidden /> Italic
              </button>
              <button
                type="button"
                className="workbook-chip"
                aria-label="Percent"
                onClick={() =>
                  mutate((current, worksheetId) =>
                    applyStyleToSelection(current, worksheetId, selection, {
                      numberFormat: { kind: 'percent', decimals: 1 },
                    }),
                  )
                }
              >
                <Percent size={14} aria-hidden /> Percent
              </button>
              {(['left', 'center', 'right'] as const).map((align) => (
                <button
                  type="button"
                  key={align}
                  className="workbook-chip"
                  aria-label={`Align ${align}`}
                  onClick={() =>
                    mutate((current, worksheetId) =>
                      applyStyleToSelection(current, worksheetId, selection, {
                        horizontalAlign: align,
                      }),
                    )
                  }
                >
                  {align}
                </button>
              ))}
            </div>
            <div className="sheet-note">
              <span>Structural editing, charts, and protection stay on the desktop app.</span>
            </div>
          </div>
        </div>
      ) : null}

      {panel === 'filter' && worksheet && activeTable ? (
        <div className="sheet-backdrop" onClick={dismissPanel}>
          <div
            className="sheet"
            role="dialog"
            aria-label="Filter column"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="sheet-head">
              <div className="row-text">
                <strong>Filter</strong>
                <span>{activeTable.name}</span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => setPanel('none')}
              >
                <X size={18} aria-hidden />
              </button>
            </div>
            <FilterOptions
              columnId={worksheet.columnOrder[selection.active.column] ?? ''}
              values={uniqueTableColumnValues(
                worksheet,
                activeTable,
                worksheet.columnOrder[selection.active.column] ?? '',
                formula.values,
              )}
              current={worksheet.filters?.columnFilters?.find(
                (candidate) =>
                  candidate.columnId === worksheet.columnOrder[selection.active.column],
              )}
              onApply={(filter) => {
                const columnId = worksheet.columnOrder[selection.active.column] ?? '';
                mutate((current, worksheetId) =>
                  setSheetTableColumnFilter(
                    current,
                    worksheetId,
                    activeTable.id,
                    columnId,
                    filter,
                    formula.values,
                  ),
                );
              }}
              onClearAll={() => {
                mutate((current, worksheetId) => clearSheetTableFilters(current, worksheetId));
                setPanel('none');
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FilterOptions({
  columnId,
  values,
  current,
  onApply,
  onClearAll,
}: {
  columnId: string;
  values: Array<string | number | boolean | null>;
  current: SheetColumnFilter | undefined;
  onApply: (filter: SheetColumnFilter | null) => void;
  onClearAll: () => void;
}) {
  const included = current?.includeValues;
  const isIncluded = (value: string | number | boolean | null) =>
    !included || included.some((candidate) => candidate === value);

  return (
    <>
      <div className="workbook-filter-values">
        {values.map((value) => {
          const label = value === null || value === '' ? '(blank)' : String(value);
          const active = isIncluded(value);
          return (
            <button
              type="button"
              key={label}
              className={`workbook-chip ${active ? 'active' : ''}`}
              aria-pressed={active}
              onClick={() => {
                const base = included ?? values;
                const next = active
                  ? base.filter((candidate) => candidate !== value)
                  : [...base, value];
                onApply(next.length === values.length ? null : { columnId, includeValues: next });
              }}
            >
              {active ? <Check size={13} aria-hidden /> : null} {label}
            </button>
          );
        })}
      </div>
      <button type="button" className="workbook-chip" onClick={onClearAll}>
        <FilterX size={14} aria-hidden /> Clear all filters
      </button>
    </>
  );
}
