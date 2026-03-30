import { useCallback } from 'react';
import { Plus, Layout, LayoutDashboard, FileText } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useVaultStore } from '../../store/vaultStore';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { tauriCommands } from '../../lib/tauri';
import type { NoteFile } from '../../types/vault';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { InputDialog } from './VaultDialogs';
import { useState } from 'react';
import { toast } from 'sonner';

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

export default function BoardsPanel({ kind }: Props) {
  const { vault, fileTree, refreshFileTree } = useVaultStore();
  const { openTab, activeTabPath } = useEditorStore();
  const { setActiveView } = useUiStore();
  const [creating, setCreating] = useState(false);

  const boards = collectByExtension(fileTree, kind);

  const Icon = kind === 'canvas' ? Layout : LayoutDashboard;
  const label = kind === 'canvas' ? 'Canvas' : 'Kanban';
  const color = kind === 'canvas' ? 'text-blue-400/70' : 'text-emerald-400/70';

  const handleOpen = useCallback((file: NoteFile) => {
    openTab(file.relativePath, file.name, kind);
    setActiveView(kind);
  }, [openTab, setActiveView, kind]);

  const handleCreate = async (name: string) => {
    if (!vault) return;
    setCreating(false);
    const relativePath = `${name}.${kind}`;
    try {
      await tauriCommands.createNote(vault.path, relativePath);
      await refreshFileTree();
      openTab(relativePath, name, kind);
      setActiveView(kind);
    } catch (e) { toast.error(`Failed to create ${label} board: ${e}`); }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <InputDialog
        open={creating}
        variant={kind === 'canvas' ? 'create-canvas' : 'create-kanban'}
        initialValue=""
        onConfirm={handleCreate}
        onCancel={() => setCreating(false)}
      />

      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30">
        <span className="text-[11px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
          {label} Boards
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setCreating(true)}
              className="w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
            >
              <Plus size={13} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs text-foreground">New {label} board</TooltipContent>
        </Tooltip>
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
              <div
                key={board.relativePath}
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
                {isActive && <span className="w-1 h-1 rounded-full bg-primary shrink-0 opacity-80 mt-1.5" />}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
