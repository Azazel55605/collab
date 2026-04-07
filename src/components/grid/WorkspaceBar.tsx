import { useState, useRef } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useGridStore } from '../../store/gridStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

export default function WorkspaceBar() {
  const { workspaces, activeWorkspaceId, createWorkspace, deleteWorkspace, renameWorkspace, setActiveWorkspace } =
    useGridStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startRename = (id: string, currentName: string) => {
    setEditingId(id);
    setEditValue(currentName);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      renameWorkspace(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="flex items-center h-7 border-b border-border/50 bg-sidebar/60 shrink-0 overflow-x-auto scrollbar-none">
      {workspaces.map((ws) => {
        const isActive = ws.id === activeWorkspaceId;
        const isEditing = editingId === ws.id;

        return (
          <div
            key={ws.id}
            onClick={() => setActiveWorkspace(ws.id)}
            onDoubleClick={() => startRename(ws.id, ws.name)}
            className={cn(
              'relative flex items-center gap-1 px-2.5 h-full text-xs cursor-pointer whitespace-nowrap select-none group shrink-0',
              'border-r border-border/30 transition-colors duration-100',
              isActive
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'
            )}
          >
            {/* Active indicator line */}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-primary rounded-t" />
            )}

            {isEditing ? (
              <Input
                ref={inputRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditingId(null);
                  e.stopPropagation();
                }}
                onClick={(e) => e.stopPropagation()}
                className="h-6 w-24 border-primary/40 bg-transparent px-1.5 text-xs"
                autoFocus
              />
            ) : (
              <span className="max-w-[120px] truncate">{ws.name}</span>
            )}

            {/* Delete button — only if there are 2+ workspaces */}
            {workspaces.length > 1 && !isEditing && (
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteWorkspace(ws.id);
                }}
                variant="ghost"
                size="icon"
                className="size-4 opacity-0 group-hover:opacity-60 hover:!opacity-100"
                title="Delete workspace"
              >
                <X size={9} />
              </Button>
            )}
          </div>
        );
      })}

      {/* New workspace */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            onClick={() => createWorkspace()}
            variant="ghost"
            size="icon"
            className="h-full w-7 rounded-none text-muted-foreground/50 hover:text-foreground hover:bg-accent/40 shrink-0"
          >
            <Plus size={12} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">New workspace</TooltipContent>
      </Tooltip>

      <div className="flex-1" />

      {/* Hint: double-click to rename */}
      <span className="text-[10px] text-muted-foreground/30 pr-2 shrink-0 select-none hidden sm:block">
        dbl-click to rename
      </span>
    </div>
  );
}
