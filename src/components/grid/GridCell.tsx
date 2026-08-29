import { useDraggable, useDroppable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronDown,
  CircuitBoard,
  FileText,
  GitFork,
  GripVertical,
  Image as ImageIcon,
  Layout,
  LayoutDashboard,
  Settings,
  X,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import {
  flattenVaultFiles,
  getVaultDocumentTabType,
  getVaultDocumentTitle,
} from '../../lib/vaultLinks';
import {
  type GridCellContent,
  type GridCell as GridCellType,
  useGridStore,
} from '../../store/gridStore';
import { useVaultStore } from '../../store/vaultStore';
import CanvasPage from '../../views/CanvasPage';
import GraphPage from '../../views/GraphPage';
import ImageView from '../../views/ImageView';
import KanbanPage from '../../views/KanbanPage';
import LogicDiagramView from '../../views/LogicDiagramView';
import NoteView from '../../views/NoteView';
import PdfView from '../../views/PdfView';
import SettingsPage from '../../views/SettingsPage';

import CellContentPicker from './CellContentPicker';

const CONTENT_ICONS: Partial<Record<string, React.ReactNode>> = {
  note: <FileText size={11} />,
  graph: <GitFork size={11} />,
  canvas: <Layout size={11} />,
  kanban: <LayoutDashboard size={11} />,
  logic: <CircuitBoard size={11} />,
  image: <ImageIcon size={11} />,
  pdf: <FileText size={11} />,
  settings: <Settings size={11} />,
};

interface Props {
  cell: GridCellType;
  onContainerRef?: (cellId: string, node: HTMLDivElement | null) => void;
}

export default function GridCell({ cell, onContainerRef }: Props) {
  const { setCellContent, clearCell } = useGridStore();
  const fileTree = useVaultStore((state) => state.fileTree);

  // ── dnd-kit: make the grip handle draggable ──────────────────────────────
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
    transform,
  } = useDraggable({
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
    onContainerRef?.(cell.id, node);
  };

  const handleSelectContent = (content: GridCellContent) => {
    setCellContent(cell.id, content);
  };

  const getWorkspaceContentFromRelativePath = (relativePath: string): GridCellContent | null => {
    const file = flattenVaultFiles(fileTree).find((entry) => entry.relativePath === relativePath);
    if (!file) return null;

    const type = getVaultDocumentTabType(relativePath);
    if (
      type !== 'note' &&
      type !== 'canvas' &&
      type !== 'kanban' &&
      type !== 'logic' &&
      type !== 'image' &&
      type !== 'pdf'
    )
      return null;

    return {
      type,
      relativePath,
      title: getVaultDocumentTitle(relativePath),
    };
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
    if (type === 'canvas' && relativePath) {
      return <CanvasPage relativePath={relativePath} />;
    }
    if (type === 'kanban' && relativePath) {
      return <KanbanPage relativePath={relativePath} />;
    }
    if (type === 'logic' && relativePath) {
      return <LogicDiagramView relativePath={relativePath} />;
    }
    if (type === 'image' && relativePath) {
      return <ImageView relativePath={relativePath} />;
    }
    if (type === 'pdf' && relativePath) {
      return <PdfView relativePath={relativePath} />;
    }
    if (type === 'settings') return <SettingsPage />;

    return (
      <div className="flex items-center justify-center h-full text-muted-foreground/25 select-none">
        <CellContentPicker onSelect={handleSelectContent}>
          <button className="group flex flex-col items-center gap-2 p-6 rounded-xl border border-dashed border-border/30 hover:border-primary/40 hover:text-primary/50 transition-all duration-200">
            <svg
              className="w-8 h-8 group-hover:scale-110 transition-transform duration-200"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
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
        isOver && !isDragging && 'ring-2 ring-primary ring-inset bg-primary/5',
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

        <span className="text-muted-foreground/50 shrink-0">{CONTENT_ICONS[type] ?? null}</span>
        <span className="flex-1 text-xs text-muted-foreground/70 truncate min-w-0">
          {type === 'empty' ? <span className="italic">Empty</span> : title || type}
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
        <div
          className="h-full"
          onDragOver={(event) => {
            const relativePath =
              event.dataTransfer.getData('application/x-collab-vault-file') ||
              event.dataTransfer.getData('text/plain');
            if (!relativePath || !getWorkspaceContentFromRelativePath(relativePath)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(event) => {
            const relativePath =
              event.dataTransfer.getData('application/x-collab-vault-file') ||
              event.dataTransfer.getData('text/plain');
            const content = relativePath ? getWorkspaceContentFromRelativePath(relativePath) : null;
            if (!content) return;
            event.preventDefault();
            event.stopPropagation();
            setCellContent(cell.id, content);
          }}
        >
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
