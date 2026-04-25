import {
  FileText,
  Globe,
  Maximize2,
  Minus,
  MousePointer2,
  PencilLine,
  Plus as PlusIcon,
  Plus,
  RotateCcw,
} from 'lucide-react';

import { documentTopBarGroupClass } from '../layout/DocumentTopBar';
import { Button } from '../ui/button';

interface CanvasToolbarProps {
  zoomLabel: string;
  onAddNote: () => void;
  onAddFile: () => void;
  onAddText: () => void;
  onAddWeb: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onZoomIn: () => void;
  onFitView: () => void;
}

export function CanvasToolbar({
  zoomLabel,
  onAddNote,
  onAddFile,
  onAddText,
  onAddWeb,
  onZoomOut,
  onResetZoom,
  onZoomIn,
  onFitView,
}: CanvasToolbarProps) {
  return (
    <>
      <div className={documentTopBarGroupClass}>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs" onClick={onAddNote}>
          <Plus size={14} />
          Add note
        </Button>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs" onClick={onAddFile}>
          <FileText size={14} />
          Add file
        </Button>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs" onClick={onAddText}>
          <PencilLine size={14} />
          Add text
        </Button>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs" onClick={onAddWeb}>
          <Globe size={14} />
          Add web
        </Button>
      </div>

      <div className={documentTopBarGroupClass}>
        <Button size="icon" variant="ghost" className="size-8" onClick={onZoomOut} title="Zoom out">
          <Minus size={15} />
        </Button>
        <button
          type="button"
          onClick={onResetZoom}
          className="min-w-[78px] rounded-md px-2 text-center text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          title="Reset zoom to 100%"
        >
          {zoomLabel}
        </button>
        <Button size="icon" variant="ghost" className="size-8" onClick={onZoomIn} title="Zoom in">
          <PlusIcon size={15} />
        </Button>
      </div>

      <div className={documentTopBarGroupClass}>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs" onClick={onFitView}>
          <Maximize2 size={14} />
          Fit view
        </Button>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2.5 text-xs" onClick={onResetZoom}>
          <RotateCcw size={14} />
          Reset zoom
        </Button>
      </div>

      <div className="hidden items-center gap-2 rounded-xl border border-border/60 bg-card/45 px-2.5 py-1 text-xs text-muted-foreground lg:flex">
        <MousePointer2 size={13} />
        Drag the board to pan. Drag files from the sidebar to add them.
      </div>
    </>
  );
}
