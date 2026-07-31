import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ChevronRight, ChevronDown, CircuitBoard, FileText, Folder, FolderOpen,
  Plus, FolderPlus, FileUp, Layout, LayoutDashboard, Paperclip, Image as ImageIcon, Trash2,
  Download, FolderSearch, Table2,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useVaultStore } from '../../store/vaultStore';
import { useServerStore } from '../../store/serverStore';
import { tauriCommands } from '../../lib/tauri';
import { importExternalFilesIntoVault, IMPORTABLE_EXTENSIONS } from '../../lib/vaultFileImport';
import type { SheetConversionReport } from '../../types/sheetConversion';
import SheetConversionReportDialog from '../sheet/SheetConversionReportDialog';
import { useNativeFileDrop } from './useNativeFileDrop';
import { useEditorStore } from '../../store/editorStore';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';
import { createVaultClient } from '../../lib/vaultClient';
import { nativeVaultPath, startFileDragOut } from '../../lib/dragOut';
import { isVaultReadOnly, type FileReference, type NoteFile } from '../../types/vault';
import { getCardAttachmentPaths, type KanbanBoard, type KanbanCard } from '../../types/kanban';
import { useKanbanStore } from '../../store/kanbanStore';
import { getVaultDocumentTabType, getVaultDocumentTitle, getVaultDocumentView } from '../../lib/vaultLinks';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuTrigger,
} from '../ui/context-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { toast } from 'sonner';
import { ConfirmDeleteDialog, InputDialog, RenameMovePreviewDialog } from './VaultDialogs';
import TrashPanel from './TrashPanel';
import type { PathChangePreview } from '../../types/vault';
import FileReferencesPanel from './FileReferencesPanel';
import { FileTreeHoverPreviewPopover } from '../previews/FileTreeHoverPreviewPopover';
import { VersionHistoryModal } from '../collaboration/history/VersionHistoryModal';
import { supportsVersionHistoryRelativePath } from '../collaboration/history/historyUtils';
import { createEmptyLogicDiagram } from '../../types/logicDiagram';
import { createEmptySheetDocument, serializeSheetDocument } from '../../lib/sheet/document';
import { isTextDocumentPath, nextAvailableCopyPath } from '../../lib/vaultDuplicate';
import { flattenVaultFiles } from '../../lib/vaultLinks';

type DialogState =
  | { type: 'none' }
  | { type: 'delete'; files: NoteFile[] }
  | { type: 'rename'; file: NoteFile }
  | { type: 'create-note'; parentPath?: string }
  | { type: 'create-logic'; parentPath?: string }
  | { type: 'create-sheet'; parentPath?: string }
  | { type: 'create-folder'; parentPath?: string };

interface TaskAttachmentRef {
  boardPath: string;
  boardName: string;
  columnId: string;
  columnTitle: string;
  cardId: string;
  cardTitle: string;
  card: KanbanCard;
}

const IMAGE_FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const PDF_FILE_EXTENSIONS = new Set(['pdf']);

function isImageFile(node: Pick<NoteFile, 'isFolder' | 'extension'>): boolean {
  return !node.isFolder && IMAGE_FILE_EXTENSIONS.has(node.extension.toLowerCase());
}

function isPdfFile(node: Pick<NoteFile, 'isFolder' | 'extension'>): boolean {
  return !node.isFolder && PDF_FILE_EXTENSIONS.has(node.extension.toLowerCase());
}

function isManagedPicturesFolder(node: Pick<NoteFile, 'isFolder' | 'relativePath'>): boolean {
  return node.isFolder && node.relativePath === 'Pictures';
}

export default function FileTree() {
  const { vault, fileTree, refreshFileTree } = useVaultStore();
  const serverStatus = useServerStore((state) =>
    vault?.kind === 'hosted' ? state.connections[vault.serverUrl]?.status ?? null : null,
  );
  const { openTab, closeTab, renameTab, activeTabPath } = useEditorStore();
  const {
    setActiveView,
    confirmDelete: confirmDeleteEnabled,
    fileTreeHoverPreviewsEnabled,
    fileTreeCollapsedPathsByVault,
    setFileTreeCollapsedPathsForVault,
  } = useUiStore();
  const [dialog, setDialog] = useState<DialogState>({ type: 'none' });
  const [deleteRemoveReferences, setDeleteRemoveReferences] = useState(false);
  const [taskAttachmentsByPath, setTaskAttachmentsByPath] = useState<Record<string, TaskAttachmentRef[]>>({});
  const [mode, setMode] = useState<'files' | 'trash'>('files');
  const [selectedRelativePath, setSelectedRelativePath] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const [selectedReferences, setSelectedReferences] = useState<FileReference[]>([]);
  const [selectedReferencesLoading, setSelectedReferencesLoading] = useState(false);
  const [selectedReferencesError, setSelectedReferencesError] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<{
    preview: PathChangePreview;
    apply: () => Promise<void>;
  } | null>(null);
  const [historyModalPath, setHistoryModalPath] = useState<string | null>(null);
  const collapsedPaths = vault?.path ? (fileTreeCollapsedPathsByVault[vault.path] ?? []) : [];
  const collapsed = useMemo(() => new Set(collapsedPaths), [collapsedPaths]);

  const setCollapsed = useCallback((value: React.SetStateAction<Set<string>>) => {
    if (!vault?.path) return;
    const previous = new Set(collapsedPaths);
    const next = value instanceof Function ? value(previous) : value;
    setFileTreeCollapsedPathsForVault(vault.path, Array.from(next));
  }, [collapsedPaths, setFileTreeCollapsedPathsForVault, vault?.path]);

  function flatten(nodes: NoteFile[]): NoteFile[] {
    const flattened: NoteFile[] = [];
    for (const node of nodes) {
      flattened.push(node);
      if (node.children?.length) {
        flattened.push(...flatten(node.children));
      }
    }
    return flattened;
  }

  const selectedNode = selectedRelativePath
    ? flatten(fileTree).find((entry) => entry.relativePath === selectedRelativePath) ?? null
    : null;
  const hostedReferenceRefreshKey = vault?.kind === 'hosted'
    ? `${serverStatus?.connected ?? false}:${serverStatus?.serverUrl ?? ''}:${serverStatus?.accessExpiresAt ?? ''}`
    : '';

  // Flattened list of nodes currently visible in the tree (respecting collapsed
  // folders), in display order — used for shift-range multi-selection.
  const visibleNodes = useMemo(() => {
    const out: NoteFile[] = [];
    const walk = (nodes: NoteFile[]) => {
      for (const node of nodes) {
        out.push(node);
        if (node.isFolder && !collapsed.has(node.relativePath) && node.children?.length) {
          walk(node.children);
        }
      }
    };
    walk(fileTree);
    return out;
  }, [fileTree, collapsed]);

  const toggleCollapsePath = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, [setCollapsed]);

  const getAffectedOpenTabs = useCallback((oldRelativePath: string) => (
    useEditorStore.getState().openTabs
      .filter((tab) => tab.relativePath === oldRelativePath || tab.relativePath.startsWith(`${oldRelativePath}/`))
      .map((tab) => tab.relativePath)
  ), []);

  const shouldSkipMovePreview = useCallback((preview: PathChangePreview, affectedOpenTabs: string[]) => (
    !preview.blockedReason
    && preview.affectedReferencePaths.length === 0
    && affectedOpenTabs.length === 0
  ), []);

  // ── Drag-and-drop state ────────────────────────────────────────────────────
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null | '__root__'>('__root__');
  const [conversionReport, setConversionReport] = useState<
    { title: string; subtitle?: string; report: SheetConversionReport } | null
  >(null);
  // null = no target, '__root__' = root of vault
  const treeContainerRef = useRef<HTMLDivElement | null>(null);
  const readOnly = isVaultReadOnly(vault);

  // ── External file import (images, PDFs, markdown, canvas, Kanban) ──────────
  const importFiles = useCallback(async (sourcePaths: string[], targetFolder?: string) => {
    if (!vault || sourcePaths.length === 0) return;
    try {
      const result = await importExternalFilesIntoVault(createVaultClient(vault), sourcePaths, {
        targetFolder,
        // Lets a converted `.xlsx`/`.csv` pick a free name instead of colliding
        // with a workbook that is already in the vault.
        existingFiles: flatten(fileTree),
      });
      await refreshFileTree();
      // A conversion is never guaranteed lossless, so its report is surfaced
      // rather than folded into the generic success toast.
      for (const conversion of result.conversions) {
        setConversionReport({
          title: `Converted ${conversion.sourceName}`,
          subtitle: conversion.relativePath,
          report: conversion.report,
        });
      }
      if (result.imported.length > 0) {
        toast.success(
          result.imported.length === 1
            ? `Added ${result.imported[0].split('/').pop()}`
            : `Added ${result.imported.length} files`,
        );
      }
      for (const failure of result.failed) {
        toast.error(`Could not add ${failure.name}: ${failure.error}`);
      }
    } catch (error) {
      toast.error(`Failed to import files: ${error}`);
    }
  }, [fileTree, refreshFileTree, vault]);

  const handleImportButton = useCallback(async () => {
    const selected = await tauriCommands.showOpenFilesDialog(IMPORTABLE_EXTENSIONS);
    if (selected) await importFiles(selected);
  }, [importFiles]);

  // Resolve the folder under the drop point so a file dropped onto a folder lands
  // inside it; anywhere else imports to the vault root.
  const handleNativeFileDrop = useCallback((paths: string[], point: { x: number; y: number }) => {
    const element = document.elementFromPoint(point.x, point.y);
    const folderEl = element?.closest('[data-tree-folder-path]') as HTMLElement | null;
    const targetFolder = folderEl?.dataset.treeFolderPath || undefined;
    void importFiles(paths, targetFolder);
  }, [importFiles]);

  const { isDraggingOver: isDraggingFiles } = useNativeFileDrop(
    treeContainerRef,
    handleNativeFileDrop,
    mode === 'files' && !!vault && !readOnly,
  );

  const handleOpenFile = useCallback((file: NoteFile) => {
    const type = getVaultDocumentTabType(file.relativePath);
    openTab(file.relativePath, file.name, type);
    if (type === 'canvas') setActiveView('canvas');
    else if (type === 'kanban') setActiveView('kanban');
    else setActiveView('editor');
  }, [openTab, setActiveView]);

  const handleNodeClick = useCallback((node: NoteFile, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    // Shift-click: select the contiguous range between the anchor and this node.
    if (event.shiftKey && selectedRelativePath) {
      const anchorIndex = visibleNodes.findIndex((entry) => entry.relativePath === selectedRelativePath);
      const targetIndex = visibleNodes.findIndex((entry) => entry.relativePath === node.relativePath);
      if (anchorIndex !== -1 && targetIndex !== -1) {
        const [low, high] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        setSelectedPaths(new Set(visibleNodes.slice(low, high + 1).map((entry) => entry.relativePath)));
        return;
      }
    }
    // Ctrl/Cmd-click: toggle this node in the selection without opening it.
    if (event.metaKey || event.ctrlKey) {
      setSelectedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(node.relativePath)) next.delete(node.relativePath);
        else next.add(node.relativePath);
        return next;
      });
      setSelectedRelativePath(node.relativePath);
      return;
    }
    // Plain click: single-select and open/toggle as before.
    setSelectedPaths(new Set([node.relativePath]));
    setSelectedRelativePath(node.relativePath);
    if (node.isFolder) toggleCollapsePath(node.relativePath);
    else handleOpenFile(node);
  }, [handleOpenFile, selectedRelativePath, toggleCollapsePath, visibleNodes]);

  const handleCreateNote = (parentPath?: string) => {
    setDialog({ type: 'create-note', parentPath });
  };

  const handleCreateLogic = (parentPath?: string) => {
    setDialog({ type: 'create-logic', parentPath });
  };

  const handleCreateSheet = (parentPath?: string) => {
    setDialog({ type: 'create-sheet', parentPath });
  };

  const handleCreateFolder = (parentPath?: string) => {
    setDialog({ type: 'create-folder', parentPath });
  };

  const handleDelete = (file: NoteFile) => {
    if (isManagedPicturesFolder(file)) {
      toast.error('The Pictures folder is managed by the app and cannot be deleted');
      return;
    }
    setDeleteRemoveReferences(false);
    if (!confirmDeleteEnabled) {
      void moveFilesToTrash([file]);
      return;
    }
    setDialog({ type: 'delete', files: [file] });
  };

  // When several entries are selected, dropping a folder also trashes its
  // descendants — drop any selected child whose ancestor folder is also selected
  // so we don't try to trash an already-moved path.
  const dedupeNested = (files: NoteFile[]): NoteFile[] => {
    const folderPrefixes = files.filter((file) => file.isFolder).map((file) => `${file.relativePath}/`);
    return files.filter((file) => !folderPrefixes.some((prefix) => file.relativePath.startsWith(prefix)));
  };

  const requestDeleteForPaths = (paths: string[]) => {
    const all = flatten(fileTree);
    const files = dedupeNested(
      paths
        .map((path) => all.find((entry) => entry.relativePath === path))
        .filter((entry): entry is NoteFile => !!entry && !isManagedPicturesFolder(entry)),
    );
    if (files.length === 0) return;
    setDeleteRemoveReferences(false);
    if (!confirmDeleteEnabled) {
      void moveFilesToTrash(files);
      return;
    }
    setDialog({ type: 'delete', files });
  };

  const handleRename = (file: NoteFile) => {
    setDialog({ type: 'rename', file });
  };

  const isLocalVault = !!vault && vault.kind !== 'hosted';

  const handleReveal = async (file: NoteFile) => {
    if (!vault || !isLocalVault) return;
    try {
      const absolute = await tauriCommands.resolveVaultFilePath(vault.path, file.relativePath);
      await tauriCommands.revealInFileManager(absolute);
    } catch (e) {
      toast.error(`Could not reveal ${file.name}: ${e}`);
    }
  };

  // Native drag-out to the OS / another app instance. Local-only: the OS drag
  // must begin synchronously within the gesture, so we need the file's real path
  // immediately (hosted files would require an async fetch, and "Download" covers
  // exporting those). Works for both files and folders on local vaults.
  const handleDragOut = (file: NoteFile) => {
    if (!vault || !isLocalVault) return;
    void startFileDragOut([nativeVaultPath(vault.path, file.relativePath)]).catch((e) =>
      toast.error(`Could not drag ${file.name}: ${e}`),
    );
  };

  const handleDownload = async (file: NoteFile) => {
    if (!vault || file.isFolder) return;
    try {
      const dataUrl = await createVaultClient(vault).readAssetDataUrl(file.relativePath);
      const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
      const dest = await tauriCommands.showDownloadDialog(file.name);
      if (!dest) return;
      await tauriCommands.writeDownloadedFile(dest, base64);
      toast.success(`Downloaded ${file.name}`);
    } catch (e) {
      toast.error(`Could not download ${file.name}: ${e}`);
    }
  };

  const handleDuplicate = async (file: NoteFile) => {
    if (!vault || file.isFolder) return;
    try {
      const client = createVaultClient(vault);
      const source = await client.readDocument(file.relativePath);
      const target = nextAvailableCopyPath(file.relativePath, flattenVaultFiles(fileTree));
      await client.createDocument(target);
      const created = await client.readDocument(target);
      await client.writeDocument(target, source.content, created.version, created.content);
      await refreshFileTree();
      toast.success(`Duplicated to ${target}`);
    } catch (e) {
      toast.error(`Could not duplicate ${file.name}: ${e}`);
    }
  };

  const closeTabsForFile = (file: NoteFile) => {
    const prefix = file.isFolder ? `${file.relativePath}/` : null;
    for (const tab of useEditorStore.getState().openTabs) {
      if (tab.relativePath === file.relativePath || (prefix && tab.relativePath.startsWith(prefix))) {
        closeTab(tab.relativePath);
      }
    }
  };

  const confirmDelete = async () => {
    if (dialog.type !== 'delete' || !vault) return;
    const { files } = dialog;
    setDialog({ type: 'none' });
    const client = createVaultClient(vault);
    let succeeded = 0;
    for (const file of files) {
      try {
        await client.deletePermanently(file.relativePath, deleteRemoveReferences);
        closeTabsForFile(file);
        succeeded += 1;
      } catch (e) { toast.error(`Failed to delete ${file.name}: ${e}`); }
    }
    await refreshFileTree();
    setSelectedPaths(new Set());
    if (succeeded > 0) {
      toast.success(succeeded === 1 ? `Deleted ${files[0].name}` : `Deleted ${succeeded} items`);
    }
    setDeleteRemoveReferences(false);
  };

  const moveFilesToTrash = async (files: NoteFile[]) => {
    if (!vault || files.length === 0) return;
    const client = createVaultClient(vault);
    let succeeded = 0;
    for (const file of files) {
      try {
        await client.moveToTrash(file.relativePath, deleteRemoveReferences);
        closeTabsForFile(file);
        succeeded += 1;
      } catch (error) {
        toast.error(`Failed to move ${file.name} to trash: ${error}`);
      }
    }
    await refreshFileTree();
    setSelectedPaths(new Set());
    if (succeeded > 0) {
      setMode('trash');
      toast.success(succeeded === 1 ? `Moved ${files[0].name} to trash` : `Moved ${succeeded} items to trash`);
    }
    setDeleteRemoveReferences(false);
  };

  const moveToTrash = async () => {
    if (dialog.type !== 'delete') return;
    const { files } = dialog;
    setDialog({ type: 'none' });
    await moveFilesToTrash(files);
  };

  const confirmCreate = async (name: string) => {
    if (!vault) return;
    if (dialog.type === 'create-note') {
      const { parentPath } = dialog;
      setDialog({ type: 'none' });
      const relativePath = parentPath ? `${parentPath}/${name}.md` : `${name}.md`;
      try {
        await createVaultClient(vault).createDocument(relativePath);
        await refreshFileTree();
        openTab(relativePath, name, 'note');
        setActiveView('editor');
      } catch (e) { toast.error('Failed to create note: ' + e); }
    } else if (dialog.type === 'create-logic') {
      const { parentPath } = dialog;
      setDialog({ type: 'none' });
      const stem = name.replace(/\.logic$/i, '');
      const relativePath = parentPath ? `${parentPath}/${stem}.logic` : `${stem}.logic`;
      try {
        const client = createVaultClient(vault);
        await client.createDocument(relativePath);
        const created = await client.readDocument(relativePath);
        await client.writeDocument(
          relativePath,
          JSON.stringify(createEmptyLogicDiagram(stem), null, 2),
          created.version,
          created.content,
        );
        await refreshFileTree();
        openTab(relativePath, stem, 'logic');
        setActiveView('editor');
      } catch (e) { toast.error('Failed to create logic diagram: ' + e); }
    } else if (dialog.type === 'create-sheet') {
      const { parentPath } = dialog;
      setDialog({ type: 'none' });
      const stem = name.replace(/\.sheet$/i, '');
      const relativePath = parentPath ? `${parentPath}/${stem}.sheet` : `${stem}.sheet`;
      try {
        const client = createVaultClient(vault);
        await client.createDocument(relativePath);
        const created = await client.readDocument(relativePath);
        await client.writeDocument(
          relativePath,
          serializeSheetDocument(createEmptySheetDocument(stem)),
          created.version,
          created.content,
        );
        await refreshFileTree();
        openTab(relativePath, stem, 'sheet');
        setActiveView('editor');
      } catch (e) { toast.error('Failed to create spreadsheet: ' + e); }
    } else if (dialog.type === 'create-folder') {
      const { parentPath } = dialog;
      setDialog({ type: 'none' });
      const relativePath = parentPath ? `${parentPath}/${name}` : name;
      try {
        await createVaultClient(vault).createFolder(relativePath);
        await refreshFileTree();
      } catch (e) { toast.error('Failed to create folder: ' + e); }
    }
  };

  const confirmRename = async (newName: string) => {
    if (dialog.type !== 'rename' || !vault) return;
    const { file } = dialog;
    setDialog({ type: 'none' });
    if (newName === file.name) return;
    const trimmedName = newName.trim();
    if (!trimmedName) return;
    const parts = file.relativePath.split('/');
    const nextSegment = file.isFolder
      ? trimmedName
      : `${trimmedName.replace(new RegExp(`\\.${file.extension}$`, 'i'), '')}.${file.extension}`;
    parts[parts.length - 1] = nextSegment;
    const newPath = parts.join('/');
    try {
      const client = createVaultClient(vault);
      const preview = await client.previewRenameMove(file.relativePath, newPath);
      setPreviewState({
        preview,
        apply: async () => {
          await client.renameMove(file.relativePath, newPath);
          renameTab(file.relativePath, newPath, nextSegment.replace(/\.[^.]+$/, ''));
          await refreshFileTree();
        },
      });
    } catch (e) { toast.error('Failed to prepare rename: ' + e); }
  };

  // ── Move file via drag ─────────────────────────────────────────────────────
  const handleMove = useCallback(async (fromPath: string, toFolderPath: string | '__root__') => {
    if (!vault) return;
    const fileName = fromPath.split('/').pop()!;
    const newPath = toFolderPath === '__root__' ? fileName : `${toFolderPath}/${fileName}`;

    // Already in the right place
    const currentFolder = fromPath.includes('/')
      ? fromPath.split('/').slice(0, -1).join('/')
      : '__root__';
    if (currentFolder === toFolderPath) return;

    // Don't drop a folder into itself or a descendant
    if (toFolderPath !== '__root__' && toFolderPath.startsWith(fromPath + '/')) return;
    if (fromPath === toFolderPath) return;

    try {
      const client = createVaultClient(vault);
      const preview = await client.previewRenameMove(fromPath, newPath);
      const applyMove = async () => {
        await client.renameMove(fromPath, newPath);
        renameTab(fromPath, newPath, fileName.replace(/\.[^.]+$/, ''));
        await refreshFileTree();
      };
      const affectedOpenTabs = getAffectedOpenTabs(fromPath);
      if (shouldSkipMovePreview(preview, affectedOpenTabs)) {
        await applyMove();
        return;
      }
      setPreviewState({
        preview,
        apply: applyMove,
      });
    } catch (e) { toast.error('Failed to preview move: ' + e); }
  }, [getAffectedOpenTabs, refreshFileTree, renameTab, shouldSkipMovePreview, vault]);

  useEffect(() => {
    if (!vault) return;
    let cancelled = false;

    function flatten(nodes: NoteFile[]): NoteFile[] {
      const flattened: NoteFile[] = [];
      for (const node of nodes) {
        flattened.push(node);
        if (node.children?.length) {
          flattened.push(...flatten(node.children));
        }
      }
      return flattened;
    }

    const kanbanFiles = flatten(fileTree).filter((node) => !node.isFolder && node.extension === 'kanban');

    void Promise.all(
      kanbanFiles.map(async (file) => {
        try {
          const { content } = await createVaultClient(vault).readDocument(file.relativePath);
          const board = JSON.parse(content) as KanbanBoard;
          return board.columns.reduce<Array<{ path: string; ref: TaskAttachmentRef }>>((items, column) => {
            column.cards.forEach((card) => {
              getCardAttachmentPaths(card).forEach((path) => {
                items.push({
                  path,
                  ref: {
                    boardPath: file.relativePath,
                    boardName: file.name,
                    columnId: column.id,
                    columnTitle: column.title,
                    cardId: card.id,
                    cardTitle: card.title,
                    card,
                  },
                });
              });
            });
            return items;
          }, []);
        } catch {
          return [];
        }
      }),
    ).then((attachedLists) => {
      if (cancelled) return;
      const next: Record<string, TaskAttachmentRef[]> = {};
      for (const attachedList of attachedLists) {
        for (const item of attachedList) {
          next[item.path] ??= [];
          next[item.path].push(item.ref);
        }
      }
      setTaskAttachmentsByPath(next);
    });

    return () => { cancelled = true; };
  }, [vault?.path, fileTree]);

  // Reflect the active tab as the tree selection, but only when the active tab
  // actually changes — not when the user adjusts the selection in the tree
  // (otherwise ctrl/shift multi-selection would be clobbered).
  const lastSyncedActiveTab = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== 'files' || !activeTabPath) return;
    if (lastSyncedActiveTab.current === activeTabPath) return;
    const existing = flatten(fileTree).find((entry) => entry.relativePath === activeTabPath);
    if (!existing) return;
    lastSyncedActiveTab.current = activeTabPath;
    setSelectedRelativePath(activeTabPath);
    setSelectedPaths(new Set([activeTabPath]));
  }, [activeTabPath, fileTree, mode]);

  // Press Delete to trash the selected files, or the file under the cursor when
  // nothing is selected. A latest-state ref keeps the global listener stable.
  const deleteKeyActionRef = useRef<(event: KeyboardEvent) => void>(() => {});
  deleteKeyActionRef.current = (event: KeyboardEvent) => {
    if (mode !== 'files' || readOnly) return;
    if (dialog.type !== 'none' || previewState) return;
    const targets = selectedPaths.size > 0
      ? Array.from(selectedPaths)
      : hoveredPath
      ? [hoveredPath]
      : [];
    if (targets.length === 0) return;
    event.preventDefault();
    requestDeleteForPaths(targets);
  };

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== 'Delete') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      deleteKeyActionRef.current(event);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (!vault || !selectedRelativePath || mode !== 'files' || !selectedNode || selectedNode.isFolder) {
      setSelectedReferences([]);
      setSelectedReferencesLoading(false);
      setSelectedReferencesError(null);
      return;
    }

    let cancelled = false;
    setSelectedReferencesLoading(true);
    setSelectedReferencesError(null);
    void createVaultClient(vault).listReferences(selectedRelativePath)
      .then((references) => {
        if (cancelled) return;
        setSelectedReferences(references);
      })
      .catch((error) => {
        if (cancelled) return;
        setSelectedReferences([]);
        setSelectedReferencesError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setSelectedReferencesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hostedReferenceRefreshKey, mode, selectedNode?.isFolder, selectedRelativePath, vault?.path]);

  const selectedFile = selectedNode && !selectedNode.isFolder ? selectedNode : null;

  const handleOpenReference = useCallback((reference: FileReference) => {
    const type = getVaultDocumentTabType(reference.sourceRelativePath);
    openTab(reference.sourceRelativePath, getVaultDocumentTitle(reference.sourceRelativePath), type);
    setActiveView(getVaultDocumentView(type));
  }, [openTab, setActiveView]);

  if (!vault) return null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Dialogs */}
      <SheetConversionReportDialog
        open={conversionReport !== null}
        onOpenChange={(open) => { if (!open) setConversionReport(null); }}
        title={conversionReport?.title ?? ''}
        subtitle={conversionReport?.subtitle}
        report={conversionReport?.report ?? null}
      />
      <ConfirmDeleteDialog
        open={dialog.type === 'delete'}
        name={dialog.type === 'delete' ? dialog.files[0]?.name ?? '' : ''}
        isFolder={dialog.type === 'delete' ? dialog.files[0]?.isFolder ?? false : false}
        itemCount={dialog.type === 'delete' ? dialog.files.length : 1}
        primaryActionLabel="Delete permanently"
        showReferenceOption={dialog.type === 'delete'}
        removeReferences={deleteRemoveReferences}
        onRemoveReferencesChange={setDeleteRemoveReferences}
        onMoveToTrash={() => void moveToTrash()}
        onDeletePermanently={confirmDelete}
        onConfirm={confirmDelete}
        onCancel={() => {
          setDialog({ type: 'none' });
          setDeleteRemoveReferences(false);
        }}
      />
      <InputDialog
        open={dialog.type === 'create-note' || dialog.type === 'create-logic' || dialog.type === 'create-sheet' || dialog.type === 'create-folder' || dialog.type === 'rename'}
        variant={
          dialog.type === 'create-note' ? 'create-note'
          : dialog.type === 'create-logic' ? 'create-logic'
          : dialog.type === 'create-sheet' ? 'create-sheet'
          : dialog.type === 'create-folder' ? 'create-folder'
          : 'rename'
        }
        initialValue={dialog.type === 'rename' ? dialog.file.name : ''}
        onConfirm={dialog.type === 'rename' ? confirmRename : confirmCreate}
        onCancel={() => setDialog({ type: 'none' })}
      />
      <RenameMovePreviewDialog
        open={!!previewState}
        preview={previewState?.preview ?? null}
        affectedOpenTabs={
          previewState
            ? getAffectedOpenTabs(previewState.preview.oldRelativePath)
            : []
        }
        onConfirm={() => {
          if (!previewState) return;
          void previewState.apply()
            .catch((error) => toast.error(`Failed to apply path change: ${error}`))
            .finally(() => setPreviewState(null));
        }}
        onCancel={() => setPreviewState(null)}
      />

      {/* Toolbar row */}
      <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-border/30">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMode('files')}
            className={cn(
              'rounded px-2 py-1 text-[11px] font-medium transition-colors',
              mode === 'files' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            Files
          </button>
          <button
            onClick={() => setMode('trash')}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
              mode === 'trash' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
            )}
          >
            <Trash2 size={11} />
            Trash
          </button>
        </div>
        {mode === 'files' && (
          <div className="flex items-center gap-0.5">
            {!readOnly && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => handleCreateNote()}
                      className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors app-motion-fast"
                    >
                      <Plus size={13} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs text-foreground">New note</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => handleCreateFolder()}
                      className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors app-motion-fast"
                    >
                      <FolderPlus size={13} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs text-foreground">New folder</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => handleCreateLogic()}
                      className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors app-motion-fast"
                    >
                      <CircuitBoard size={13} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs text-foreground">New logic diagram</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => handleCreateSheet()}
                      className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors app-motion-fast"
                    >
                      <Table2 size={13} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs text-foreground">New spreadsheet</TooltipContent>
                </Tooltip>
              </>
            )}
            {!readOnly && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-label="Add files to vault"
                    onClick={handleImportButton}
                    className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors app-motion-fast"
                  >
                    <FileUp size={13} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs text-foreground">Add files (images, PDFs, markdown, canvas, Kanban, logic, spreadsheets)</TooltipContent>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {/* Tree — root is also a drop target */}
      {mode === 'trash' ? (
        <TrashPanel />
      ) : (
      <div
        ref={treeContainerRef}
        className={cn(
          'flex-1 overflow-y-auto py-1 transition-colors duration-100 app-motion-fast',
          dropTargetPath === '__root__' && draggingPath ? 'bg-primary/5' : '',
          isDraggingFiles ? 'ring-2 ring-inset ring-primary/40 bg-primary/5' : ''
        )}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTargetPath('__root__'); }}
        onDragLeave={(e) => {
          // Only clear if leaving the root container (not entering a child)
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setDropTargetPath(null);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (draggingPath && dropTargetPath === '__root__') {
            handleMove(draggingPath, '__root__');
          }
          setDraggingPath(null);
          setDropTargetPath(null);
        }}
      >
        {fileTree.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground/50">
            <p>No notes yet.</p>
            <button
              onClick={() => handleCreateNote()}
              className="mt-2 text-primary/70 hover:text-primary transition-colors app-motion-fast underline underline-offset-2"
            >
              Create your first note
            </button>
          </div>
        ) : (
          fileTree.map((node) => (
            <FileTreeNode
              key={node.relativePath}
              node={node}
              depth={0}
              collapsed={collapsed}
              setCollapsed={setCollapsed}
              onOpenFile={handleOpenFile}
              onCreateNote={handleCreateNote}
              onCreateLogic={handleCreateLogic}
              onCreateSheet={handleCreateSheet}
              onCreateFolder={handleCreateFolder}
              onDelete={handleDelete}
              onRename={handleRename}
              onReveal={handleReveal}
              onDownload={handleDownload}
              onDuplicate={handleDuplicate}
              canDuplicate={!readOnly}
              onDragOut={handleDragOut}
              canReveal={isLocalVault}
              onViewHistory={setHistoryModalPath}
              onNodeClick={handleNodeClick}
              selectedPaths={selectedPaths}
              onHover={setHoveredPath}
              draggingPath={draggingPath}
              dropTargetPath={dropTargetPath}
              taskAttachmentsByPath={taskAttachmentsByPath}
              setDraggingPath={setDraggingPath}
              setDropTargetPath={setDropTargetPath}
              onMove={handleMove}
              fileTreeHoverPreviewsEnabled={fileTreeHoverPreviewsEnabled}
            />
          ))
        )}
      </div>
      )}
      {mode === 'files' && selectedFile && selectedPaths.size <= 1 ? (
        <FileReferencesPanel
          selectedFile={selectedFile}
          references={selectedReferences}
          loading={selectedReferencesLoading}
          error={selectedReferencesError}
          onOpenReference={handleOpenReference}
        />
      ) : null}
      <VersionHistoryModal
        open={historyModalPath !== null}
        relativePath={historyModalPath}
        onOpenChange={(open) => {
          if (!open) setHistoryModalPath(null);
        }}
      />
    </div>
  );
}

interface FileTreeNodeProps {
  node: NoteFile;
  depth: number;
  collapsed: Set<string>;
  setCollapsed: React.Dispatch<React.SetStateAction<Set<string>>>;
  onOpenFile: (file: NoteFile) => void;
  onCreateNote: (parentPath?: string) => void;
  onCreateLogic: (parentPath?: string) => void;
  onCreateSheet: (parentPath?: string) => void;
  onCreateFolder: (parentPath?: string) => void;
  onDelete: (file: NoteFile) => void;
  onRename: (file: NoteFile) => void;
  onReveal: (file: NoteFile) => void;
  onDownload: (file: NoteFile) => void;
  onDuplicate: (file: NoteFile) => void;
  canDuplicate: boolean;
  onDragOut: (file: NoteFile) => void;
  canReveal: boolean;
  onViewHistory: (relativePath: string) => void;
  onNodeClick: (node: NoteFile, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void;
  selectedPaths: Set<string>;
  onHover: (relativePath: string | null) => void;
  draggingPath: string | null;
  dropTargetPath: string | null | '__root__';
  taskAttachmentsByPath: Record<string, TaskAttachmentRef[]>;
  setDraggingPath: (path: string | null) => void;
  setDropTargetPath: (path: string | null | '__root__') => void;
  onMove: (fromPath: string, toFolderPath: string | '__root__') => void;
  fileTreeHoverPreviewsEnabled: boolean;
}

function FileTreeNode({
  node, depth, collapsed, setCollapsed,
  onOpenFile, onCreateNote, onCreateLogic, onCreateSheet, onCreateFolder, onDelete, onRename, onReveal, onDownload, onDuplicate, canDuplicate, onDragOut, canReveal, onViewHistory,
  onNodeClick, selectedPaths, onHover,
  draggingPath, dropTargetPath, taskAttachmentsByPath, setDraggingPath, setDropTargetPath, onMove,
  fileTreeHoverPreviewsEnabled,
}: FileTreeNodeProps) {
  const { activeTabPath, openTab } = useEditorStore();
  const { peers } = useCollabStore();
  const { setActiveView } = useUiStore();
  const { setEditing } = useKanbanStore();
  const [attachmentPopoverOpen, setAttachmentPopoverOpen] = useState(false);
  const [hoverPreviewAnchorRect, setHoverPreviewAnchorRect] = useState<DOMRect | null>(null);
  const [suppressHtmlDrag, setSuppressHtmlDrag] = useState(false);
  const dragOutCandidateRef = useRef<{ x: number; y: number } | null>(null);

  const isCollapsed = collapsed.has(node.relativePath);
  const isActive = activeTabPath === node.relativePath;
  const isSelected = selectedPaths.has(node.relativePath);
  const activePeers = peers.filter((p) => p.activeFile === node.relativePath);
  const isDraggingThis = draggingPath === node.relativePath;
  const isDropTarget = node.isFolder && dropTargetPath === node.relativePath && draggingPath !== null;
  const attachmentRefs = taskAttachmentsByPath[node.relativePath] ?? [];
  const isTaskAttached = !node.isFolder && attachmentRefs.length > 0;
  const isImageAsset = isImageFile(node);
  const isPdfAsset = isPdfFile(node);
  const isManagedFolder = isManagedPicturesFolder(node);
  const supportsVersionHistory = supportsVersionHistoryRelativePath(node.relativePath, node.isFolder);
  const isDuplicableDocument = !node.isFolder && canDuplicate && isTextDocumentPath(node.relativePath);

  const getFileIcon = () => {
    if (node.isFolder) {
      return isCollapsed
        ? <Folder size={13} className={cn('transition-colors app-motion-fast', isDropTarget ? 'text-primary' : 'text-primary/60')} />
        : <FolderOpen size={13} className={cn('transition-colors app-motion-fast', isDropTarget ? 'text-primary' : 'text-primary/60')} />;
    }
    if (isImageAsset) return <ImageIcon size={13} className="text-sky-400/80" />;
    if (node.extension === 'canvas')  return <Layout size={13} className="text-blue-400/70" />;
    if (node.extension === 'kanban')  return <LayoutDashboard size={13} className="text-emerald-400/70" />;
    if (node.extension === 'logic')   return <CircuitBoard size={13} className="text-cyan-400/75" />;
    if (node.extension === 'sheet')   return <Table2 size={13} className="text-violet-400/75" />;
    return <FileText size={13} className="text-muted-foreground/70" />;
  };

  function openAttachedTask(ref: TaskAttachmentRef) {
    openTab(ref.boardPath, ref.boardName, 'kanban');
    setActiveView('kanban');
    setEditing(ref.boardPath, ref.cardId, ref.columnId, ref.card);
    setAttachmentPopoverOpen(false);
  }

  useEffect(() => {
    if (!suppressHtmlDrag) return;
    const handleMouseMove = (event: MouseEvent) => {
      const candidate = dragOutCandidateRef.current;
      if (!candidate) return;
      const moved = Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y);
      if (moved < 4) return;
      dragOutCandidateRef.current = null;
      setSuppressHtmlDrag(false);
      event.preventDefault();
      event.stopPropagation();
      setDraggingPath(null);
      setDropTargetPath(null);
      onDragOut(node);
    };
    const clearCandidate = () => {
      dragOutCandidateRef.current = null;
      setSuppressHtmlDrag(false);
    };

    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('mouseup', clearCandidate, true);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('mouseup', clearCandidate, true);
    };
  }, [node, onDragOut, setDraggingPath, setDropTargetPath, suppressHtmlDrag]);

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div>
          <div
            draggable={!suppressHtmlDrag}
            data-tree-folder-path={node.isFolder ? node.relativePath : undefined}
            onMouseDown={(e) => {
              const wantsNativeDrag = e.button === 0 && canReveal && (e.ctrlKey || e.metaKey);
              dragOutCandidateRef.current = wantsNativeDrag ? { x: e.clientX, y: e.clientY } : null;
              setSuppressHtmlDrag(wantsNativeDrag);
            }}
            onMouseUp={() => {
              dragOutCandidateRef.current = null;
              setSuppressHtmlDrag(false);
            }}
            onMouseEnter={(event) => {
              onHover(node.relativePath);
              if (!fileTreeHoverPreviewsEnabled || (!isPdfAsset && !isImageAsset)) return;
              setHoverPreviewAnchorRect(event.currentTarget.getBoundingClientRect());
            }}
            onMouseLeave={() => {
              onHover(null);
              setHoverPreviewAnchorRect(null);
            }}
            onDragStart={(e) => {
              e.stopPropagation();
              // Ctrl/Cmd-drag exports out of the app (to the OS or another
              // instance) via a native drag instead of an intra-tree move.
              // Gated on a modifier so plain drag keeps moving files between
              // folders; Ctrl/Cmd is used because Alt-drag moves windows on Linux.
              const wantsNativeDrag = e.ctrlKey
                || e.metaKey
                || e.getModifierState?.('Control')
                || e.getModifierState?.('Meta')
                || dragOutCandidateRef.current !== null;
              if (canReveal && wantsNativeDrag) {
                e.preventDefault();
                e.dataTransfer.effectAllowed = 'copy';
                dragOutCandidateRef.current = null;
                setSuppressHtmlDrag(false);
                setDraggingPath(null);
                setDropTargetPath(null);
                onDragOut(node);
                return;
              }
              setDraggingPath(node.relativePath);
              e.dataTransfer.setData('text/plain', node.relativePath);
              e.dataTransfer.setData('application/x-collab-vault-file', node.relativePath);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
              dragOutCandidateRef.current = null;
              setSuppressHtmlDrag(false);
              setDraggingPath(null);
              setDropTargetPath(null);
            }}
            onDragOver={(e) => {
              if (!draggingPath) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = 'move';
              if (node.isFolder) {
                // Don't allow dropping into itself or a descendant
                if (draggingPath !== node.relativePath && !node.relativePath.startsWith(draggingPath + '/')) {
                  setDropTargetPath(node.relativePath);
                  // Auto-expand folder on hover
                  if (collapsed.has(node.relativePath)) {
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      next.delete(node.relativePath);
                      return next;
                    });
                  }
                }
              } else {
                setDropTargetPath('__root__');
              }
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                if (dropTargetPath === node.relativePath) setDropTargetPath(null);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (draggingPath && node.isFolder && dropTargetPath === node.relativePath) {
                onMove(draggingPath, node.relativePath);
              } else if (draggingPath && !node.isFolder && dropTargetPath === '__root__') {
                onMove(draggingPath, '__root__');
              }
              setDraggingPath(null);
              setDropTargetPath(null);
            }}
            onClick={(event) => {
              onNodeClick(node, { shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey });
            }}
            style={{ paddingLeft: `${depth * 14 + 6}px` }}
            className={cn(
              'group flex items-center gap-1 py-[3px] pr-2 cursor-pointer rounded-sm mx-1 transition-colors app-motion-fast select-none',
              'app-list-item-enter',
              isDraggingThis && 'opacity-40',
              isDropTarget && 'bg-primary/20 ring-1 ring-primary/40 ring-inset',
              !isDraggingThis && !isDropTarget && (
                isActive || isSelected
                  ? 'bg-primary/15 text-foreground'
                  : 'text-foreground/70 hover:text-foreground hover:bg-accent/50'
              )
            )}
          >
            {/* Expand chevron (only for folders) */}
            <span className="w-3 flex items-center justify-center shrink-0 text-muted-foreground/50">
              {node.isFolder && (
                isCollapsed
                  ? <ChevronRight size={11} />
                  : <ChevronDown size={11} />
              )}
            </span>

            {/* File type icon */}
            <span className="shrink-0">{getFileIcon()}</span>

            {/* Name */}
            <span className={cn('truncate flex-1 text-[12.5px]', isActive && !isDropTarget && 'font-medium text-foreground')}>
              {node.name}
            </span>

            {isManagedFolder && (
              <span
                className="shrink-0 text-primary/70"
                title="Managed media folder"
              >
                <ImageIcon size={11} />
              </span>
            )}

            {/* Active file dot */}
            {isActive && !isDropTarget && (
              <span className="w-1 h-1 rounded-full bg-primary shrink-0 opacity-80" />
            )}

            {/* Peer presence dots */}
            {activePeers.map((peer) => (
              <span
                key={peer.userId}
                className="w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: peer.userColor }}
                title={`${peer.userName} is editing`}
              />
            ))}
            {isTaskAttached && (
              <Popover open={attachmentPopoverOpen} onOpenChange={setAttachmentPopoverOpen}>
                <PopoverTrigger asChild>
                  <button
                    className="shrink-0 text-primary/75 hover:text-primary transition-colors app-motion-fast"
                    title="Attached to task"
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <Paperclip size={11} />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  side="right"
                  className="w-72 p-1"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                    Attached to {attachmentRefs.length} task{attachmentRefs.length === 1 ? '' : 's'}
                  </div>
                  <div className="flex flex-col">
                    {attachmentRefs.map((ref) => (
                      <button
                        key={`${ref.boardPath}:${ref.cardId}`}
                        onClick={() => openAttachedTask(ref)}
                        className="flex flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left hover:bg-accent/50 transition-colors app-motion-fast"
                      >
                        <span className="text-xs text-foreground">{ref.cardTitle}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {ref.boardName} · {ref.columnTitle}
                        </span>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
          <FileTreeHoverPreviewPopover
            anchorRect={hoverPreviewAnchorRect}
            relativePath={isPdfAsset || isImageAsset ? node.relativePath : null}
            type={isPdfAsset ? 'pdf' : isImageAsset ? 'image' : null}
            enabled={fileTreeHoverPreviewsEnabled && (isPdfAsset || isImageAsset)}
          />

          {/* Children */}
          {node.isFolder && !isCollapsed && node.children && (
            <div className="app-sidebar-panel-enter">
              {node.children.map((child) => (
                <FileTreeNode
                  key={child.relativePath}
                  node={child}
                  depth={depth + 1}
                  collapsed={collapsed}
                  setCollapsed={setCollapsed}
                  onOpenFile={onOpenFile}
                  onCreateNote={onCreateNote}
                  onCreateLogic={onCreateLogic}
                  onCreateSheet={onCreateSheet}
                  onCreateFolder={onCreateFolder}
                  onDelete={onDelete}
                  onRename={onRename}
                  onReveal={onReveal}
                  onDownload={onDownload}
                  onDuplicate={onDuplicate}
                  canDuplicate={canDuplicate}
                  onDragOut={onDragOut}
                  canReveal={canReveal}
                  onViewHistory={onViewHistory}
                  onNodeClick={onNodeClick}
                  selectedPaths={selectedPaths}
                  onHover={onHover}
                  draggingPath={draggingPath}
                  dropTargetPath={dropTargetPath}
                  taskAttachmentsByPath={taskAttachmentsByPath}
                  setDraggingPath={setDraggingPath}
                  setDropTargetPath={setDropTargetPath}
                  onMove={onMove}
                  fileTreeHoverPreviewsEnabled={fileTreeHoverPreviewsEnabled}
                />
              ))}
            </div>
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="glass-strong border-border/50 text-[12.5px]">
        {node.isFolder && (
          <>
            <ContextMenuItem onClick={() => onCreateNote(node.relativePath)}>New Note</ContextMenuItem>
            <ContextMenuItem onClick={() => onCreateLogic(node.relativePath)}>New Logic Diagram</ContextMenuItem>
            <ContextMenuItem onClick={() => onCreateSheet(node.relativePath)}>New Spreadsheet</ContextMenuItem>
            <ContextMenuItem onClick={() => onCreateFolder(node.relativePath)}>New Folder</ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {!isManagedFolder && <ContextMenuItem onClick={() => onRename(node)}>Rename</ContextMenuItem>}
        {isDuplicableDocument && <ContextMenuItem onClick={() => void onDuplicate(node)}>Duplicate</ContextMenuItem>}
        {supportsVersionHistory && <ContextMenuItem onClick={() => onViewHistory(node.relativePath)}>View version history</ContextMenuItem>}
        {!node.isFolder && (
          <ContextMenuItem onClick={() => void onDownload(node)}>
            <Download size={12} /> Download…
          </ContextMenuItem>
        )}
        {canReveal && (
          <ContextMenuItem onClick={() => void onReveal(node)}>
            <FolderSearch size={12} /> Reveal in file manager
          </ContextMenuItem>
        )}
        {!isManagedFolder && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onDelete(node)} className="text-destructive focus:text-destructive">Delete</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
