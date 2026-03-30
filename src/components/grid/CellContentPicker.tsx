import { useState } from 'react';
import { GitFork, Layout, LayoutDashboard, Settings, FileText, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import type { GridCellContent, CellContentType } from '../../store/gridStore';

const VIEW_OPTIONS: { type: CellContentType; label: string; icon: React.ReactNode }[] = [
  { type: 'graph',    label: 'Graph',    icon: <GitFork size={14} /> },
  { type: 'canvas',  label: 'Canvas',   icon: <Layout size={14} /> },
  { type: 'kanban',  label: 'Kanban',   icon: <LayoutDashboard size={14} /> },
  { type: 'settings',label: 'Settings', icon: <Settings size={14} /> },
];

interface Props {
  children: React.ReactNode;
  onSelect: (content: GridCellContent) => void;
}

export default function CellContentPicker({ children, onSelect }: Props) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const { notes } = useNoteIndexStore();

  const filteredNotes = search.trim()
    ? notes
        .filter(
          (n) =>
            n.title.toLowerCase().includes(search.toLowerCase()) ||
            n.relativePath.toLowerCase().includes(search.toLowerCase())
        )
        .slice(0, 12)
    : notes.slice(0, 10);

  const select = (content: GridCellContent) => {
    onSelect(content);
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-60 p-0 overflow-hidden"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Quick view buttons */}
        <div className="flex items-center gap-1 p-2 border-b border-border/50">
          {VIEW_OPTIONS.map(({ type, label, icon }) => (
            <Tooltip key={type}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => select({ type, relativePath: null, title: label })}
                  className="flex-1 flex items-center justify-center h-8 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
                >
                  {icon}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        {/* Note search */}
        <div className="p-2 space-y-1.5">
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-muted/40 border border-border/40">
            <Search size={11} className="text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Search notes…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60 min-w-0"
              autoFocus
            />
          </div>
          <div className="max-h-52 overflow-y-auto space-y-0.5">
            {filteredNotes.length > 0 ? (
              filteredNotes.map((note) => (
                <button
                  key={note.relativePath}
                  onClick={() =>
                    select({
                      type: 'note',
                      relativePath: note.relativePath,
                      title: note.title || note.relativePath,
                    })
                  }
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-accent/60 text-left transition-colors min-w-0"
                >
                  <FileText size={11} className="text-muted-foreground shrink-0" />
                  <span className="truncate text-foreground/80">
                    {note.title || note.relativePath}
                  </span>
                </button>
              ))
            ) : (
              <p className="text-xs text-muted-foreground text-center py-4">No notes found</p>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
