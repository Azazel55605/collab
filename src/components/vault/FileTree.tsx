import { useState, useCallback, useEffect } from 'react';
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderOpen,
  Plus, FolderPlus, Layout, LayoutDashboard, Paperclip, Image as ImageIcon, Trash2,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useVaultStore } from '../../store/vaultStore';
import { useEditorStore } from '../../store/editorStore';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';
import { tauriCommands } from '../../lib/tauri';
import type { FileReference, NoteFile } from '../../types/vault';
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

type DialogState =
  | { type: 'none' }
  | { type: 'delete'; file: NoteFile }
  | { type: 'rename'; file: NoteFile }
  | { type: 'create-note'; parentPath?: string }
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
  const { openTab, closeTab, renameTab } = useEditorStore();
  const { setActiveView, confirmDelete: confirmDeleteEnabled } = useUiStore();
  const { myUserId, myUserName } = useCollabStore();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>({ type: 'none' });
  const [deleteRemoveReferences, setDeleteRemoveReferences] = useState(false);
  const [taskAttachmentsByPath, setTaskAttachmentsByPath] = useState<Record<string, TaskAttachmentRef[]>>({});
  const [mode, setMode] = useState<'files' | 'trash'>('files');
  const [selectedRelativePath, setSelectedRelativePath] = useState<string | null>(null);
  const [selectedReferences, setSelectedReferences] = useState<FileReference[]>([]);
  const [selectedReferencesLoading, setSelectedReferencesLoading] = useState(false);
  const [selectedReferencesError, setSelectedReferencesError] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<{
    preview: PathChangePreview;
    apply: () => Promise<void>;
  } | null>(null);

  function flatten(nodes: NoteFile[]): NoteFile[] {
    return nodes.flatMap((node) => [node, ...(node.children ? flatten(node.children) : [])]);
  }

  const selectedNode = selectedRelativePath
    ? flatten(fileTree).find((entry) => entry.relativePath === selectedRelativePath) ?? null
    : null;

  // ── Drag-and-drop state ────────────────────────────────────────────────────
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null | '__root__'>('__root__');
  // null = no target, '__root__' = root of vault

  const handleOpenFile = useCallback((file: NoteFile) => {
    const type = isImageFile(file)
      ? 'image'
      : isPdfFile(file)
      ? 'pdf'
      : file.extension === 'canvas'
      ? 'canvas'
      : file.extension === 'kanban'
      ? 'kanban'
      : 'note';
    openTab(file.relativePath, file.name, type);
    if (type === 'canvas') setActiveView('canvas');
    else if (type === 'kanban') setActiveView('kanban');
    else setActiveView('editor');
  }, [openTab, setActiveView]);

  const handleCreateNote = (parentPath?: string) => {
    setDialog({ type: 'create-note', parentPath });
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
      void moveFileToTrash(file);
      return;
    }
    setDialog({ type: 'delete', file });
  };

  const handleRename = (file: NoteFile) => {
    setDialog({ type: 'rename', file });
  };

  const confirmDelete = async () => {
    if (dialog.type !== 'delete' || !vault) return;
    const { file } = dialog;
    setDialog({ type: 'none' });
    try {
      await tauriCommands.deleteNote(vault.path, file.relativePath, deleteRemoveReferences);
      const prefix = file.isFolder ? file.relativePath + '/' : null;
      for (const tab of useEditorStore.getState().openTabs) {
        if (
          tab.relativePath === file.relativePath ||
          (prefix && tab.relativePath.startsWith(prefix))
        ) {
          closeTab(tab.relativePath);
        }
      }
      await refreshFileTree();
    } catch (e) { toast.error('Failed to delete: ' + e); }
    finally { setDeleteRemoveReferences(false); }
  };

  const moveFileToTrash = async (file: NoteFile) => {
    if (!vault) return;
    try {
      await tauriCommands.moveNoteToTrash(
        vault.path,
        file.relativePath,
        myUserId,
        myUserName,
        deleteRemoveReferences,
      );
      const prefix = file.isFolder ? `${file.relativePath}/` : null;
      for (const tab of useEditorStore.getState().openTabs) {
        if (tab.relativePath === file.relativePath || (prefix && tab.relativePath.startsWith(prefix))) {
          closeTab(tab.relativePath);
        }
      }
      await refreshFileTree();
      setMode('trash');
      toast.success(`Moved ${file.name} to trash`);
    } catch (error) {
      toast.error(`Failed to move to trash: ${error}`);
    } finally {
      setDeleteRemoveReferences(false);
    }
  };

  const moveToTrash = async () => {
    if (dialog.type !== 'delete') return;
    const { file } = dialog;
    setDialog({ type: 'none' });
    await moveFileToTrash(file);
  };

  const confirmCreate = async (name: string) => {
    if (!vault) return;
    if (dialog.type === 'create-note') {
      const { parentPath } = dialog;
      setDialog({ type: 'none' });
      const relativePath = parentPath ? `${parentPath}/${name}.md` : `${name}.md`;
      try {
        await tauriCommands.createNote(vault.path, relativePath);
        await refreshFileTree();
        openTab(relativePath, name, 'note');
        setActiveView('editor');
      } catch (e) { toast.error('Failed to create note: ' + e); }
    } else if (dialog.type === 'create-folder') {
      const { parentPath } = dialog;
      setDialog({ type: 'none' });
      const relativePath = parentPath ? `${parentPath}/${name}` : name;
      try {
        await tauriCommands.createFolder(vault.path, relativePath);
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
      const preview = await tauriCommands.previewRenameMove(vault.path, file.relativePath, newPath);
      setPreviewState({
        preview,
        apply: async () => {
          await tauriCommands.renameNote(vault.path, file.relativePath, newPath);
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
      const preview = await tauriCommands.previewRenameMove(vault.path, fromPath, newPath);
      setPreviewState({
        preview,
        apply: async () => {
          await tauriCommands.renameNote(vault.path, fromPath, newPath);
          renameTab(fromPath, newPath, fileName.replace(/\.[^.]+$/, ''));
          await refreshFileTree();
        },
      });
    } catch (e) { toast.error('Failed to preview move: ' + e); }
  }, [vault, refreshFileTree, renameTab]);

  useEffect(() => {
    if (!vault) return;
    let cancelled = false;

    function flatten(nodes: NoteFile[]): NoteFile[] {
      return nodes.flatMap((node) => [node, ...(node.children ? flatten(node.children) : [])]);
    }

    const kanbanFiles = flatten(fileTree).filter((node) => !node.isFolder && node.extension === 'kanban');

    void Promise.all(
      kanbanFiles.map(async (file) => {
        try {
          const { content } = await tauriCommands.readNote(vault.path, file.relativePath);
          const board = JSON.parse(content) as KanbanBoard;
          return board.columns.flatMap((column) =>
            column.cards.flatMap((card) =>
              getCardAttachmentPaths(card).map((path) => ({
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
              })),
            ),
          );
        } catch {
          return [];
        }
      }),
    ).then((attachedLists) => {
      if (cancelled) return;
      const next: Record<string, TaskAttachmentRef[]> = {};
      for (const item of attachedLists.flat()) {
        next[item.path] ??= [];
        next[item.path].push(item.ref);
      }
      setTaskAttachmentsByPath(next);
    });

    return () => { cancelled = true; };
  }, [vault?.path, fileTree]);

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
    void tauriCommands.listFileReferences(vault.path, selectedRelativePath)
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
  }, [mode, selectedNode, selectedRelativePath, vault?.path]);

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
      <ConfirmDeleteDialog
        open={dialog.type === 'delete'}
        name={dialog.type === 'delete' ? dialog.file.name : ''}
        isFolder={dialog.type === 'delete' ? dialog.file.isFolder : false}
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
        open={dialog.type === 'create-note' || dialog.type === 'create-folder' || dialog.type === 'rename'}
        variant={
          dialog.type === 'create-note' ? 'create-note'
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
            ? useEditorStore.getState().openTabs
                .filter((tab) => tab.relativePath === previewState.preview.oldRelativePath || tab.relativePath.startsWith(`${previewState.preview.oldRelativePath}/`))
                .map((tab) => tab.relativePath)
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
          </div>
        )}
      </div>

      {/* Tree — root is also a drop target */}
      {mode === 'trash' ? (
        <TrashPanel />
      ) : (
      <div
        className={cn(
          'flex-1 overflow-y-auto py-1 transition-colors duration-100 app-motion-fast',
          dropTargetPath === '__root__' && draggingPath ? 'bg-primary/5' : ''
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
              onCreateFolder={handleCreateFolder}
              onDelete={handleDelete}
              onRename={handleRename}
              onSelect={setSelectedRelativePath}
              draggingPath={draggingPath}
              dropTargetPath={dropTargetPath}
              taskAttachmentsByPath={taskAttachmentsByPath}
              setDraggingPath={setDraggingPath}
              setDropTargetPath={setDropTargetPath}
              onMove={handleMove}
            />
          ))
        )}
      </div>
      )}
      {mode === 'files' && selectedFile ? (
        <FileReferencesPanel
          selectedFile={selectedFile}
          references={selectedReferences}
          loading={selectedReferencesLoading}
          error={selectedReferencesError}
          onOpenReference={handleOpenReference}
        />
      ) : null}
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
  onCreateFolder: (parentPath?: string) => void;
  onDelete: (file: NoteFile) => void;
  onRename: (file: NoteFile) => void;
  onSelect: (relativePath: string) => void;
  draggingPath: string | null;
  dropTargetPath: string | null | '__root__';
  taskAttachmentsByPath: Record<string, TaskAttachmentRef[]>;
  setDraggingPath: (path: string | null) => void;
  setDropTargetPath: (path: string | null | '__root__') => void;
  onMove: (fromPath: string, toFolderPath: string | '__root__') => void;
}

function FileTreeNode({
  node, depth, collapsed, setCollapsed,
  onOpenFile, onCreateNote, onCreateFolder, onDelete, onRename,
  onSelect,
  draggingPath, dropTargetPath, taskAttachmentsByPath, setDraggingPath, setDropTargetPath, onMove,
}: FileTreeNodeProps) {
  const { activeTabPath, openTab } = useEditorStore();
  const { peers } = useCollabStore();
  const { setActiveView } = useUiStore();
  const { setEditing } = useKanbanStore();
  const [attachmentPopoverOpen, setAttachmentPopoverOpen] = useState(false);

  const isCollapsed = collapsed.has(node.relativePath);
  const isActive = activeTabPath === node.relativePath;
  const activePeers = peers.filter((p) => p.activeFile === node.relativePath);
  const isDraggingThis = draggingPath === node.relativePath;
  const isDropTarget = node.isFolder && dropTargetPath === node.relativePath && draggingPath !== null;
  const attachmentRefs = taskAttachmentsByPath[node.relativePath] ?? [];
  const isTaskAttached = !node.isFolder && attachmentRefs.length > 0;
  const isImageAsset = isImageFile(node);
  const isManagedFolder = isManagedPicturesFolder(node);

  const toggleCollapse = () => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(node.relativePath)) next.delete(node.relativePath);
      else next.add(node.relativePath);
      return next;
    });
  };

  const getFileIcon = () => {
    if (node.isFolder) {
      return isCollapsed
        ? <Folder size={13} className={cn('transition-colors app-motion-fast', isDropTarget ? 'text-primary' : 'text-primary/60')} />
        : <FolderOpen size={13} className={cn('transition-colors app-motion-fast', isDropTarget ? 'text-primary' : 'text-primary/60')} />;
    }
    if (isImageAsset) return <ImageIcon size={13} className="text-sky-400/80" />;
    if (node.extension === 'canvas')  return <Layout size={13} className="text-blue-400/70" />;
    if (node.extension === 'kanban')  return <LayoutDashboard size={13} className="text-emerald-400/70" />;
    return <FileText size={13} className="text-muted-foreground/70" />;
  };

  function openAttachedTask(ref: TaskAttachmentRef) {
    openTab(ref.boardPath, ref.boardName, 'kanban');
    setActiveView('kanban');
    setEditing(ref.boardPath, ref.cardId, ref.columnId, ref.card);
    setAttachmentPopoverOpen(false);
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div>
          <div
            draggable
            onDragStart={(e) => {
              e.stopPropagation();
              setDraggingPath(node.relativePath);
              e.dataTransfer.setData('text/plain', node.relativePath);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => {
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
              }
              setDraggingPath(null);
              setDropTargetPath(null);
            }}
            onClick={() => {
              onSelect(node.relativePath);
              if (node.isFolder) toggleCollapse();
              else onOpenFile(node);
            }}
            style={{ paddingLeft: `${depth * 14 + 6}px` }}
            className={cn(
              'group flex items-center gap-1 py-[3px] pr-2 cursor-pointer rounded-sm mx-1 transition-colors app-motion-fast select-none',
              isDraggingThis && 'opacity-40',
              isDropTarget && 'bg-primary/20 ring-1 ring-primary/40 ring-inset',
              !isDraggingThis && !isDropTarget && (
                isActive
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

          {/* Children */}
          {node.isFolder && !isCollapsed && node.children && (
            <div>
              {node.children.map((child) => (
                <FileTreeNode
                  key={child.relativePath}
                  node={child}
                  depth={depth + 1}
                  collapsed={collapsed}
                  setCollapsed={setCollapsed}
                  onOpenFile={onOpenFile}
                  onCreateNote={onCreateNote}
                  onCreateFolder={onCreateFolder}
                  onDelete={onDelete}
                  onRename={onRename}
                  onSelect={onSelect}
                  draggingPath={draggingPath}
                  dropTargetPath={dropTargetPath}
                  taskAttachmentsByPath={taskAttachmentsByPath}
                  setDraggingPath={setDraggingPath}
                  setDropTargetPath={setDropTargetPath}
                  onMove={onMove}
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
            <ContextMenuItem onClick={() => onCreateFolder(node.relativePath)}>New Folder</ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {!isManagedFolder && <ContextMenuItem onClick={() => onRename(node)}>Rename</ContextMenuItem>}
        {!isManagedFolder && <ContextMenuSeparator />}
        {!isManagedFolder && (
          <ContextMenuItem onClick={() => onDelete(node)} className="text-destructive focus:text-destructive">Delete</ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
