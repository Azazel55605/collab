import {
  ChevronDown,
  Eraser,
  Highlighter,
  MousePointer2,
  PenLine,
  Shapes,
  Stamp,
  Workflow,
} from 'lucide-react';

import { INK_SHAPE_ORDER, INK_STAMP_CATALOG } from '../../lib/ink/advancedTools';
import { INK_DEFAULT_BRUSHES } from '../../lib/ink/document';
import type { InkToolState } from '../../lib/ink/tools';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

interface PdfInkToolbarProps {
  tool: InkToolState;
  readOnly: boolean;
  onChange: (tool: InkToolState) => void;
}

function active(tool: InkToolState, id: InkToolState['tool']) {
  return tool.tool === id ? 'bg-accent text-accent-foreground' : '';
}

export default function PdfInkToolbar({ tool, readOnly, onChange }: PdfInkToolbarProps) {
  const chooseBrush = (id: keyof typeof INK_DEFAULT_BRUSHES) =>
    onChange({ ...tool, tool: 'pen', brushId: id, brush: { ...INK_DEFAULT_BRUSHES[id] } });

  return (
    <div
      className="pointer-events-auto flex items-center gap-1 rounded-xl border border-border/60 bg-popover/95 p-1 shadow-xl shadow-black/20"
      role="toolbar"
      aria-label="PDF ink tools"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={readOnly}
            className={cn('h-8 gap-1.5 px-2 text-xs', active(tool, 'pen'))}
          >
            {tool.brush.kind === 'highlighter' ? <Highlighter size={14} /> : <PenLine size={14} />}
            {tool.brush.kind === 'highlighter' ? 'Highlighter' : 'Pen'}
            <ChevronDown size={12} className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {(['ballpoint', 'fountain', 'technical', 'pencil', 'marker'] as const).map((id) => (
            <DropdownMenuItem key={id} onClick={() => chooseBrush(id)}>
              <PenLine size={14} className="mr-2" />
              {INK_DEFAULT_BRUSHES[id].name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem onClick={() => chooseBrush('highlighter')}>
            <Highlighter size={14} className="mr-2" />
            Highlighter
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        size="sm"
        variant="ghost"
        disabled={readOnly}
        className={cn('h-8 gap-1.5 px-2 text-xs', active(tool, 'eraser'))}
        onClick={() => onChange({ ...tool, tool: 'eraser' })}
      >
        <Eraser size={14} />
        Erase
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={cn('h-8 gap-1.5 px-2 text-xs', active(tool, 'select'))}
        onClick={() => onChange({ ...tool, tool: 'select' })}
      >
        <MousePointer2 size={14} />
        Select
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={readOnly}
            className={cn('h-8 gap-1.5 px-2 text-xs', active(tool, 'shape'))}
          >
            <Shapes size={14} />
            Shape
            <ChevronDown size={12} className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {INK_SHAPE_ORDER.map((shape) => (
            <DropdownMenuItem
              key={shape}
              onClick={() => onChange({ ...tool, tool: 'shape', shapeKind: shape })}
            >
              <Shapes size={14} className="mr-2" />
              {shape[0].toUpperCase() + shape.slice(1)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        size="sm"
        variant="ghost"
        disabled={readOnly}
        className={cn('h-8 gap-1.5 px-2 text-xs', active(tool, 'connector'))}
        onClick={() => onChange({ ...tool, tool: 'connector' })}
      >
        <Workflow size={14} />
        Arrow
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={readOnly}
            className={cn('h-8 gap-1.5 px-2 text-xs', active(tool, 'stamp'))}
          >
            <Stamp size={14} />
            Stamp
            <ChevronDown size={12} className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {INK_STAMP_CATALOG.map((stamp) => (
            <DropdownMenuItem
              key={stamp.id}
              onClick={() => onChange({ ...tool, tool: 'stamp', stampSymbolId: stamp.id })}
            >
              <span className="mr-2 w-4 text-center">{stamp.glyph}</span>
              {stamp.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
