import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  Check,
  ChevronRight,
  CloudOff,
  Download,
  FilePlus2,
  FolderOpen,
  Home,
  Info,
  ListChecks,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';

import {
  Banner,
  CacheBadge,
  EmptyState,
  GlyphIcon,
  ReadOnlyBadge,
  Spinner,
} from '../components/ui';
import { isRichViewableFile } from '../lib/assets';
import { useBackDismiss } from '../lib/backStack';
import { isCanvasFile } from '../lib/canvas';
import { downloadEntireVault, downloadEntry, pickAndUploadFiles } from '../lib/fileTransfer';
import { fileGlyph, formatBytes, formatRelativeTime, isReadOnlyRole } from '../lib/format';
import { isInkFile } from '../lib/ink';
import { isKanbanFile } from '../lib/kanban';
import { isLogicFile } from '../lib/logic';
import {
  NEW_DOCUMENT_TYPES,
  newDocumentBaseName,
  newDocumentFileName,
  type NewDocumentKind,
  newDocumentType,
} from '../lib/newDocument';
import { isNoteFile } from '../lib/notes';
import type { FileCacheState } from '../lib/replica';
import { isSheetFile } from '../lib/sheet';
import type { ThemePrefs } from '../lib/theme';
import type { HostedFileEntry } from '../mobileTauri';
import { createHostedDocument } from '../mobileTauri';
import { useMobileStore } from '../state/store';

import { InkScreen } from './InkScreen';
import { KanbanScreen } from './KanbanScreen';
import { NoteScreen } from './NoteScreen';
import { RichFileViewerScreen } from './RichFileViewerScreen';
import { SheetScreen } from './SheetScreen';

const PAGE_SIZE = 60;
const FOLDER_SCAN_BUDGET_MS = 7;
const LONG_PRESS_MS = 450;
const LONG_PRESS_MOVE_TOLERANCE = 10;
const fileCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

function sortFolderEntries(entries: HostedFileEntry[]): HostedFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind === 'folder' && b.kind !== 'folder') return -1;
    if (a.kind !== 'folder' && b.kind === 'folder') return 1;
    return fileCollator.compare(a.name, b.name);
  });
}

export function FilesScreen({ prefs }: { prefs: ThemePrefs }) {
  const selected = useMobileStore((s) => s.selected);
  const files = useMobileStore((s) => s.files);
  const statuses = useMobileStore((s) => s.statuses);
  const filesBusy = useMobileStore((s) => s.filesBusy);
  const filesError = useMobileStore((s) => s.filesError);
  const filesOffline = useMobileStore((s) => s.filesOffline);
  const fileCache = useMobileStore((s) => s.fileCache);
  const trail = useMobileStore((s) => s.folderTrail);
  const activeSheet = useMobileStore((s) => s.activeSheet);
  const loadFiles = useMobileStore((s) => s.loadFiles);
  const refreshCacheStatus = useMobileStore((s) => s.refreshCacheStatus);
  const enterFolder = useMobileStore((s) => s.enterFolder);
  const folderJumpTo = useMobileStore((s) => s.folderJumpTo);
  const openSheet = useMobileStore((s) => s.openSheet);
  const closeSheet = useMobileStore((s) => s.closeSheet);

  const currentParent = trail[trail.length - 1]?.id ?? null;
  const [entries, setEntries] = useState<HostedFileEntry[]>([]);
  const [folderBusy, setFolderBusy] = useState(false);
  const [transferBusy, setTransferBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [createKind, setCreateKind] = useState<NewDocumentKind | null>(null);
  const [newDocumentName, setNewDocumentName] = useState('');
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(() => new Set());
  const longPressRef = useRef<{
    id: string;
    x: number;
    y: number;
    timer: number;
    fired: boolean;
  } | null>(null);
  const readOnly = selected ? isReadOnlyRole(selected.vault.role) : false;
  const connected = selected ? !!statuses[selected.serverUrl]?.connected : false;

  // Back closes the create sheet before navigating out of the folder.
  useBackDismiss(showCreateMenu, () => setShowCreateMenu(false));
  useBackDismiss(createKind !== null, () => setCreateKind(null));

  async function runTransfer(action: () => Promise<void>) {
    setTransferBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setTransferBusy(false);
    }
  }

  // Quick capture opens the flows this screen already owns. It never bypasses
  // the capability checks the corresponding toolbar buttons apply.
  //
  // The handler is held in a ref so the listener can be registered once. Without
  // a dependency array this effect re-subscribed on every render, and adding one
  // would instead capture a stale `handleUpload` (which closes over the current
  // folder), so neither plain form is correct here.
  const captureHandlerRef = useRef<(kind: string | undefined) => void>(() => {});
  captureHandlerRef.current = (kind) => {
    if (!selected || readOnly || !connected) return;
    if (kind === 'capture-note' && selected.vault.capabilities.includes('file.create')) {
      // The widget's capture shortcut still means "a note", not "pick a type".
      setNewDocumentName('');
      setCreateKind('note');
    } else if (
      kind === 'capture-files' &&
      (selected.vault.capabilities.includes('file.create') ||
        selected.vault.capabilities.includes('file.uploadAsset'))
    ) {
      void handleUpload();
    }
  };
  useEffect(() => {
    const onCapture = (event: Event) => {
      captureHandlerRef.current((event as CustomEvent<{ kind?: string }>).detail?.kind);
    };
    window.addEventListener('collab-files-capture', onCapture);
    return () => window.removeEventListener('collab-files-capture', onCapture);
  }, []);

  async function handleUpload() {
    await runTransfer(async () => {
      const result = await pickAndUploadFiles(selected!.serverUrl, selected!.vault, currentParent);
      await loadFiles();
      setActionMessage(
        `${result.completed.length} uploaded${result.failed.length ? ` · ${result.failed.length} failed` : ''}`,
      );
      if (result.failed.length)
        setActionError(
          result.failed.map((failure) => `${failure.name}: ${failure.error}`).join('\n'),
        );
    });
  }

  async function handleCreateDocument() {
    const kind = createKind;
    if (!kind) return;
    await runTransfer(async () => {
      const type = newDocumentType(kind);
      const name = newDocumentFileName(kind, newDocumentName);
      const created = await createHostedDocument(
        selected!.serverUrl,
        selected!.vault.id,
        currentParent,
        name,
        type.documentType,
        type.initialContent(newDocumentBaseName(kind, name)),
      );
      await loadFiles();
      setCreateKind(null);
      setNewDocumentName('');
      const target = type.open(created.id);
      if (target) openSheet(target);
    });
  }

  function toggleEntrySelection(id: string) {
    setSelectedEntryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function cancelLongPress() {
    const pending = longPressRef.current;
    if (pending) window.clearTimeout(pending.timer);
    if (!pending?.fired) longPressRef.current = null;
  }

  function startLongPress(event: ReactPointerEvent, id: string) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    cancelLongPress();
    const pending = {
      id,
      x: event.clientX,
      y: event.clientY,
      timer: 0,
      fired: false,
    };
    pending.timer = window.setTimeout(() => {
      pending.fired = true;
      toggleEntrySelection(id);
      navigator.vibrate?.(20);
    }, LONG_PRESS_MS);
    longPressRef.current = pending;
  }

  function moveLongPress(event: ReactPointerEvent) {
    const pending = longPressRef.current;
    if (!pending || pending.fired) return;
    if (
      Math.abs(event.clientX - pending.x) > LONG_PRESS_MOVE_TOLERANCE ||
      Math.abs(event.clientY - pending.y) > LONG_PRESS_MOVE_TOLERANCE
    ) {
      cancelLongPress();
    }
  }

  function endLongPress() {
    const pending = longPressRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    if (!pending.fired) longPressRef.current = null;
    else
      window.setTimeout(() => {
        longPressRef.current = null;
      }, 0);
  }

  async function handleBatchDownload() {
    await runTransfer(async () => {
      const selectedEntries = entries.filter((entry) => selectedEntryIds.has(entry.id));
      let completed = 0;
      for (const entry of selectedEntries) {
        if (await downloadEntry(selected!.serverUrl, selected!.vault, entry)) completed += 1;
      }
      setSelectedEntryIds(new Set());
      setActionMessage(`${completed} downloaded`);
    });
  }

  // Reveal the folder in pages so a large directory never renders (or cache-checks)
  // thousands of rows at once; more load as the user scrolls to the bottom.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Reset paging whenever the folder or vault changes.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    setSelectedEntryIds(new Set());
  }, [currentParent, selected?.vault.id, selected?.serverUrl]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const collected: HostedFileEntry[] = [];
    let cursor = 0;

    setFolderBusy(files.length > 0);
    setEntries([]);

    const scan = () => {
      const deadline = performance.now() + FOLDER_SCAN_BUDGET_MS;
      while (cursor < files.length && performance.now() < deadline) {
        const entry = files[cursor++];
        if (entry.parentId === currentParent) collected.push(entry);
      }
      if (cancelled) return;
      if (cursor < files.length) {
        timer = window.setTimeout(scan, 0);
        return;
      }
      setEntries(sortFolderEntries(collected));
      setFolderBusy(false);
    };

    timer = window.setTimeout(scan, 0);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [currentParent, files]);

  const visibleEntries = useMemo(() => entries.slice(0, visibleCount), [entries, visibleCount]);
  const selectionMode = selectedEntryIds.size > 0;

  // Load more when the bottom sentinel scrolls into view.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || visibleCount >= entries.length) return;
    const observer = new IntersectionObserver((observed) => {
      if (observed.some((entry) => entry.isIntersecting)) {
        setVisibleCount((count) => Math.min(count + PAGE_SIZE, entries.length));
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visibleCount, entries.length]);

  // Check cache status only for the currently revealed files (incremental).
  useEffect(() => {
    if (visibleEntries.length > 0) void refreshCacheStatus(visibleEntries);
  }, [visibleEntries, refreshCacheStatus]);

  const activeFile = useMemo(() => {
    if (!activeSheet || activeSheet.kind === 'removeOffline') return null;
    return files.find((file) => file.id === activeSheet.fileId) ?? null;
  }, [activeSheet, files]);
  const detailFile = activeSheet?.kind === 'fileDetail' ? activeFile : null;
  const noteFile = activeSheet?.kind === 'note' ? activeFile : null;
  const kanbanFile = activeSheet?.kind === 'kanban' ? activeFile : null;
  const workbookFile = activeSheet?.kind === 'workbook' ? activeFile : null;
  const drawingFile = activeSheet?.kind === 'drawing' ? activeFile : null;
  const viewerFile = activeSheet?.kind === 'viewer' ? activeFile : null;

  if (!selected) {
    return (
      <div className="screen">
        <header className="screen-header">
          <div>
            <h1>Files</h1>
            <p>No vault selected</p>
          </div>
        </header>
        <EmptyState
          icon={<FolderOpen size={28} aria-hidden />}
          title="No vault open"
          message="Pick a vault on the Vaults tab to browse its files."
        />
      </div>
    );
  }

  if (noteFile) {
    return <NoteScreen file={noteFile} prefs={prefs} />;
  }

  if (kanbanFile) {
    return (
      <KanbanScreen
        file={kanbanFile}
        initialCardId={activeSheet?.kind === 'kanban' ? activeSheet.cardId : undefined}
      />
    );
  }

  if (drawingFile) {
    return <InkScreen file={drawingFile} theme={prefs.theme} />;
  }

  if (workbookFile) {
    return <SheetScreen file={workbookFile} />;
  }

  if (viewerFile) {
    return <RichFileViewerScreen file={viewerFile} schematicSymbolSet={prefs.schematicSymbolSet} />;
  }

  return (
    <div className="screen">
      <header className="screen-header">
        <div>
          <h1 className="truncate">
            {selectionMode ? `${selectedEntryIds.size} selected` : selected.vault.name}
          </h1>
          <p>
            {selectionMode
              ? 'Tap more items to add them'
              : readOnly
                ? 'Read-only vault'
                : 'Browsing files'}
          </p>
        </div>
        <div className="header-side">
          {selectionMode ? (
            <>
              <button
                type="button"
                className="icon-button"
                aria-label="Select all in folder"
                onClick={() => setSelectedEntryIds(new Set(entries.map((entry) => entry.id)))}
              >
                <ListChecks size={16} aria-hidden />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Download selected"
                disabled={
                  transferBusy || !connected || !selected.vault.capabilities.includes('vault.read')
                }
                onClick={() => void handleBatchDownload()}
              >
                <Download size={16} aria-hidden />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Clear selection"
                onClick={() => setSelectedEntryIds(new Set())}
              >
                <X size={16} aria-hidden />
              </button>
            </>
          ) : null}
          {!selectionMode && readOnly ? <ReadOnlyBadge /> : null}
          {!selectionMode &&
          !readOnly &&
          connected &&
          selected.vault.capabilities.includes('file.create') ? (
            <button
              type="button"
              className="icon-button"
              aria-label="Create"
              onClick={() => setShowCreateMenu(true)}
            >
              <FilePlus2 size={16} aria-hidden />
            </button>
          ) : null}
          {!selectionMode &&
          !readOnly &&
          connected &&
          (selected.vault.capabilities.includes('file.create') ||
            selected.vault.capabilities.includes('file.uploadAsset')) ? (
            <button
              type="button"
              className="icon-button"
              aria-label="Upload files"
              disabled={transferBusy}
              onClick={() => void handleUpload()}
            >
              <Upload size={16} aria-hidden />
            </button>
          ) : null}
          {!selectionMode && connected && selected.vault.capabilities.includes('vault.export') ? (
            <button
              type="button"
              className="icon-button"
              aria-label="Download entire vault"
              disabled={transferBusy}
              onClick={() =>
                void runTransfer(async () => {
                  await downloadEntireVault(selected.serverUrl, selected.vault);
                })
              }
            >
              <Download size={16} aria-hidden />
            </button>
          ) : null}
          {!selectionMode ? (
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh"
              onClick={() => loadFiles()}
              disabled={filesBusy}
            >
              {filesBusy ? <Spinner size={16} /> : <RefreshCw size={16} aria-hidden />}
            </button>
          ) : null}
        </div>
      </header>

      <nav className="breadcrumbs" aria-label="Folder path">
        {trail.map((crumb, index) => (
          <span className="crumb-wrap" key={`${crumb.id ?? 'root'}-${index}`}>
            {index > 0 ? <ChevronRight size={14} aria-hidden className="crumb-sep" /> : null}
            <button
              type="button"
              className="crumb"
              disabled={index === trail.length - 1}
              onClick={() => folderJumpTo(index)}
            >
              {index === 0 ? <Home size={14} aria-hidden /> : null}
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      {filesOffline ? (
        <div className="offline-strip">
          <CloudOff size={14} aria-hidden />
          <span>Offline — showing the cached copy.</span>
        </div>
      ) : null}

      {filesError ? <Banner tone="error">{filesError}</Banner> : null}
      {actionError ? <Banner tone="error">{actionError}</Banner> : null}
      {actionMessage ? <Banner tone="info">{actionMessage}</Banner> : null}

      {(filesBusy && files.length === 0) || folderBusy ? (
        <div className="loading-block">
          <Spinner size={22} />
          <span>{folderBusy ? 'Loading folder...' : 'Loading files...'}</span>
        </div>
      ) : null}

      {!filesBusy && !folderBusy && entries.length === 0 && !filesError ? (
        <EmptyState
          icon={<FolderOpen size={28} aria-hidden />}
          title="Empty folder"
          message="There are no files here."
        />
      ) : null}

      {!folderBusy ? (
        <ul className="list">
          {visibleEntries.map((entry) => {
            const glyph = fileGlyph(entry);
            const isFolder = entry.kind === 'folder';
            const selectedEntry = selectedEntryIds.has(entry.id);
            return (
              <li className={`list-row ${selectedEntry ? 'selected' : ''}`} key={entry.id}>
                <button
                  type="button"
                  className="row-main file-row"
                  aria-pressed={selectionMode ? selectedEntry : undefined}
                  onPointerDown={(event) => startLongPress(event, entry.id)}
                  onPointerMove={moveLongPress}
                  onPointerUp={endLongPress}
                  onPointerCancel={cancelLongPress}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!selectedEntry) toggleEntrySelection(entry.id);
                  }}
                  onClick={(event) => {
                    if (longPressRef.current?.id === entry.id && longPressRef.current.fired) {
                      event.preventDefault();
                      return;
                    }
                    if (selectionMode) {
                      toggleEntrySelection(entry.id);
                      return;
                    }
                    if (isFolder) {
                      enterFolder({ id: entry.id, name: entry.name });
                    } else if (isLogicFile(entry)) {
                      openSheet({ kind: 'viewer', fileId: entry.id });
                    } else if (isNoteFile(entry)) {
                      openSheet({ kind: 'note', fileId: entry.id });
                    } else if (isKanbanFile(entry)) {
                      openSheet({ kind: 'kanban', fileId: entry.id });
                    } else if (isSheetFile(entry)) {
                      openSheet({ kind: 'workbook', fileId: entry.id });
                    } else if (isInkFile(entry)) {
                      openSheet({ kind: 'drawing', fileId: entry.id });
                    } else if (isRichViewableFile(entry) || isCanvasFile(entry)) {
                      openSheet({ kind: 'viewer', fileId: entry.id });
                    } else {
                      openSheet({ kind: 'fileDetail', fileId: entry.id });
                    }
                  }}
                >
                  <div className={`file-icon glyph-${glyph}`}>
                    <GlyphIcon glyph={glyph} />
                  </div>
                  <div className="row-text">
                    <strong className="truncate">{entry.name}</strong>
                    <span>
                      {isFolder
                        ? 'Folder'
                        : [
                            entry.documentType ?? glyph,
                            formatBytes(entry.sizeBytes),
                            formatRelativeTime(entry.updatedAt),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                    </span>
                  </div>
                  {!isFolder && fileCache[entry.id] ? (
                    <CacheBadge state={fileCache[entry.id]} />
                  ) : null}
                  {selectedEntry ? (
                    <Check size={18} aria-hidden className="row-selected-check" />
                  ) : (
                    <ChevronRight size={18} aria-hidden className="row-chevron" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {visibleCount < entries.length ? (
        <div ref={sentinelRef} className="load-more">
          <Spinner size={16} />
          <span>
            Loading more… ({visibleCount}/{entries.length})
          </span>
        </div>
      ) : null}

      {detailFile ? (
        <FileDetailSheet
          entry={detailFile}
          cacheState={fileCache[detailFile.id]}
          onClose={closeSheet}
        />
      ) : null}

      {showCreateMenu ? (
        <div className="sheet-backdrop" onClick={() => setShowCreateMenu(false)}>
          <div
            className="sheet"
            role="dialog"
            aria-label="Create"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="sheet-head">
              <div className="row-text">
                <strong>Create</strong>
                <span>Added to the current folder</span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => setShowCreateMenu(false)}
              >
                <X size={18} />
              </button>
            </div>
            <ul className="list" aria-label="Document types">
              {NEW_DOCUMENT_TYPES.map((type) => (
                <li key={type.kind}>
                  <button
                    type="button"
                    className="row"
                    onClick={() => {
                      setShowCreateMenu(false);
                      setNewDocumentName('');
                      setCreateKind(type.kind);
                    }}
                  >
                    <span className={`file-icon glyph-${type.glyph}`}>
                      <GlyphIcon glyph={type.glyph} size={18} />
                    </span>
                    <span className="row-text">
                      <strong>{type.label}</strong>
                      <span>.{type.extension}</span>
                    </span>
                    <ChevronRight size={16} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {createKind ? (
        <div className="sheet-backdrop" onClick={() => setCreateKind(null)}>
          <form
            className="sheet"
            aria-label={`Create ${newDocumentType(createKind).label.toLowerCase()}`}
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreateDocument();
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheet-handle" />
            <div className="sheet-head">
              <div className="row-text">
                <strong>New {newDocumentType(createKind).label.toLowerCase()}</strong>
                <span>Created in the current folder</span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => setCreateKind(null)}
              >
                <X size={18} />
              </button>
            </div>
            <label className="field">
              <span>Name</span>
              <input
                autoFocus
                value={newDocumentName}
                placeholder={newDocumentType(createKind).placeholder}
                onChange={(event) => setNewDocumentName(event.target.value)}
              />
            </label>
            <button
              className="primary-button"
              type="submit"
              disabled={transferBusy || !newDocumentName.trim()}
            >
              {transferBusy ? <Spinner size={16} /> : <FilePlus2 size={16} />}
              Create {newDocumentType(createKind).label.toLowerCase()}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

function cacheLabel(state: FileCacheState | undefined): string {
  if (state === 'cached') return 'Available offline';
  if (state === 'stale') return 'Cached copy out of date';
  return 'Not cached';
}

function FileDetailSheet({
  entry,
  cacheState,
  onClose,
}: {
  entry: HostedFileEntry;
  cacheState: FileCacheState | undefined;
  onClose: () => void;
}) {
  const glyph = fileGlyph(entry);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-label={entry.name}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="sheet-head">
          <div className={`file-icon glyph-${glyph}`}>
            <GlyphIcon glyph={glyph} size={22} />
          </div>
          <div className="row-text">
            <strong className="truncate">{entry.name}</strong>
            <span>{entry.documentType ?? entry.kind}</span>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </div>
        <dl className="detail-grid">
          <dt>Path</dt>
          <dd className="mono">{entry.relativePath || entry.name}</dd>
          <dt>Type</dt>
          <dd>{entry.documentType ?? entry.kind}</dd>
          <dt>Size</dt>
          <dd>{formatBytes(entry.sizeBytes)}</dd>
          <dt>Updated</dt>
          <dd>{formatRelativeTime(entry.updatedAt) || '—'}</dd>
          <dt>Offline</dt>
          <dd>{cacheLabel(cacheState)}</dd>
        </dl>
        <div className="sheet-note">
          <Info size={15} aria-hidden />
          <span>Opening and editing this file arrives in a later update.</span>
        </div>
      </div>
    </div>
  );
}
