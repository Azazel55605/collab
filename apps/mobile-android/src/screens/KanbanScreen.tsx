import {
  type CSSProperties,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  Archive,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  CloudOff,
  Columns3,
  GanttChart,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';

import { userColorForId } from '../../../../src/lib/userColor';
import { getCardDueStatus, type KanbanDueStatus } from '../../../../src/types/kanban';
import { ColorPicker } from '../components/ColorPicker';
import { DateField } from '../components/DateField';
import { Banner, ReadOnlyBadge, Spinner } from '../components/ui';
import { useBackDismiss } from '../lib/backStack';
import { isReadOnlyRole } from '../lib/format';
import {
  addCardToColumn,
  addChecklistItem,
  addColumn,
  addComment,
  addTag,
  type CardSortField,
  checklistProgress,
  collectBoardTags,
  type CommentAuthor,
  createCard,
  createColumn,
  findCard,
  type KanbanBoard,
  type KanbanCard,
  type KanbanColumn,
  type KanbanPriority,
  moveCardToColumn,
  moveColumn,
  parseBoardContent,
  readKanbanDocument,
  removeCard,
  removeChecklistItem,
  removeColumn,
  removeTag,
  saveKanbanDocument,
  serializeBoard,
  setCardArchived,
  toggleCardDone,
  toggleChecklistItem,
  updateCard,
  updateColumn,
  viewCards,
} from '../lib/kanban';
import {
  type JsonObject,
  type LiveStatus,
  type MobileLiveJsonSession,
  openMobileLiveJsonSession,
} from '../lib/liveNote';
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

const PRIORITIES: Array<{ value: KanbanPriority | 'none'; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
];

const PRIORITY_LABEL: Record<KanbanPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const DUE_LABEL: Record<KanbanDueStatus, string> = {
  overdue: 'Overdue',
  'due-today': 'Due today',
  upcoming: 'Upcoming',
  none: '',
};

const SORT_OPTIONS: Array<{ value: CardSortField; label: string }> = [
  { value: 'manual', label: 'Manual' },
  { value: 'priority', label: 'Priority' },
  { value: 'due', label: 'Due date' },
  { value: 'title', label: 'Title' },
  { value: 'created', label: 'Created' },
];

const SWIPE_THRESHOLD = 60;
const SAVE_DEBOUNCE_MS = 500;
const TIMELINE_DAY_WIDTH = 34;
const TIMELINE_DAYS = 42;
type MobileKanbanView = 'board' | 'calendar' | 'timeline' | 'archive';

function boardToJson(board: KanbanBoard): JsonObject {
  return JSON.parse(serializeBoard(board)) as JsonObject;
}

function boardFromJson(value: JsonObject): KanbanBoard {
  return parseBoardContent(JSON.stringify(value));
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function KanbanScreen({
  file,
  initialCardId,
}: {
  file: HostedFileEntry;
  initialCardId?: string;
}) {
  const selected = useMobileStore((s) => s.selected);
  const statuses = useMobileStore((s) => s.statuses);
  const closeSheet = useMobileStore((s) => s.closeSheet);
  const replaceFile = useMobileStore((s) => s.replaceFile);
  const syncServer = useMobileStore((s) => s.syncServer);

  const serverUrl = selected?.serverUrl ?? '';
  const vaultId = selected?.vault.id ?? '';
  const connected = selected ? !!statuses[serverUrl]?.connected : false;
  const readOnly = selected ? isReadOnlyRole(selected.vault.role) : true;
  const manifestSequence = selected?.vault.manifestSequence ?? 0;

  const [board, setBoard] = useState<KanbanBoard>({ columns: [] });
  const [currentFile, setCurrentFile] = useState(file);
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(initialCardId ?? null);
  const [source, setSource] = useState<'network' | 'cache'>('network');
  const [savedContent, setSavedContent] = useState('');
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [liveSession, setLiveSession] = useState<MobileLiveJsonSession | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<CardSortField>('manual');
  const [filterQuery, setFilterQuery] = useState('');
  const [showTools, setShowTools] = useState(false);
  const [slideDir, setSlideDir] = useState<1 | -1>(1);
  const [view, setView] = useState<MobileKanbanView>('board');
  const [showViewMenu, setShowViewMenu] = useState(false);
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null);
  const [showAddColumn, setShowAddColumn] = useState(false);
  const [newColumnTitle, setNewColumnTitle] = useState('');
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const columnStripRef = useRef<HTMLElement | null>(null);

  // Back unwinds the board's own surfaces — card sheet, column editor, add-column
  // sheet, and the view/tools menus — before leaving the board.
  useBackDismiss(openCardId !== null, () => setOpenCardId(null));
  useBackDismiss(editingColumnId !== null, () => setEditingColumnId(null));
  useBackDismiss(showAddColumn, () => setShowAddColumn(false));
  useBackDismiss(showViewMenu, () => setShowViewMenu(false));
  useBackDismiss(showTools, () => setShowTools(false));

  // Refs that the debounced save reads so it always persists the freshest board
  // against the freshest file revision, independent of render timing.
  const boardRef = useRef(board);
  boardRef.current = board;
  const fileRef = useRef(currentFile);
  fileRef.current = currentFile;
  const savedContentRef = useRef('');
  const savingRef = useRef(false);
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const mountedRef = useRef(true);
  const saveTimerRef = useRef<number | null>(null);
  const liveSessionRef = useRef<MobileLiveJsonSession | null>(null);
  liveSessionRef.current = liveSession;
  const openCardIdRef = useRef<string | null>(null);
  openCardIdRef.current = openCardId;

  // Record the last-persisted serialization in both a ref (read synchronously by
  // the save loop) and state (so the dirty/status label re-renders on save).
  const markSaved = useCallback((content: string) => {
    savedContentRef.current = content;
    if (mountedRef.current) setSavedContent(content);
  }, []);

  const author = useMemo<CommentAuthor>(() => {
    const user = statuses[serverUrl]?.user;
    const id = user?.id ?? 'local';
    return {
      userId: id,
      userName: user?.displayName || user?.username || 'You',
      userColor: userColorForId(id),
    };
  }, [statuses, serverUrl]);

  const liveActive = !!liveSession;
  const dirty = useMemo(
    () => !liveActive && serializeBoard(board) !== savedContent,
    [board, liveActive, savedContent],
  );
  const pendingFailed = pending?.status === 'failed';
  const statusLabel = pendingFailed
    ? 'Sync failed'
    : pending
      ? 'Queued to sync'
      : liveActive
        ? liveStatus === 'connected'
          ? 'Live'
          : 'Live offline'
        : saving
          ? 'Saving…'
          : source === 'cache'
            ? 'Cached board'
            : dirty
              ? 'Unsaved changes'
              : 'Saved';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Keep the active column chip in view in the horizontally scrolling top strip
  // as the user swipes/paginates between columns.
  useEffect(() => {
    const active = columnStripRef.current?.querySelector<HTMLElement>('.kanban-column-chip.active');
    active?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [selectedColumnId, busy]);

  // ── Load ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!selected) return;
      if (liveSessionRef.current) return;
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const loaded = await readKanbanDocument(serverUrl, vaultId, file, connected);
        if (cancelled) return;
        if (liveSessionRef.current) return;
        setCurrentFile(loaded.file);
        setBoard(loaded.board);
        markSaved(serializeBoard(loaded.board));
        setSource(loaded.source);
        setSelectedColumnId((prev) => prev ?? loaded.board.columns[0]?.id ?? null);
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

  useEffect(() => {
    let cancelled = false;
    let opened: MobileLiveJsonSession | null = null;
    let offStatus: (() => void) | undefined;
    let offChange: (() => void) | undefined;

    setLiveSession(null);
    setLiveStatus(null);

    if (!selected || readOnly || !connectedRef.current) {
      return () => {
        cancelled = true;
      };
    }

    const applyLiveBoard = (next: KanbanBoard, nextSource: 'network' | 'cache') => {
      const content = serializeBoard(next);
      setBoard(next);
      boardRef.current = next;
      markSaved(content);
      setSource(nextSource);
      setError(null);
      setSelectedColumnId((prev) => {
        if (prev && next.columns.some((column) => column.id === prev)) return prev;
        return next.columns[0]?.id ?? null;
      });
      if (openCardIdRef.current && !findCard(next, openCardIdRef.current)) setOpenCardId(null);
      void replicaCacheDocument(serverUrl, vaultId, file.id, content).catch(() => {});
    };

    openMobileLiveJsonSession(serverUrl, vaultId, file.id, 'kanban')
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

        const initialJson = session.readJson();
        if (Object.keys(initialJson).length > 0)
          applyLiveBoard(boardFromJson(initialJson), 'network');
        offChange = session.onChange((json) => {
          if (!cancelled)
            applyLiveBoard(
              boardFromJson(json),
              session.getStatus() === 'connected' ? 'network' : 'cache',
            );
        });
      })
      .catch(() => {
        // Best effort. The REST/offline queue path remains active if live cannot open.
      });

    return () => {
      cancelled = true;
      offChange?.();
      offStatus?.();
      opened?.destroy();
      setLiveSession(null);
      setLiveStatus(null);
    };
  }, [file.id, markSaved, readOnly, selected?.serverUrl, selected?.vault.id, serverUrl, vaultId]);

  // ── Save ──────────────────────────────────────────────────────────────────
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
      setMessage('Saved offline. This board will sync when you reconnect.');
    },
    [serverUrl, vaultId, manifestSequence, markSaved],
  );

  const flushSave = useCallback(async () => {
    if (savingRef.current || readOnly || liveSessionRef.current) return;
    const content = serializeBoard(boardRef.current);
    if (content === savedContentRef.current) return;
    savingRef.current = true;
    if (mountedRef.current) setSaving(true);
    try {
      if (connectedRef.current) {
        try {
          const document = await saveKanbanDocument(
            serverUrl,
            vaultId,
            fileRef.current,
            boardRef.current,
          );
          fileRef.current = document.file;
          markSaved(content);
          if (mountedRef.current) {
            setCurrentFile(document.file);
            setSource('network');
            setPending(null);
          }
          replaceFile(document.file);
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
    // A change landed mid-save: persist the newest board too.
    if (serializeBoard(boardRef.current) !== savedContentRef.current) {
      void flushSave();
    }
  }, [readOnly, serverUrl, vaultId, queueOffline, replaceFile, markSaved]);

  const scheduleSave = useCallback(() => {
    if (liveSessionRef.current) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  // Flush any pending debounced save when the board screen unmounts.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (serializeBoard(boardRef.current) !== savedContentRef.current) void flushSave();
    };
  }, [flushSave]);

  /** Apply a board mutation and schedule a debounced save. */
  const commitBoard = useCallback(
    (next: KanbanBoard) => {
      if (readOnly) return;
      setBoard(next);
      boardRef.current = next;
      setError(null);
      setMessage(null);
      const live = liveSessionRef.current;
      if (live) {
        const content = serializeBoard(next);
        live.writeJson(boardToJson(next));
        markSaved(content);
        setSource(live.getStatus() === 'connected' ? 'network' : 'cache');
        void replicaCacheDocument(serverUrl, vaultId, fileRef.current.id, content).catch(() => {});
        return;
      }
      scheduleSave();
    },
    [markSaved, readOnly, scheduleSave, serverUrl, vaultId],
  );

  // ── Recovery ────────────────────────────────────────────────────────────────
  const reloadBoard = useCallback(async () => {
    const loaded = await readKanbanDocument(
      serverUrl,
      vaultId,
      fileRef.current,
      connectedRef.current,
    );
    if (!mountedRef.current) return;
    setCurrentFile(loaded.file);
    fileRef.current = loaded.file;
    setBoard(loaded.board);
    boardRef.current = loaded.board;
    markSaved(serializeBoard(loaded.board));
    setSource(loaded.source);
  }, [serverUrl, vaultId, markSaved]);

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
        await reloadBoard();
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
      await reloadBoard();
      setMessage('Discarded the queued change.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRecovering(false);
    }
  }

  if (!selected) return null;

  const columns = board.columns;
  const activeIndex = Math.max(
    0,
    columns.findIndex((column) => column.id === selectedColumnId),
  );
  const activeColumn = columns[activeIndex] ?? columns[0] ?? null;
  const activeColumnId = activeColumn?.id ?? null;
  const openCard = openCardId ? (findCard(board, openCardId)?.card ?? null) : null;

  // All distinct tags used anywhere on the board, for tag suggestions.
  const boardTags = useMemo(() => collectBoardTags(board), [board]);

  function goToColumn(index: number) {
    const clamped = Math.max(0, Math.min(columns.length - 1, index));
    const target = columns[clamped];
    if (!target || target.id === activeColumnId) return;
    setSlideDir(clamped > activeIndex ? 1 : -1);
    setSelectedColumnId(target.id);
  }

  function handleTouchStart(event: ReactTouchEvent) {
    const touch = event.touches[0];
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
  }

  function handleTouchEnd(event: ReactTouchEvent) {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start || columns.length < 2) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    // Horizontal, deliberate swipe only (ignore vertical scrolls).
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    goToColumn(activeIndex + (dx < 0 ? 1 : -1));
  }

  function handleAddCard() {
    if (!activeColumnId || readOnly) return;
    const card = createCard('');
    commitBoard(addCardToColumn(board, activeColumnId, card));
    setOpenCardId(card.id);
  }

  function handleAddColumn() {
    if (readOnly || !newColumnTitle.trim()) return;
    const column = createColumn(newColumnTitle);
    commitBoard(addColumn(board, column));
    setSelectedColumnId(column.id);
    setNewColumnTitle('');
    setShowAddColumn(false);
  }

  function handleDeleteColumn(columnId: string) {
    try {
      const next = removeColumn(board, columnId);
      commitBoard(next);
      setSelectedColumnId(next.columns[0]?.id ?? null);
      setEditingColumnId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="screen kanban-screen">
      <header className="note-header">
        <button type="button" className="icon-button" aria-label="Back" onClick={closeSheet}>
          <ArrowLeft size={18} aria-hidden />
        </button>
        <div className="note-title">
          <h1 className="truncate">{currentFile.name}</h1>
          <p>{statusLabel}</p>
        </div>
        <div className="header-side">
          {readOnly ? <ReadOnlyBadge /> : null}
          {saving ? <Spinner size={16} /> : null}
          {!busy && view === 'board' && columns.length > 0 ? (
            <button
              type="button"
              className={`icon-button ${showTools || sortField !== 'manual' || filterQuery ? 'active' : ''}`}
              aria-label="Filter and sort"
              aria-pressed={showTools}
              onClick={() => setShowTools((value) => !value)}
            >
              <SlidersHorizontal size={17} aria-hidden />
            </button>
          ) : null}
          {!busy ? (
            <button
              type="button"
              className={`icon-button ${showViewMenu || view !== 'board' ? 'active' : ''}`}
              aria-label="Switch Kanban view"
              aria-expanded={showViewMenu}
              onClick={() => setShowViewMenu((value) => !value)}
            >
              {view === 'calendar' ? (
                <CalendarDays size={17} aria-hidden />
              ) : view === 'timeline' ? (
                <GanttChart size={17} aria-hidden />
              ) : view === 'archive' ? (
                <Archive size={17} aria-hidden />
              ) : (
                <Columns3 size={17} aria-hidden />
              )}
            </button>
          ) : null}
        </div>
      </header>

      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}

      {showViewMenu ? (
        <div className="kanban-view-menu" role="menu" aria-label="Kanban view">
          {(
            [
              ['board', 'Board', Columns3],
              ['calendar', 'Calendar', CalendarDays],
              ['timeline', 'Timeline', GanttChart],
              ['archive', 'Archive', Archive],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={view === value}
              className={view === value ? 'active' : ''}
              onClick={() => {
                setView(value);
                setShowViewMenu(false);
                setShowTools(false);
              }}
            >
              <Icon size={16} aria-hidden />
              <span>{label}</span>
              {view === value ? <CheckCircle2 size={15} aria-hidden /> : null}
            </button>
          ))}
        </div>
      ) : null}

      {pendingFailed ? (
        <div className="banner banner-error sync-recovery">
          <div className="sync-recovery-text">
            <strong>Couldn’t sync this board</strong>
            <span>{describePendingFailure(pending!)}</span>
          </div>
          <div className="sync-recovery-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => void retrySync()}
              disabled={recovering || !connected}
            >
              {recovering ? <Spinner size={14} /> : <RefreshCw size={14} aria-hidden />}
              Retry
            </button>
            <button
              type="button"
              className="text-button destructive"
              onClick={() => void discardQueued()}
              disabled={recovering}
            >
              <Trash2 size={14} aria-hidden />
              Discard
            </button>
          </div>
        </div>
      ) : pending ? (
        <div className="banner banner-info sync-recovery">
          <div className="sync-recovery-text">
            <span className="sync-recovery-badge">
              <CloudOff size={14} aria-hidden />
              Queued offline
            </span>
            <span>
              {connected
                ? 'Syncing this change to the server…'
                : 'This change will sync automatically when you reconnect.'}
            </span>
          </div>
          <div className="sync-recovery-actions">
            {connected ? (
              <button
                type="button"
                className="text-button"
                onClick={() => void retrySync()}
                disabled={recovering}
              >
                {recovering ? <Spinner size={14} /> : <RefreshCw size={14} aria-hidden />}
                Sync now
              </button>
            ) : null}
            <button
              type="button"
              className="text-button destructive"
              onClick={() => void discardQueued()}
              disabled={recovering}
            >
              <Trash2 size={14} aria-hidden />
              Discard
            </button>
          </div>
        </div>
      ) : source === 'cache' ? (
        <Banner tone="info">
          Showing cached content. Changes you make will sync when you reconnect.
        </Banner>
      ) : null}

      {busy ? (
        <div className="loading-block">
          <Spinner size={22} />
          <span>Loading board…</span>
        </div>
      ) : view === 'calendar' ? (
        <MobileCalendarView board={board} onOpenCard={setOpenCardId} />
      ) : view === 'timeline' ? (
        <MobileTimelineView board={board} onOpenCard={setOpenCardId} />
      ) : view === 'archive' ? (
        <MobileArchiveView board={board} onOpenCard={setOpenCardId} />
      ) : columns.length === 0 ? (
        <div className="kanban-empty">
          <span>This board has no columns yet.</span>
          {!readOnly ? (
            <button type="button" className="primary-button" onClick={() => setShowAddColumn(true)}>
              <Plus size={16} /> Add column
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <nav className="kanban-columns" aria-label="Columns" ref={columnStripRef}>
            {columns.map((column) => {
              const count = column.cards.filter((card) => !card.archived).length;
              const isActive = column.id === activeColumnId;
              return (
                <button
                  key={column.id}
                  type="button"
                  className={`kanban-column-chip ${isActive ? 'active' : ''}`}
                  style={
                    column.color ? ({ '--column-color': column.color } as CSSProperties) : undefined
                  }
                  onClick={() => setSelectedColumnId(column.id)}
                >
                  {column.color ? (
                    <span
                      className="kanban-column-dot"
                      style={{ background: column.color }}
                      aria-hidden
                    />
                  ) : null}
                  <span className="truncate">{column.title}</span>
                  <span className="kanban-column-count">{count}</span>
                </button>
              );
            })}
            {!readOnly ? (
              <>
                <button
                  type="button"
                  className="kanban-column-chip kanban-column-add"
                  aria-label="Add column"
                  onClick={() => setShowAddColumn(true)}
                >
                  <Plus size={15} aria-hidden />
                </button>
                <button
                  type="button"
                  className="kanban-column-chip kanban-column-add"
                  aria-label={`Edit ${activeColumn?.title ?? 'column'}`}
                  disabled={!activeColumn}
                  onClick={() => activeColumn && setEditingColumnId(activeColumn.id)}
                >
                  <Pencil size={15} aria-hidden />
                </button>
              </>
            ) : null}
          </nav>

          {showTools ? (
            <div className="kanban-tools">
              <div className="kanban-tool-search">
                <Search size={15} aria-hidden />
                <input
                  type="text"
                  placeholder="Filter cards"
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                />
                {filterQuery ? (
                  <button
                    type="button"
                    aria-label="Clear filter"
                    onClick={() => setFilterQuery('')}
                  >
                    <X size={14} aria-hidden />
                  </button>
                ) : null}
              </div>
              <div className="kanban-tool-sort" role="group" aria-label="Sort cards">
                {SORT_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={sortField === option.value ? 'selected' : ''}
                    onClick={() => setSortField(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {!readOnly ? (
            <button
              type="button"
              className="kanban-add-card"
              onClick={handleAddCard}
              disabled={!activeColumnId}
            >
              <Plus size={16} aria-hidden />
              Add card to {activeColumn?.title ?? 'column'}
            </button>
          ) : null}

          <div
            className="kanban-scroll"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
          >
            <div className="kanban-pager">
              {/* Only the active column is rendered so the pane height always
                matches the current column (no dead scroll on short columns). The
                key remounts the pane on column change, replaying the slide. */}
              <div
                key={activeColumnId ?? 'none'}
                className={`kanban-pane ${slideDir === 1 ? 'from-right' : 'from-left'}`}
              >
                {(() => {
                  const paneCards = viewCards(
                    (activeColumn?.cards ?? []).filter((card) => !card.archived),
                    filterQuery,
                    sortField,
                  );
                  if (paneCards.length === 0) {
                    return (
                      <div className="kanban-empty">
                        <span>
                          {filterQuery ? 'No cards match your filter.' : 'No cards in this column.'}
                        </span>
                      </div>
                    );
                  }
                  return (
                    <ul className="list kanban-card-list">
                      {paneCards.map((card) => (
                        <li className="list-row" key={card.id}>
                          <button
                            type="button"
                            className="row-main kanban-card-row"
                            onClick={() => setOpenCardId(card.id)}
                          >
                            <div className="kanban-card-main">
                              <div className="kanban-card-title-row">
                                <strong className={card.isDone ? 'kanban-card-done' : ''}>
                                  {card.title}
                                </strong>
                              </div>
                              <CardMeta card={card} />
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  );
                })()}
              </div>
            </div>
          </div>

          {columns.length > 1 ? (
            <div className="kanban-column-dots" role="tablist" aria-label="Column">
              {columns.map((column, index) => (
                <button
                  key={column.id}
                  type="button"
                  role="tab"
                  aria-selected={index === activeIndex}
                  aria-label={column.title}
                  className={`kanban-dot ${index === activeIndex ? 'active' : ''}`}
                  style={
                    column.color ? ({ '--column-color': column.color } as CSSProperties) : undefined
                  }
                  onClick={() => goToColumn(index)}
                />
              ))}
            </div>
          ) : null}
        </>
      )}

      {openCard ? (
        <CardDetailSheet
          card={openCard}
          board={board}
          columnId={findCard(board, openCard.id)?.columnId ?? activeColumnId ?? ''}
          readOnly={readOnly}
          author={author}
          boardTags={boardTags}
          onClose={() => setOpenCardId(null)}
          onChange={commitBoard}
          onDelete={() => {
            commitBoard(removeCard(board, openCard.id));
            setOpenCardId(null);
          }}
          onArchive={() =>
            commitBoard(setCardArchived(board, openCard.id, !openCard.archived, author))
          }
        />
      ) : null}

      {showAddColumn ? (
        <div className="sheet-backdrop" onClick={() => setShowAddColumn(false)}>
          <form
            className="sheet"
            aria-label="Add column"
            onSubmit={(event) => {
              event.preventDefault();
              handleAddColumn();
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="sheet-head">
              <div className="row-text">
                <strong>Add column</strong>
                <span>Create a new board stage</span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => setShowAddColumn(false)}
              >
                <X size={18} />
              </button>
            </div>
            <label className="field">
              <span>Title</span>
              <input
                autoFocus
                value={newColumnTitle}
                onChange={(event) => setNewColumnTitle(event.target.value)}
              />
            </label>
            <button type="submit" className="primary-button" disabled={!newColumnTitle.trim()}>
              <Plus size={16} /> Add column
            </button>
          </form>
        </div>
      ) : null}

      {editingColumnId ? (
        <ColumnEditSheet
          column={columns.find((column) => column.id === editingColumnId) ?? null}
          index={columns.findIndex((column) => column.id === editingColumnId)}
          total={columns.length}
          onClose={() => setEditingColumnId(null)}
          onChange={(patch) =>
            commitBoard(updateColumn(board, editingColumnId, (column) => ({ ...column, ...patch })))
          }
          onMove={(offset) => {
            commitBoard(moveColumn(board, editingColumnId, offset));
          }}
          onDelete={() => handleDeleteColumn(editingColumnId)}
        />
      ) : null}
    </div>
  );
}

function boardCards(board: KanbanBoard): Array<{ card: KanbanCard; column: KanbanColumn }> {
  return board.columns.flatMap((column) => column.cards.map((card) => ({ card, column })));
}

function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function dateOnlyKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function dayDifference(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function cardDateRange(card: KanbanCard): { start: string; end: string } | null {
  const start = card.startDate ?? card.dueDate;
  const end = card.dueDate ?? card.startDate;
  if (!start || !end) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

export function MobileCalendarView({
  board,
  onOpenCard,
}: {
  board: KanbanBoard;
  onOpenCard: (id: string) => void;
}) {
  const today = useMemo(() => new Date(), []);
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState<string | null>(() => dateOnlyKey(today));
  const cards = useMemo(
    () => boardCards(board).filter(({ card }) => !card.archived && cardDateRange(card)),
    [board],
  );
  const firstWeekday = month.getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: Array<{ day: number; key: string } | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1;
      return { day, key: dateOnlyKey(new Date(month.getFullYear(), month.getMonth(), day)) };
    }),
  ];
  const cardsForDay = (key: string) =>
    cards.filter(({ card }) => {
      const range = cardDateRange(card)!;
      return range.start <= key && key <= range.end;
    });
  const selectedCards = selectedDay ? cardsForDay(selectedDay) : [];
  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div className="mobile-board-calendar">
      <div className="mobile-calendar-toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label="Previous month"
          onClick={() =>
            setMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))
          }
        >
          <ChevronLeft size={17} />
        </button>
        <button
          type="button"
          className="mobile-calendar-title"
          aria-label="Return to the current month"
          onClick={() => {
            setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
            setSelectedDay(dateOnlyKey(today));
          }}
        >
          {monthLabel}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Next month"
          onClick={() =>
            setMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))
          }
        >
          <ChevronRight size={17} />
        </button>
      </div>
      <div className="mobile-calendar-weekdays">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="mobile-calendar-grid">
        {cells.map((cell, index) =>
          cell ? (
            (() => {
              const assigned = cardsForDay(cell.key);
              return (
                <button
                  key={cell.key}
                  type="button"
                  className={`mobile-calendar-day ${cell.key === dateOnlyKey(today) ? 'today' : ''} ${selectedDay === cell.key ? 'selected' : ''}`}
                  onClick={() => setSelectedDay(cell.key)}
                >
                  <span>{cell.day}</span>
                  <span className="mobile-calendar-dots" aria-label={`${assigned.length} tasks`}>
                    {assigned.slice(0, 3).map(({ card, column }) => (
                      <i key={card.id} style={{ background: column.color ?? 'var(--primary)' }} />
                    ))}
                    {assigned.length > 3 ? <em>+{assigned.length - 3}</em> : null}
                  </span>
                </button>
              );
            })()
          ) : (
            <span className="mobile-calendar-blank" key={`blank-${index}`} />
          ),
        )}
      </div>
      <div className="mobile-calendar-agenda">
        <h2>
          {selectedDay
            ? parseDateOnly(selectedDay).toLocaleDateString(undefined, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })
            : 'Tasks'}
        </h2>
        {selectedCards.length ? (
          selectedCards.map(({ card, column }) => (
            <button
              key={card.id}
              type="button"
              className="kanban-view-card"
              onClick={() => onOpenCard(card.id)}
            >
              <span
                className="mobile-calendar-task-color"
                style={{ background: column.color ?? 'var(--primary)' }}
              />
              <strong>{card.title}</strong>
              <span>{column.title}</span>
            </button>
          ))
        ) : (
          <p>No tasks assigned to this day.</p>
        )}
      </div>
    </div>
  );
}

export function MobileTimelineView({
  board,
  onOpenCard,
}: {
  board: KanbanBoard;
  onOpenCard: (id: string) => void;
}) {
  const today = useMemo(() => new Date(), []);
  const [rangeStart, setRangeStart] = useState(() => addDays(today, -7));
  const rangeEnd = addDays(rangeStart, TIMELINE_DAYS - 1);
  const days = Array.from({ length: TIMELINE_DAYS }, (_, index) => addDays(rangeStart, index));
  const allCards = boardCards(board).filter(
    ({ card, column }) => !card.archived && !column.hideFromTimeline && cardDateRange(card),
  );
  const cards = allCards
    .filter(({ card }) => {
      const range = cardDateRange(card)!;
      return parseDateOnly(range.start) <= rangeEnd && parseDateOnly(range.end) >= rangeStart;
    })
    .sort((left, right) =>
      cardDateRange(left.card)!.start.localeCompare(cardDateRange(right.card)!.start),
    );
  if (allCards.length === 0)
    return (
      <div className="kanban-empty">
        <span>No cards are scheduled on the timeline.</span>
      </div>
    );
  const trackWidth = TIMELINE_DAYS * TIMELINE_DAY_WIDTH;
  const todayIndex = dayDifference(rangeStart, today);
  return (
    <div className="mobile-board-timeline">
      <div className="mobile-timeline-toolbar">
        <button
          type="button"
          className="icon-button"
          aria-label="Earlier dates"
          onClick={() => setRangeStart((current) => addDays(current, -21))}
        >
          <ChevronLeft size={17} />
        </button>
        <button
          type="button"
          aria-label="Return timeline to today"
          onClick={() => setRangeStart(addDays(today, -7))}
        >
          {rangeStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} -{' '}
          {rangeEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Later dates"
          onClick={() => setRangeStart((current) => addDays(current, 21))}
        >
          <ChevronRight size={17} />
        </button>
      </div>
      <div className="mobile-timeline-scroll">
        <div
          className="mobile-timeline-content"
          style={{ '--timeline-track-width': `${trackWidth}px` } as CSSProperties}
        >
          <div className="mobile-timeline-header">
            <span className="mobile-timeline-label">Task</span>
            <div className="mobile-timeline-days">
              {days.map((day) => (
                <span
                  key={dateOnlyKey(day)}
                  className={dateOnlyKey(day) === dateOnlyKey(today) ? 'today' : ''}
                >
                  <small>{day.toLocaleDateString(undefined, { weekday: 'narrow' })}</small>
                  {day.getDate()}
                </span>
              ))}
            </div>
          </div>
          {cards.length === 0 ? (
            <div className="mobile-timeline-window-empty">No tasks in this date range.</div>
          ) : null}
          {cards.map(({ card, column }) => {
            const range = cardDateRange(card)!;
            const startIndex = Math.max(0, dayDifference(rangeStart, parseDateOnly(range.start)));
            const endIndex = Math.min(
              TIMELINE_DAYS - 1,
              dayDifference(rangeStart, parseDateOnly(range.end)),
            );
            return (
              <button
                key={card.id}
                type="button"
                className="mobile-timeline-row"
                onClick={() => onOpenCard(card.id)}
              >
                <span className="mobile-timeline-label">
                  <i style={{ background: column.color ?? 'var(--primary)' }} />
                  <strong>{card.title}</strong>
                  <small>{column.title}</small>
                </span>
                <span className="mobile-timeline-track">
                  {todayIndex >= 0 && todayIndex < TIMELINE_DAYS ? (
                    <i
                      className="mobile-timeline-today"
                      style={{
                        left: `${todayIndex * TIMELINE_DAY_WIDTH + TIMELINE_DAY_WIDTH / 2}px`,
                      }}
                    />
                  ) : null}
                  <span
                    className="mobile-timeline-bar"
                    style={{
                      left: `${startIndex * TIMELINE_DAY_WIDTH + 3}px`,
                      width: `${Math.max(1, endIndex - startIndex + 1) * TIMELINE_DAY_WIDTH - 6}px`,
                      background: column.color ?? 'var(--primary)',
                    }}
                  />
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MobileArchiveView({
  board,
  onOpenCard,
}: {
  board: KanbanBoard;
  onOpenCard: (id: string) => void;
}) {
  const cards = boardCards(board)
    .filter(({ card }) => card.archived)
    .sort((left, right) => (right.card.archivedAt ?? 0) - (left.card.archivedAt ?? 0));
  if (cards.length === 0)
    return (
      <div className="kanban-empty">
        <span>Archive is empty.</span>
      </div>
    );
  return (
    <div className="kanban-mobile-view">
      {cards.map(({ card, column }) => (
        <button
          key={card.id}
          type="button"
          className="kanban-view-card"
          onClick={() => onOpenCard(card.id)}
        >
          <strong>{card.title}</strong>
          <span>
            {column.title}
            {card.archivedByUserName ? ` · by ${card.archivedByUserName}` : ''}
          </span>
          {card.archivedAt ? <time>{new Date(card.archivedAt).toLocaleString()}</time> : null}
        </button>
      ))}
    </div>
  );
}

function ColumnEditSheet({
  column,
  index,
  total,
  onClose,
  onChange,
  onMove,
  onDelete,
}: {
  column: KanbanColumn | null;
  index: number;
  total: number;
  onClose: () => void;
  onChange: (patch: Partial<KanbanColumn>) => void;
  onMove: (offset: -1 | 1) => void;
  onDelete: () => void;
}) {
  if (!column) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label={`Edit ${column.title}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div className="row-text">
            <strong>Edit column</strong>
            <span>{column.cards.length} cards</span>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label className="field">
          <span>Title</span>
          <input
            value={column.title}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Color</span>
          <ColorPicker
            label="Column color"
            value={column.color ?? '#64748b'}
            onValueChange={(color) => onChange({ color })}
          />
        </label>
        <label className="toggle-row">
          <span>
            <strong>Auto-complete moved cards</strong>
            <small>Cards moved here are marked done.</small>
          </span>
          <input
            type="checkbox"
            checked={column.autoComplete ?? false}
            onChange={(event) => onChange({ autoComplete: event.target.checked })}
          />
        </label>
        <label className="toggle-row">
          <span>
            <strong>Hide from timeline</strong>
            <small>Exclude this column from the timeline view.</small>
          </span>
          <input
            type="checkbox"
            checked={column.hideFromTimeline ?? false}
            onChange={(event) => onChange({ hideFromTimeline: event.target.checked })}
          />
        </label>
        <div className="column-order-actions">
          <button
            type="button"
            className="ghost-button"
            disabled={index <= 0}
            onClick={() => onMove(-1)}
          >
            <ArrowLeft size={15} /> Move left
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={index < 0 || index >= total - 1}
            onClick={() => onMove(1)}
          >
            Move right <ArrowRight size={15} />
          </button>
        </div>
        <button type="button" className="kanban-delete" onClick={onDelete}>
          <Trash2 size={15} /> Delete column
        </button>
      </div>
    </div>
  );
}

function CardMeta({ card }: { card: KanbanCard }) {
  const due = getCardDueStatus(card);
  const checklist = checklistProgress(card);
  const bits: Array<{ key: string; node: ReactNode }> = [];
  if (card.isDone) bits.push({ key: 'done', node: <span className="kanban-chip done">Done</span> });
  if (card.priority) {
    bits.push({
      key: 'priority',
      node: (
        <span className={`kanban-chip priority-${card.priority}`}>
          <span className={`kanban-priority-dot ${card.priority}`} aria-hidden />
          {PRIORITY_LABEL[card.priority]}
        </span>
      ),
    });
  }
  if (due !== 'none') {
    bits.push({
      key: 'due',
      node: <span className={`kanban-chip due-${due}`}>{DUE_LABEL[due]}</span>,
    });
  }
  if (checklist.total > 0) {
    bits.push({
      key: 'checklist',
      node: (
        <span className="kanban-chip">
          {checklist.done}/{checklist.total}
        </span>
      ),
    });
  }
  if (card.comments.length > 0) {
    bits.push({
      key: 'comments',
      node: (
        <span className="kanban-chip">
          <MessageSquare size={11} aria-hidden /> {card.comments.length}
        </span>
      ),
    });
  }
  for (const tag of card.tags.slice(0, 3)) {
    bits.push({ key: `tag-${tag}`, node: <span className="kanban-tag">{tag}</span> });
  }
  if (bits.length === 0) return null;
  return (
    <div className="kanban-card-meta">
      {bits.map((bit) => (
        <span key={bit.key}>{bit.node}</span>
      ))}
    </div>
  );
}

function CardDetailSheet({
  card,
  board,
  columnId,
  readOnly,
  author,
  boardTags,
  onClose,
  onChange,
  onDelete,
  onArchive,
}: {
  card: KanbanCard;
  board: KanbanBoard;
  columnId: string;
  readOnly: boolean;
  author: CommentAuthor;
  boardTags: string[];
  onClose: () => void;
  onChange: (next: KanbanBoard) => void;
  onDelete: () => void;
  onArchive: () => void;
}) {
  const [tagDraft, setTagDraft] = useState('');
  const [checklistDraft, setChecklistDraft] = useState('');
  const [commentDraft, setCommentDraft] = useState('');
  const checklist = checklistProgress(card);

  // Board-wide tags not already on this card, filtered by the current draft.
  const tagSuggestions = useMemo(() => {
    const draft = tagDraft.trim().toLowerCase();
    return boardTags
      .filter((tag) => !card.tags.includes(tag))
      .filter((tag) => !draft || tag.toLowerCase().includes(draft))
      .slice(0, 12);
  }, [boardTags, card.tags, tagDraft]);

  const set = (patch: (value: KanbanCard) => KanbanCard) =>
    onChange(updateCard(board, card.id, patch));

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet kanban-card-sheet"
        role="dialog"
        aria-label={card.title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div className="row-text">
            <strong className="truncate">{card.title || 'Untitled card'}</strong>
            <span>Card details</span>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </div>

        <div className="kanban-card-form">
          <label className="field">
            <span>Title</span>
            <input
              type="text"
              value={card.title}
              readOnly={readOnly}
              onChange={(e) => set((value) => ({ ...value, title: e.target.value }))}
            />
          </label>

          <label className="field">
            <span>Description</span>
            <textarea
              className="kanban-textarea"
              value={card.description ?? ''}
              readOnly={readOnly}
              rows={3}
              onChange={(e) => set((value) => ({ ...value, description: e.target.value }))}
            />
          </label>

          {/* Move / column */}
          {board.columns.length > 1 ? (
            <div className="field">
              <span>Column</span>
              <div className="kanban-move-row">
                {board.columns.map((column) => (
                  <button
                    key={column.id}
                    type="button"
                    className={`kanban-move-chip ${column.id === columnId ? 'active' : ''}`}
                    style={
                      column.color
                        ? ({ '--column-color': column.color } as CSSProperties)
                        : undefined
                    }
                    disabled={readOnly}
                    onClick={() => onChange(moveCardToColumn(board, card.id, column.id))}
                  >
                    {column.color ? (
                      <span
                        className="kanban-column-dot"
                        style={{ background: column.color }}
                        aria-hidden
                      />
                    ) : null}
                    {column.title}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* Priority */}
          <div className="field">
            <span>Priority</span>
            <div className="segmented-control kanban-priority-control">
              {PRIORITIES.map((option) => {
                const current = card.priority ?? 'none';
                const selected = current === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={`${selected ? 'selected' : ''} priority-${option.value}`}
                    disabled={readOnly}
                    onClick={() =>
                      set((value) => ({
                        ...value,
                        priority: option.value === 'none' ? undefined : option.value,
                      }))
                    }
                  >
                    {option.value !== 'none' ? (
                      <span className={`kanban-priority-dot ${option.value}`} aria-hidden />
                    ) : null}
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Dates */}
          <div className="kanban-form-row">
            <div className="field">
              <span>Start date</span>
              <DateField
                value={card.startDate}
                max={card.dueDate || undefined}
                readOnly={readOnly}
                placeholder="No start date"
                onChange={(next) => set((value) => ({ ...value, startDate: next }))}
              />
            </div>
            <div className="field">
              <span>Due date</span>
              <DateField
                value={card.dueDate}
                min={card.startDate || undefined}
                readOnly={readOnly}
                placeholder="No due date"
                onChange={(next) => set((value) => ({ ...value, dueDate: next }))}
              />
            </div>
          </div>

          <button
            type="button"
            className={`kanban-done-toggle ${card.isDone ? 'done' : ''}`}
            disabled={readOnly}
            onClick={() => onChange(toggleCardDone(board, card.id, !card.isDone))}
          >
            {card.isDone ? (
              <CheckCircle2 size={18} aria-hidden />
            ) : (
              <Circle size={18} aria-hidden />
            )}
            {card.isDone ? 'Marked done' : 'Mark done'}
          </button>

          {/* Tags */}
          <div className="field">
            <span>Tags</span>
            <div className="kanban-tag-row">
              {card.tags.map((tag) => (
                <span className="kanban-tag editable" key={tag}>
                  {tag}
                  {!readOnly ? (
                    <button
                      type="button"
                      aria-label={`Remove ${tag}`}
                      onClick={() => onChange(removeTag(board, card.id, tag))}
                    >
                      <X size={11} aria-hidden />
                    </button>
                  ) : null}
                </span>
              ))}
              {card.tags.length === 0 ? <span className="kanban-muted">No tags</span> : null}
            </div>
            {!readOnly ? (
              <>
                <form
                  className="kanban-inline-add"
                  onSubmit={(e) => {
                    e.preventDefault();
                    onChange(addTag(board, card.id, tagDraft));
                    setTagDraft('');
                  }}
                >
                  <input
                    type="text"
                    placeholder="Add a tag"
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="icon-button"
                    aria-label="Add tag"
                    disabled={!tagDraft.trim()}
                  >
                    <Plus size={16} aria-hidden />
                  </button>
                </form>
                {tagSuggestions.length > 0 ? (
                  <div className="kanban-tag-suggestions">
                    <span className="kanban-muted">Existing</span>
                    {tagSuggestions.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="kanban-tag suggestion"
                        onClick={() => {
                          onChange(addTag(board, card.id, tag));
                          setTagDraft('');
                        }}
                      >
                        <Plus size={11} aria-hidden />
                        {tag}
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          {/* Checklist */}
          <div className="field">
            <span>
              Checklist {checklist.total > 0 ? `(${checklist.done}/${checklist.total})` : ''}
            </span>
            <ul className="kanban-checklist">
              {card.checklist.map((item) => (
                <li key={item.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={item.checked}
                      disabled={readOnly}
                      onChange={(e) =>
                        onChange(toggleChecklistItem(board, card.id, item.id, e.target.checked))
                      }
                    />
                    <span className={item.checked ? 'checked' : ''}>{item.text}</span>
                  </label>
                  {!readOnly ? (
                    <button
                      type="button"
                      aria-label="Remove item"
                      onClick={() => onChange(removeChecklistItem(board, card.id, item.id))}
                    >
                      <X size={13} aria-hidden />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {!readOnly ? (
              <form
                className="kanban-inline-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  onChange(addChecklistItem(board, card.id, checklistDraft));
                  setChecklistDraft('');
                }}
              >
                <input
                  type="text"
                  placeholder="Add an item"
                  value={checklistDraft}
                  onChange={(e) => setChecklistDraft(e.target.value)}
                />
                <button
                  type="submit"
                  className="icon-button"
                  aria-label="Add item"
                  disabled={!checklistDraft.trim()}
                >
                  <Plus size={16} aria-hidden />
                </button>
              </form>
            ) : null}
          </div>

          {/* Comments */}
          <div className="field">
            <span>Comments</span>
            <ul className="kanban-comments">
              {card.comments.map((comment) => (
                <li key={comment.id}>
                  <div className="kanban-comment-head">
                    <span className="kanban-comment-author" style={{ color: comment.userColor }}>
                      {comment.userName}
                    </span>
                    <span className="kanban-comment-time">{formatTime(comment.timestamp)}</span>
                  </div>
                  <p>{comment.content}</p>
                </li>
              ))}
              {card.comments.length === 0 ? (
                <span className="kanban-muted">No comments yet</span>
              ) : null}
            </ul>
            {!readOnly ? (
              <form
                className="kanban-inline-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  onChange(addComment(board, card.id, commentDraft, author));
                  setCommentDraft('');
                }}
              >
                <input
                  type="text"
                  placeholder="Add a comment"
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                />
                <button
                  type="submit"
                  className="icon-button"
                  aria-label="Add comment"
                  disabled={!commentDraft.trim()}
                >
                  <Plus size={16} aria-hidden />
                </button>
              </form>
            ) : null}
          </div>

          {!readOnly ? (
            <div className="kanban-card-danger-actions">
              <button type="button" className="kanban-delete" onClick={onArchive}>
                <Archive size={15} aria-hidden />
                {card.archived ? 'Restore card' : 'Archive card'}
              </button>
              <button type="button" className="kanban-delete" onClick={onDelete}>
                <Trash2 size={15} aria-hidden />
                Delete card
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
