import { useState } from 'react';

import {
  CircuitBoard,
  FileText,
  GitFork,
  Image as ImageIcon,
  Layout,
  LayoutDashboard,
  Search,
  Settings,
} from 'lucide-react';

import {
  flattenVaultFiles,
  getVaultDocumentTabType,
  getVaultDocumentTitle,
} from '../../lib/vaultLinks';
import type { CellContentType, GridCellContent } from '../../store/gridStore';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useVaultStore } from '../../store/vaultStore';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

const VIEW_OPTIONS: { type: CellContentType; label: string; icon: React.ReactNode }[] = [
  { type: 'graph', label: 'Graph', icon: <GitFork size={14} /> },
  { type: 'settings', label: 'Settings', icon: <Settings size={14} /> },
];

interface Props {
  children: React.ReactNode;
  onSelect: (content: GridCellContent) => void;
}

export default function CellContentPicker({ children, onSelect }: Props) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const { notes } = useNoteIndexStore();
  const fileTree = useVaultStore((state) => state.fileTree);
  const flatFiles = flattenVaultFiles(fileTree);
  const canvasBoards = flatFiles.filter(
    (file) => getVaultDocumentTabType(file.relativePath) === 'canvas',
  );
  const kanbanBoards = flatFiles.filter(
    (file) => getVaultDocumentTabType(file.relativePath) === 'kanban',
  );
  const logicDiagrams = flatFiles.filter(
    (file) => getVaultDocumentTabType(file.relativePath) === 'logic',
  );
  const imageFiles = flatFiles.filter(
    (file) => getVaultDocumentTabType(file.relativePath) === 'image',
  );
  const pdfFiles = flatFiles.filter((file) => getVaultDocumentTabType(file.relativePath) === 'pdf');

  const filteredNotes = search.trim()
    ? notes
        .filter(
          (n) =>
            n.title.toLowerCase().includes(search.toLowerCase()) ||
            n.relativePath.toLowerCase().includes(search.toLowerCase()),
        )
        .slice(0, 12)
    : notes.slice(0, 10);

  const query = search.trim().toLowerCase();
  const filteredCanvasBoards = (
    query
      ? canvasBoards.filter(
          (file) =>
            file.name.toLowerCase().includes(query) ||
            file.relativePath.toLowerCase().includes(query),
        )
      : canvasBoards
  ).slice(0, 8);
  const filteredKanbanBoards = (
    query
      ? kanbanBoards.filter(
          (file) =>
            file.name.toLowerCase().includes(query) ||
            file.relativePath.toLowerCase().includes(query),
        )
      : kanbanBoards
  ).slice(0, 8);
  const filteredLogicDiagrams = (
    query
      ? logicDiagrams.filter(
          (file) =>
            file.name.toLowerCase().includes(query) ||
            file.relativePath.toLowerCase().includes(query),
        )
      : logicDiagrams
  ).slice(0, 8);
  const filteredImageFiles = (
    query
      ? imageFiles.filter(
          (file) =>
            file.name.toLowerCase().includes(query) ||
            file.relativePath.toLowerCase().includes(query),
        )
      : imageFiles
  ).slice(0, 8);
  const filteredPdfFiles = (
    query
      ? pdfFiles.filter(
          (file) =>
            file.name.toLowerCase().includes(query) ||
            file.relativePath.toLowerCase().includes(query),
        )
      : pdfFiles
  ).slice(0, 8);

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
              <TooltipContent side="bottom" className="text-xs">
                {label}
              </TooltipContent>
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
            {filteredCanvasBoards.map((file) => (
              <button
                key={`canvas:${file.relativePath}`}
                onClick={() =>
                  select({
                    type: 'canvas',
                    relativePath: file.relativePath,
                    title: getVaultDocumentTitle(file.relativePath),
                  })
                }
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-accent/60 text-left transition-colors min-w-0"
              >
                <Layout size={11} className="text-blue-400/70 shrink-0" />
                <span className="truncate text-foreground/80">
                  {getVaultDocumentTitle(file.relativePath)}
                </span>
              </button>
            ))}
            {filteredKanbanBoards.map((file) => (
              <button
                key={`kanban:${file.relativePath}`}
                onClick={() =>
                  select({
                    type: 'kanban',
                    relativePath: file.relativePath,
                    title: getVaultDocumentTitle(file.relativePath),
                  })
                }
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-accent/60 text-left transition-colors min-w-0"
              >
                <LayoutDashboard size={11} className="text-emerald-400/70 shrink-0" />
                <span className="truncate text-foreground/80">
                  {getVaultDocumentTitle(file.relativePath)}
                </span>
              </button>
            ))}
            {filteredLogicDiagrams.map((file) => (
              <button
                key={`logic:${file.relativePath}`}
                onClick={() =>
                  select({
                    type: 'logic',
                    relativePath: file.relativePath,
                    title: getVaultDocumentTitle(file.relativePath),
                  })
                }
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-accent/60 text-left transition-colors min-w-0"
              >
                <CircuitBoard size={11} className="text-cyan-400/70 shrink-0" />
                <span className="truncate text-foreground/80">
                  {getVaultDocumentTitle(file.relativePath)}
                </span>
              </button>
            ))}
            {filteredPdfFiles.map((file) => (
              <button
                key={`pdf:${file.relativePath}`}
                onClick={() =>
                  select({
                    type: 'pdf',
                    relativePath: file.relativePath,
                    title: getVaultDocumentTitle(file.relativePath),
                  })
                }
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-accent/60 text-left transition-colors min-w-0"
              >
                <FileText size={11} className="text-rose-400/70 shrink-0" />
                <span className="truncate text-foreground/80">
                  {getVaultDocumentTitle(file.relativePath)}
                </span>
              </button>
            ))}
            {filteredImageFiles.map((file) => (
              <button
                key={`image:${file.relativePath}`}
                onClick={() =>
                  select({
                    type: 'image',
                    relativePath: file.relativePath,
                    title: getVaultDocumentTitle(file.relativePath),
                  })
                }
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-accent/60 text-left transition-colors min-w-0"
              >
                <ImageIcon size={11} className="text-amber-400/70 shrink-0" />
                <span className="truncate text-foreground/80">
                  {getVaultDocumentTitle(file.relativePath)}
                </span>
              </button>
            ))}
            {filteredNotes.length > 0
              ? filteredNotes.map((note) => (
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
              : filteredCanvasBoards.length === 0 &&
                filteredKanbanBoards.length === 0 &&
                filteredPdfFiles.length === 0 &&
                filteredImageFiles.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">
                    No matching content found
                  </p>
                )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
