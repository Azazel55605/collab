import { GripVertical, X, ChevronDown, GitFork, Layout, LayoutDashboard, Settings, FileText } from 'lucide-react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { cn } from '../../lib/utils';
import { useGridStore, type GridCell as GridCellType, type GridCellContent } from '../../store/gridStore';
import CellContentPicker from './CellContentPicker';
import NoteView from '../../views/NoteView';
import GraphPage from '../../views/GraphPage';
import CanvasPage from '../../views/CanvasPage';
import KanbanPage from '../../views/KanbanPage';
import SettingsPage from '../../views/SettingsPage';

const CONTENT_ICONS: Partial<Record<string, React.ReactNode>> = {
  note:     <FileText size={11} />,
  graph:    <GitFork size={11} />,
  canvas:   <Layout size={11} />,
  kanban:   <LayoutDashboard size={11} />,
  settings: <Settings size={11} />,
};

interface Props {
  cell: GridCellType;
}

export default function GridCell({ cell }: Props) {
  const { setCellContent, clearCell } = useGridStore();

  // ── dnd-kit: make the grip handle draggable ──────────────────────────────
  const { attributes, listeners, setNodeRef: setDragRef, isDragging, transform } = useDraggable({
    id: cell.id,
    data: { type: 'grid-cell', cellId: cell.id },
  });

  // ── dnd-kit: make the whole cell a drop target ───────────────────────────
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-${cell.id}`,
    data: { type: 'grid-cell-target', cellId: cell.id },
  });

  // Combine refs on the cell container
  const setRef = (node: HTMLDivElement | null) => {
    setDragRef(node);
    setDropRef(node);
  };

  const handleSelectContent = (content: GridCellContent) => {
    setCellContent(cell.id, content);
  };

  const renderContent = () => {
    const { type, relativePath } = cell.content;

    if (type === 'note' && relativePath) {
      return <NoteView relativePath={relativePath} />;
    }
    if (type === 'graph') {
      return (
        <GraphPage
          onNodeClick={(path, title) =>
            setCellContent(cell.id, { type: 'note', relativePath: path, title })
          }
        />
      );
    }
    if (type === 'canvas')   return <CanvasPage relativePath={null} />;
    if (type === 'kanban')   return <KanbanPage relativePath={null} />;
    if (type === 'settings') return <SettingsPage />;

    return (
      <div className="flex items-center justify-center h-full text-muted-foreground/25 select-none">
        <CellContentPicker onSelect={handleSelectContent}>
          <button className="group flex flex-col items-center gap-2 p-6 rounded-xl border border-dashed border-border/30 hover:border-primary/40 hover:text-primary/50 transition-all duration-200">
            <svg className="w-8 h-8 group-hover:scale-110 transition-transform duration-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            <span className="text-xs font-medium">Add content</span>
          </button>
        </CellContentPicker>
      </div>
    );
  };

  const { type, title } = cell.content;

  return (
    <div
      ref={setRef}
      className={cn(
        'relative flex flex-col bg-background overflow-hidden',
        'transition-shadow duration-150',
        isDragging && 'opacity-40 ring-2 ring-primary/30 ring-inset',
        isOver && !isDragging && 'ring-2 ring-primary ring-inset bg-primary/5'
      )}
      style={{
        transform: isDragging ? CSS.Translate.toString(transform) : undefined,
      }}
    >
      {/* Drop overlay pulse when another cell is dragged over this one */}
      {isOver && !isDragging && (
        <div className="absolute inset-0 z-10 pointer-events-none bg-primary/15" />
      )}

      {/* Cell header */}
      <div className="flex items-center gap-1 px-1.5 h-7 border-b border-border/40 bg-sidebar/40 shrink-0 group/header">
        {/* Drag handle — listeners attached only here */}
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors p-0.5 rounded shrink-0 touch-none"
          title="Drag to swap with another cell"
        >
          <GripVertical size={12} />
        </div>

        <span className="text-muted-foreground/50 shrink-0">
          {CONTENT_ICONS[type] ?? null}
        </span>
        <span className="flex-1 text-xs text-muted-foreground/70 truncate min-w-0">
          {type === 'empty' ? <span className="italic">Empty</span> : (title || type)}
        </span>

        <div className="flex items-center gap-0.5 opacity-0 group-hover/header:opacity-100 transition-opacity shrink-0">
          <CellContentPicker onSelect={handleSelectContent}>
            <button
              className="p-0.5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-accent/60 transition-colors"
              title="Change content"
            >
              <ChevronDown size={12} />
            </button>
          </CellContentPicker>
          {type !== 'empty' && (
            <button
              onClick={() => clearCell(cell.id)}
              className="p-0.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors"
              title="Clear cell"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {renderContent()}
      </div>
    </div>
  );
}
