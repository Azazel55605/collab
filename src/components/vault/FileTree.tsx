import { useState, useCallback } from 'react';
import {
  ChevronRight, ChevronDown, FileText, Folder, FolderOpen,
  Plus, FolderPlus, Layout, LayoutDashboard,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useVaultStore } from '../../store/vaultStore';
import { useEditorStore } from '../../store/editorStore';
import { useCollabStore } from '../../store/collabStore';
import { useUiStore } from '../../store/uiStore';
import { tauriCommands } from '../../lib/tauri';
import type { NoteFile } from '../../types/vault';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuTrigger,
} from '../ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { toast } from 'sonner';
import { ConfirmDeleteDialog, InputDialog } from './VaultDialogs';

type DialogState =
  | { type: 'none' }
  | { type: 'delete'; file: NoteFile }
  | { type: 'rename'; file: NoteFile }
  | { type: 'create-note'; parentPath?: string }
  | { type: 'create-folder'; parentPath?: string };

export default function FileTree() {
  const { vault, fileTree, refreshFileTree } = useVaultStore();
  const { openTab, closeTab, renameTab } = useEditorStore();
  const { setActiveView, confirmDelete: confirmDeleteSetting } = useUiStore();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>({ type: 'none' });

  // ── Drag-and-drop state ────────────────────────────────────────────────────
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null | '__root__'>('__root__');
  // null = no target, '__root__' = root of vault

  const handleOpenFile = useCallback((file: NoteFile) => {
    const type = file.extension === 'canvas' ? 'canvas' : file.extension === 'kanban' ? 'kanban' : 'note';
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
    if (!confirmDeleteSetting) {
      void (async () => {
        if (!vault) return;
        try {
          await tauriCommands.deleteNote(vault.path, file.relativePath);
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
      })();
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
      await tauriCommands.deleteNote(vault.path, file.relativePath);
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
      await tauriCommands.renameNote(vault.path, file.relativePath, newPath);
      renameTab(file.relativePath, newPath, nextSegment.replace(/\.[^.]+$/, ''));
      await refreshFileTree();
    } catch (e) { toast.error('Failed to rename: ' + e); }
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
      await tauriCommands.renameNote(vault.path, fromPath, newPath);
      await refreshFileTree();
    } catch (e) { toast.error('Failed to move: ' + e); }
  }, [vault, refreshFileTree]);

  if (!vault) return null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Dialogs */}
      <ConfirmDeleteDialog
        open={dialog.type === 'delete'}
        name={dialog.type === 'delete' ? dialog.file.name : ''}
        isFolder={dialog.type === 'delete' ? dialog.file.isFolder : false}
        onConfirm={confirmDelete}
        onCancel={() => setDialog({ type: 'none' })}
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

      {/* Toolbar row */}
      <div className="flex items-center justify-end gap-0.5 px-2 py-1.5 border-b border-border/30">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => handleCreateNote()}
              className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
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
              className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
            >
              <FolderPlus size={13} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs text-foreground">New folder</TooltipContent>
        </Tooltip>
      </div>

      {/* Tree — root is also a drop target */}
      <div
        className={cn(
          'flex-1 overflow-y-auto py-1 transition-colors duration-100',
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
              className="mt-2 text-primary/70 hover:text-primary transition-colors underline underline-offset-2"
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
              draggingPath={draggingPath}
              dropTargetPath={dropTargetPath}
              setDraggingPath={setDraggingPath}
              setDropTargetPath={setDropTargetPath}
              onMove={handleMove}
            />
          ))
        )}
      </div>
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
  draggingPath: string | null;
  dropTargetPath: string | null | '__root__';
  setDraggingPath: (path: string | null) => void;
  setDropTargetPath: (path: string | null | '__root__') => void;
  onMove: (fromPath: string, toFolderPath: string | '__root__') => void;
}

function FileTreeNode({
  node, depth, collapsed, setCollapsed,
  onOpenFile, onCreateNote, onCreateFolder, onDelete, onRename,
  draggingPath, dropTargetPath, setDraggingPath, setDropTargetPath, onMove,
}: FileTreeNodeProps) {
  const { activeTabPath } = useEditorStore();
  const { peers } = useCollabStore();

  const isCollapsed = collapsed.has(node.relativePath);
  const isActive = activeTabPath === node.relativePath;
  const activePeers = peers.filter((p) => p.activeFile === node.relativePath);
  const isDraggingThis = draggingPath === node.relativePath;
  const isDropTarget = node.isFolder && dropTargetPath === node.relativePath && draggingPath !== null;

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
        ? <Folder size={13} className={cn('transition-colors', isDropTarget ? 'text-primary' : 'text-primary/60')} />
        : <FolderOpen size={13} className={cn('transition-colors', isDropTarget ? 'text-primary' : 'text-primary/60')} />;
    }
    if (node.extension === 'canvas')  return <Layout size={13} className="text-blue-400/70" />;
    if (node.extension === 'kanban')  return <LayoutDashboard size={13} className="text-emerald-400/70" />;
    return <FileText size={13} className="text-muted-foreground/70" />;
  };

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
            onClick={() => node.isFolder ? toggleCollapse() : onOpenFile(node)}
            style={{ paddingLeft: `${depth * 14 + 6}px` }}
            className={cn(
              'group flex items-center gap-1 py-[3px] pr-2 cursor-pointer rounded-sm mx-1 transition-colors select-none',
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
                  draggingPath={draggingPath}
                  dropTargetPath={dropTargetPath}
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
        <ContextMenuItem onClick={() => onRename(node)}>Rename</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onDelete(node)} className="text-destructive focus:text-destructive">Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
