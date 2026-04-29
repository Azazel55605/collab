import { useCallback, useEffect, useMemo } from 'react';
import { Plus, Layout, LayoutDashboard, FileText, Library, MoreHorizontal, Sparkles, Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useVaultStore } from '../../store/vaultStore';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { tauriCommands } from '../../lib/tauri';
import type { NoteFile } from '../../types/vault';
import type { KanbanTemplate } from '../../types/template';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { ConfirmDeleteDialog, InputDialog } from './VaultDialogs';
import { useState } from 'react';
import { toast } from 'sonner';
import KanbanTemplatesModal from '../kanban/KanbanTemplatesModal';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import type { KanbanBoard } from '../../types/kanban';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

interface Props {
  kind: 'canvas' | 'kanban';
}

/** Recursively collect all files with a given extension from the file tree. */
function collectByExtension(nodes: NoteFile[], ext: string): NoteFile[] {
  const results: NoteFile[] = [];
  for (const node of nodes) {
    if (!node.isFolder && node.extension === ext) results.push(node);
    if (node.isFolder && node.children) results.push(...collectByExtension(node.children, ext));
  }
  return results;
}

function ensureBoardPath(name: string, kind: Props['kind']): string {
  const trimmed = name.trim();
  const ext = `.${kind}`;
  return trimmed.endsWith(ext) ? trimmed : `${trimmed}${ext}`;
}

function groupKanbanTemplates(templates: KanbanTemplate[]): KanbanTemplate[] {
  const groups = new Map<string, KanbanTemplate>();

  for (const template of templates) {
    const key = `${template.name.toLocaleLowerCase()}::${template.hash}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, template);
      continue;
    }

    const rank = (source: KanbanTemplate['source']) => {
      if (source === 'vault') return 0;
      if (source === 'app') return 1;
      return 2;
    };

    if (rank(template.source) < rank(existing.source)) {
      groups.set(key, template);
    }
  }

  return [...groups.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}

export default function BoardsPanel({ kind }: Props) {
  const { vault, fileTree, refreshFileTree } = useVaultStore();
  const { openTab, closeTab, activeTabPath } = useEditorStore();
  const { setActiveView, confirmDelete: confirmDeleteEnabled } = useUiStore();
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createTemplate, setCreateTemplate] = useState('__blank__');
  const [templateChoices, setTemplateChoices] = useState<KanbanTemplate[]>([]);
  const [loadingTemplateChoices, setLoadingTemplateChoices] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [deleteBoard, setDeleteBoard] = useState<NoteFile | null>(null);
  const [deleteRemoveReferences, setDeleteRemoveReferences] = useState(false);
  const [templateBoard, setTemplateBoard] = useState<NoteFile | null>(null);

  const boards = collectByExtension(fileTree, kind);

  const Icon = kind === 'canvas' ? Layout : LayoutDashboard;
  const label = kind === 'canvas' ? 'Canvas' : 'Kanban';
  const color = kind === 'canvas' ? 'text-blue-400/70' : 'text-emerald-400/70';
  const visibleTemplateChoices = useMemo(() => groupKanbanTemplates(templateChoices), [templateChoices]);

  const handleOpen = useCallback((file: NoteFile) => {
    openTab(file.relativePath, file.name, kind);
    setActiveView(kind);
  }, [openTab, setActiveView, kind]);

  const handleCreate = async (name: string) => {
    if (!vault) return;
    setCreating(false);
    const relativePath = ensureBoardPath(name, kind);
    try {
      await tauriCommands.createNote(vault.path, relativePath);
      await refreshFileTree();
      openTab(relativePath, relativePath.split('/').pop() ?? relativePath, kind);
      setActiveView(kind);
    } catch (e) { toast.error(`Failed to create ${label} board: ${e}`); }
  };

  useEffect(() => {
    if (!creating || kind !== 'kanban' || !vault) return;

    let cancelled = false;
    const vaultPath = vault.path;

    async function loadTemplateChoices() {
      setLoadingTemplateChoices(true);
      try {
        const templates = await tauriCommands.listKanbanTemplates(vaultPath);
        if (!cancelled) setTemplateChoices(templates);
      } catch (error) {
        if (!cancelled) toast.error(`Failed to load templates: ${error}`);
      } finally {
        if (!cancelled) setLoadingTemplateChoices(false);
      }
    }

    void loadTemplateChoices();

    return () => {
      cancelled = true;
    };
  }, [creating, kind, vault]);

  useEffect(() => {
    if (!creating) return;
    setCreateName('');
    setCreateTemplate('__blank__');
  }, [creating]);

  const handleCreateKanban = useCallback(async () => {
    if (!vault) return;
    const trimmed = createName.trim();
    if (!trimmed) return;

    const relativePath = ensureBoardPath(trimmed, 'kanban');
    setCreating(false);

    try {
      let file: NoteFile;
      if (createTemplate === '__blank__') {
        file = await tauriCommands.createNote(vault.path, relativePath);
      } else {
        const template = visibleTemplateChoices.find(
          (entry) => `${entry.source}::${entry.name}` === createTemplate,
        );
        if (!template) throw new Error('Selected template is no longer available');
        file = await tauriCommands.applyKanbanTemplate(vault.path, template.source, template.name, relativePath);
      }
      await refreshFileTree();
      openTab(file.relativePath, file.name, 'kanban');
      setActiveView('kanban');
    } catch (error) {
      toast.error(`Failed to create ${label} board: ${error}`);
    }
  }, [createName, createTemplate, label, openTab, refreshFileTree, setActiveView, vault, visibleTemplateChoices]);

  const deleteBoardFile = useCallback(async (file: NoteFile, removeReferences = false) => {
    if (!vault) return;
    try {
      await tauriCommands.deleteNote(vault.path, file.relativePath, removeReferences);
      closeTab(file.relativePath);
      await refreshFileTree();
      toast.success(`Deleted ${file.name}`);
    } catch (error) {
      toast.error(`Failed to delete ${label} board: ${error}`);
    }
  }, [vault, closeTab, refreshFileTree, label]);

  const moveBoardToTrash = useCallback(async (file: NoteFile) => {
    if (!vault) return;
    try {
      await tauriCommands.moveNoteToTrash(vault.path, file.relativePath, null, null, deleteRemoveReferences);
      closeTab(file.relativePath);
      await refreshFileTree();
      toast.success(`Moved ${file.name} to trash`);
    } catch (error) {
      toast.error(`Failed to move ${label} board to trash: ${error}`);
    }
  }, [vault, closeTab, refreshFileTree, label, deleteRemoveReferences]);

  const handleDelete = useCallback((file: NoteFile) => {
    setDeleteRemoveReferences(false);
    if (!confirmDeleteEnabled) {
      void moveBoardToTrash(file);
      return;
    }
    setDeleteBoard(file);
  }, [confirmDeleteEnabled, moveBoardToTrash]);

  const handleSaveAsTemplate = useCallback((file: NoteFile) => {
    setTemplateBoard(file);
  }, []);

  const confirmSaveAsTemplate = useCallback(async (templateName: string) => {
    if (!vault || !templateBoard || kind !== 'kanban') return;
    setTemplateBoard(null);
    try {
      const { content } = await tauriCommands.readNote(vault.path, templateBoard.relativePath);
      const board = JSON.parse(content) as KanbanBoard;
      await tauriCommands.saveKanbanTemplate(vault.path, 'vault', templateName, board);
      toast.success(`Saved "${templateName}" to vault templates`);
    } catch (error) {
      toast.error(`Failed to save template: ${error}`);
    }
  }, [vault, templateBoard, kind]);

  const renderBoardActions = useCallback((board: NoteFile) => (
    <>
      {kind === 'kanban' && (
        <DropdownMenuItem onSelect={() => handleSaveAsTemplate(board)}>
          <Sparkles />
          Save as Template
        </DropdownMenuItem>
      )}
      {kind === 'kanban' && <DropdownMenuSeparator />}
      <DropdownMenuItem variant="destructive" onSelect={() => handleDelete(board)}>
        <Trash2 />
        Delete Board
      </DropdownMenuItem>
    </>
  ), [handleDelete, handleSaveAsTemplate, kind]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {vault && kind === 'kanban' && (
        <KanbanTemplatesModal
          open={templatesOpen}
          vaultPath={vault.path}
          boards={boards}
          onOpenChange={setTemplatesOpen}
          onTemplateApplied={async (file) => {
            await refreshFileTree();
            openTab(file.relativePath, file.name, 'kanban');
            setActiveView('kanban');
            setTemplatesOpen(false);
          }}
        />
      )}

      <Dialog open={creating} onOpenChange={(open) => { if (!open) setCreating(false); }}>
        {kind === 'canvas' ? (
          <DialogContent showCloseButton={false} className="max-w-sm">
            <DialogHeader>
              <div className="flex items-center gap-3 mb-1">
                <span className="flex items-center justify-center w-9 h-9 rounded-full bg-primary/15 text-primary shrink-0">
                  <Layout size={16} />
                </span>
                <DialogTitle>New canvas board</DialogTitle>
              </div>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">Board name</label>
                <Input
                  value={createName}
                  placeholder="Untitled Canvas"
                  onChange={(event) => setCreateName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleCreate(createName);
                    if (event.key === 'Escape') setCreating(false);
                  }}
                />
              </div>
            </div>

            <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
              <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
              <Button onClick={() => void handleCreate(createName)} disabled={!createName.trim()}>
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : (
          <DialogContent showCloseButton={false} className="max-w-sm">
            <DialogHeader>
              <div className="flex items-center gap-3 mb-1">
                <span className="flex items-center justify-center w-9 h-9 rounded-full bg-primary/15 text-primary shrink-0">
                  <LayoutDashboard size={16} />
                </span>
                <DialogTitle>New kanban board</DialogTitle>
              </div>
            </DialogHeader>

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">Board name</label>
                <Input
                  value={createName}
                  placeholder="Untitled Board"
                  onChange={(event) => setCreateName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleCreateKanban();
                    if (event.key === 'Escape') setCreating(false);
                  }}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">Template</label>
                <Select value={createTemplate} onValueChange={setCreateTemplate}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a template" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__blank__">Blank board</SelectItem>
                    {visibleTemplateChoices.map((template) => (
                      <SelectItem key={`${template.source}::${template.name}`} value={`${template.source}::${template.name}`}>
                        {template.name} {template.source === 'builtin' ? '• Built-in' : template.source === 'vault' ? '• Vault' : '• App'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {loadingTemplateChoices && (
                  <div className="text-[11px] text-muted-foreground/70">Loading templates…</div>
                )}
              </div>
            </div>

            <DialogFooter className="border-none bg-transparent -mx-0 -mb-0 px-0 pb-0">
              <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
              <Button onClick={() => void handleCreateKanban()} disabled={!createName.trim()}>
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
      <InputDialog
        open={!!templateBoard}
        variant="create-template"
        initialValue={templateBoard?.name.replace(/\.(kanban|canvas)$/i, '') ?? ''}
        onConfirm={confirmSaveAsTemplate}
        onCancel={() => setTemplateBoard(null)}
      />
      <ConfirmDeleteDialog
        open={!!deleteBoard}
        name={deleteBoard?.name ?? ''}
        isFolder={false}
        primaryActionLabel="Delete permanently"
        showReferenceOption
        removeReferences={deleteRemoveReferences}
        onRemoveReferencesChange={setDeleteRemoveReferences}
        onMoveToTrash={() => {
          if (!deleteBoard) return;
          void moveBoardToTrash(deleteBoard);
          setDeleteBoard(null);
          setDeleteRemoveReferences(false);
        }}
        onDeletePermanently={() => {
          if (!deleteBoard) return;
          void deleteBoardFile(deleteBoard, deleteRemoveReferences);
          setDeleteBoard(null);
          setDeleteRemoveReferences(false);
        }}
        onConfirm={() => {
          if (!deleteBoard) return;
          void deleteBoardFile(deleteBoard, deleteRemoveReferences);
          setDeleteBoard(null);
          setDeleteRemoveReferences(false);
        }}
        onCancel={() => {
          setDeleteBoard(null);
          setDeleteRemoveReferences(false);
        }}
      />

      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30">
        <span className="text-[11px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
          {label} Boards
        </span>
        <div className="flex items-center gap-1">
          {kind === 'kanban' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setTemplatesOpen(true)}
                  className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
                >
                  <Library size={13} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">Manage templates</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setCreating(true)}
                className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
                >
                  <Plus size={13} />
                </button>
              </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">New {label} board</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Board list */}
      <div className="flex-1 overflow-y-auto py-1">
        {boards.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground/50">
            <Icon size={24} className="mx-auto mb-2 opacity-30" />
            <p>No {label.toLowerCase()} boards yet.</p>
            <button
              onClick={() => setCreating(true)}
              className="mt-2 text-primary/70 hover:text-primary transition-colors underline underline-offset-2"
            >
              Create your first board
            </button>
          </div>
        ) : (
          boards.map((board) => {
            const isActive = activeTabPath === board.relativePath;
            // Show folder path as a subtitle if the board is nested
            const parts = board.relativePath.split('/');
            const folderPath = parts.length > 1 ? parts.slice(0, -1).join('/') : null;

            return (
              <ContextMenu key={board.relativePath}>
                <ContextMenuTrigger asChild>
                  <div
                    onClick={() => handleOpen(board)}
                    className={cn(
                      'group flex items-start gap-2 px-3 py-2 mx-1 rounded-sm cursor-pointer transition-colors select-none',
                      isActive
                        ? 'bg-primary/15 text-foreground'
                        : 'text-foreground/70 hover:text-foreground hover:bg-accent/50'
                    )}
                  >
                    <Icon size={13} className={cn('mt-0.5 shrink-0', color)} />
                    <div className="flex-1 min-w-0">
                      <div className={cn('text-[12.5px] truncate', isActive && 'font-medium text-foreground')}>
                        {board.name}
                      </div>
                      {folderPath && (
                        <div className="flex items-center gap-1 mt-0.5 text-[10.5px] text-muted-foreground/50 truncate">
                          <FileText size={9} />
                          {folderPath}
                        </div>
                      )}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          onClick={(event) => event.stopPropagation()}
                          className={cn(
                            'w-6 h-6 -mr-1 rounded flex items-center justify-center text-muted-foreground/60 hover:text-foreground hover:bg-accent/70 transition-colors opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                            isActive && 'opacity-100',
                          )}
                          aria-label={`Board actions for ${board.name}`}
                        >
                          <MoreHorizontal size={13} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        {renderBoardActions(board)}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {isActive && <span className="w-1 h-1 rounded-full bg-primary shrink-0 opacity-80 mt-1.5" />}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-48">
                  {kind === 'kanban' && (
                    <ContextMenuItem onSelect={() => handleSaveAsTemplate(board)}>
                      <Sparkles />
                      Save as Template
                    </ContextMenuItem>
                  )}
                  {kind === 'kanban' && <ContextMenuSeparator />}
                  <ContextMenuItem variant="destructive" onSelect={() => handleDelete(board)}>
                    <Trash2 />
                    Delete Board
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })
        )}
      </div>
    </div>
  );
}
