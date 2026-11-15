import { useRef, useState } from 'react';

import { Plus, X } from 'lucide-react';

import { cn } from '../../lib/utils';
import { useGridStore } from '../../store/gridStore';
import { documentTopBarGroupClass } from '../layout/DocumentTopBar';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

export default function WorkspaceBar() {
  const workspaces = useGridStore((state) => state.workspaces);
  const activeWorkspaceId = useGridStore((state) => state.activeWorkspaceId);
  const createWorkspace = useGridStore((state) => state.createWorkspace);
  const deleteWorkspace = useGridStore((state) => state.deleteWorkspace);
  const renameWorkspace = useGridStore((state) => state.renameWorkspace);
  const setActiveWorkspace = useGridStore((state) => state.setActiveWorkspace);

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
    <div className={documentTopBarGroupClass} role="tablist" aria-label="Grid workspaces">
      {workspaces.map((ws) => {
        const isActive = ws.id === activeWorkspaceId;
        const isEditing = editingId === ws.id;

        return (
          <div
            key={ws.id}
            role="tab"
            aria-selected={isActive}
            title="Double-click to rename"
            onClick={() => setActiveWorkspace(ws.id)}
            onDoubleClick={() => startRename(ws.id, ws.name)}
            className={cn(
              'group flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2.5 text-[13px] whitespace-nowrap select-none transition-colors app-motion-fast',
              isActive
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
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
            aria-label="New workspace"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Plus size={12} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          New workspace
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
