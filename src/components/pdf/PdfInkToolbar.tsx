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
  /** Vertical renders an icon-only rail (labels stay for screen readers). */
  orientation?: 'horizontal' | 'vertical';
}

function active(tool: InkToolState, id: InkToolState['tool']) {
  return tool.tool === id ? 'bg-accent text-accent-foreground' : '';
}

export default function PdfInkToolbar({
  tool,
  readOnly,
  onChange,
  orientation = 'horizontal',
}: PdfInkToolbarProps) {
  const vertical = orientation === 'vertical';
  const buttonClass = vertical ? 'size-8 px-0' : 'h-8 gap-1.5 px-2 text-xs';
  const label = (text: string) => (vertical ? <span className="sr-only">{text}</span> : text);
  const caret = vertical ? null : <ChevronDown size={12} className="opacity-60" />;
  const menuSide = vertical ? ('right' as const) : ('bottom' as const);
  const chooseBrush = (id: keyof typeof INK_DEFAULT_BRUSHES) =>
    onChange({ ...tool, tool: 'pen', brushId: id, brush: { ...INK_DEFAULT_BRUSHES[id] } });

  return (
    <div
      className={cn(
        'pointer-events-auto flex items-center gap-1 rounded-xl border border-border/60 bg-popover/95 p-1 shadow-xl shadow-black/20',
        vertical && 'flex-col',
      )}
      role="toolbar"
      aria-label="PDF ink tools"
      aria-orientation={orientation}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={readOnly}
            className={cn(buttonClass, active(tool, 'pen'))}
          >
            {tool.brush.kind === 'highlighter' ? <Highlighter size={14} /> : <PenLine size={14} />}
            {label(tool.brush.kind === 'highlighter' ? 'Highlighter' : 'Pen')}
            {caret}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side={menuSide}>
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
        className={cn(buttonClass, active(tool, 'eraser'))}
        onClick={() => onChange({ ...tool, tool: 'eraser' })}
      >
        <Eraser size={14} />
        {label('Erase')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className={cn(buttonClass, active(tool, 'select'))}
        onClick={() => onChange({ ...tool, tool: 'select' })}
      >
        <MousePointer2 size={14} />
        {label('Select')}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={readOnly}
            className={cn(buttonClass, active(tool, 'shape'))}
          >
            <Shapes size={14} />
            {label('Shape')}
            {caret}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side={menuSide}>
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
        className={cn(buttonClass, active(tool, 'connector'))}
        onClick={() => onChange({ ...tool, tool: 'connector' })}
      >
        <Workflow size={14} />
        {label('Arrow')}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            disabled={readOnly}
            className={cn(buttonClass, active(tool, 'stamp'))}
          >
            <Stamp size={14} />
            {label('Stamp')}
            {caret}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side={menuSide}>
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
