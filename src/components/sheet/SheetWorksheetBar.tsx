import { useState } from 'react';

import { Copy, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';

import { cn } from '../../lib/utils';
import type { SheetDocument } from '../../types/sheet';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/context-menu';
import { Input } from '../ui/input';

interface Props {
  document: SheetDocument;
  onSelect: (worksheetId: string) => void;
  onAdd: () => void;
  onRename: (worksheetId: string, name: string) => void;
  onDuplicate: (worksheetId: string) => void;
  onDelete: (worksheetId: string) => void;
  onReorder: (worksheetId: string, toIndex: number) => void;
  onToggleHidden: (worksheetId: string, hidden: boolean) => void;
  readOnly?: boolean;
}

/**
 * Worksheet tab strip. Hidden worksheets stay out of the strip but remain
 * reachable through the context menu, so hiding a sheet never loses it.
 */
export default function SheetWorksheetBar({
  document,
  onSelect,
  onAdd,
  onRename,
  onDuplicate,
  onDelete,
  onReorder,
  onToggleHidden,
  readOnly = false,
}: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);

  const visible = document.worksheets.filter((worksheet) => !worksheet.hidden);
  const hidden = document.worksheets.filter((worksheet) => worksheet.hidden);

  const commitRename = (worksheetId: string) => {
    const name = draft.trim();
    setRenamingId(null);
    if (name) onRename(worksheetId, name);
  };

  return (
    <div
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border/50 bg-muted/20 px-2 py-1"
      role="tablist"
      aria-label="Worksheets"
    >
      {!readOnly && (
        <button
          type="button"
          aria-label="Add worksheet"
          onClick={onAdd}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <Plus size={13} />
        </button>
      )}

      {visible.map((worksheet, index) => {
        const isActive = worksheet.id === document.activeWorksheetId;
        return (
          <ContextMenu key={worksheet.id}>
            <ContextMenuTrigger asChild>
              <div
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                draggable={!readOnly}
                onDragStart={() => setDragId(worksheet.id)}
                onDragOver={(event) => {
                  if (dragId && dragId !== worksheet.id) event.preventDefault();
                }}
                onDrop={() => {
                  if (dragId && dragId !== worksheet.id) onReorder(dragId, index);
                  setDragId(null);
                }}
                onDragEnd={() => setDragId(null)}
                onClick={() => onSelect(worksheet.id)}
                onDoubleClick={() => {
                  if (readOnly) return;
                  setDraft(worksheet.name);
                  setRenamingId(worksheet.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(worksheet.id);
                  }
                }}
                className={cn(
                  'flex h-6 shrink-0 cursor-pointer items-center rounded px-2 text-[12px] select-none',
                  isActive
                    ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                    : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                )}
              >
                {renamingId === worksheet.id ? (
                  <Input
                    autoFocus
                    value={draft}
                    aria-label="Worksheet name"
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => commitRename(worksheet.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename(worksheet.id);
                      if (event.key === 'Escape') setRenamingId(null);
                      event.stopPropagation();
                    }}
                    className="h-5 w-28 px-1 text-[12px]"
                  />
                ) : (
                  worksheet.name
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="text-[12.5px]">
              <ContextMenuItem
                disabled={readOnly}
                onClick={() => {
                  setDraft(worksheet.name);
                  setRenamingId(worksheet.id);
                }}
              >
                Rename
              </ContextMenuItem>
              <ContextMenuItem disabled={readOnly} onClick={() => onDuplicate(worksheet.id)}>
                <Copy size={12} /> Duplicate
              </ContextMenuItem>
              <ContextMenuItem
                disabled={readOnly}
                onClick={() => onToggleHidden(worksheet.id, true)}
              >
                <EyeOff size={12} /> Hide
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={readOnly || visible.length <= 1}
                onClick={() => onDelete(worksheet.id)}
              >
                <Trash2 size={12} /> Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}

      {hidden.length > 0 && (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              className="ml-1 flex h-6 shrink-0 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent/40"
            >
              <EyeOff size={11} />
              {hidden.length} hidden
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="text-[12.5px]">
            {hidden.map((worksheet) => (
              <ContextMenuItem
                key={worksheet.id}
                disabled={readOnly}
                onClick={() => onToggleHidden(worksheet.id, false)}
              >
                <Eye size={12} /> Show {worksheet.name}
              </ContextMenuItem>
            ))}
          </ContextMenuContent>
        </ContextMenu>
      )}
    </div>
  );
}
