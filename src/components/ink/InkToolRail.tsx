import {
  Eraser,
  Hand,
  Highlighter,
  Lasso,
  MousePointer2,
  PenLine,
  PenTool,
  Pencil,
  Brush,
  Minus,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { InkBrushKind } from '../../types/ink';
import { INK_BRUSH_ORDER, INK_SHORTCUTS } from '../../lib/ink/tools';
import type { InkToolId, InkToolState } from '../../lib/ink/tools';
import { INK_DEFAULT_BRUSHES } from '../../lib/ink/document';

/**
 * The tool rail.
 *
 * Deliberately narrow and icon-only: on a tablet this sits beside the drawing
 * hand, and every pixel it takes is page the user cannot see. Labels live in
 * tooltips, and each carries its keyboard shortcut so the rail teaches the
 * shortcuts rather than competing with them.
 */

const BRUSH_ICONS: Record<InkBrushKind, ReactNode> = {
  ballpoint: <PenLine size={16} />,
  fountain: <PenTool size={16} />,
  technical: <Minus size={16} />,
  pencil: <Pencil size={16} />,
  marker: <Brush size={16} />,
  brush: <Brush size={16} />,
  highlighter: <Highlighter size={16} />,
};

function shortcutFor(command: string): string {
  const shortcut = INK_SHORTCUTS.find((entry) => entry.command === command);
  if (!shortcut) return '';
  const parts = [
    shortcut.ctrl ? 'Ctrl' : '',
    shortcut.shift ? 'Shift' : '',
    shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key,
  ].filter(Boolean);
  return ` (${parts.join('+')})`;
}

interface RailButtonProps {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

function RailButton({ label, active, disabled, onClick, children }: RailButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            'flex size-9 items-center justify-center rounded-lg border transition-colors app-motion-fast',
            active
              ? 'border-primary bg-primary/15 text-foreground'
              : 'border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            disabled && 'pointer-events-none opacity-40',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="text-xs text-foreground">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export interface InkToolRailProps {
  tool: InkToolState;
  readOnly: boolean;
  onSelectTool: (tool: InkToolId) => void;
  onSelectBrush: (kind: InkBrushKind) => void;
}

export default function InkToolRail({
  tool,
  readOnly,
  onSelectTool,
  onSelectBrush,
}: InkToolRailProps) {
  return (
    <div
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border/60 bg-card/40 py-2"
      role="toolbar"
      aria-orientation="vertical"
      aria-label="Drawing tools"
    >
      <RailButton
        label={`Pen${shortcutFor('tool.pen')}`}
        active={tool.tool === 'pen'}
        disabled={readOnly}
        onClick={() => onSelectTool('pen')}
      >
        {BRUSH_ICONS[tool.brush.kind] ?? <PenLine size={16} />}
      </RailButton>
      <RailButton
        label={`Eraser${shortcutFor('tool.eraser')}`}
        active={tool.tool === 'eraser'}
        disabled={readOnly}
        onClick={() => onSelectTool('eraser')}
      >
        <Eraser size={16} />
      </RailButton>
      <RailButton
        label={`Select${shortcutFor('tool.select')}`}
        active={tool.tool === 'select'}
        onClick={() => onSelectTool('select')}
      >
        <MousePointer2 size={16} />
      </RailButton>
      <RailButton
        label={`Lasso${shortcutFor('tool.lasso')}`}
        active={tool.tool === 'lasso'}
        onClick={() => onSelectTool('lasso')}
      >
        <Lasso size={16} />
      </RailButton>
      <RailButton
        label={`Pan${shortcutFor('tool.pan')}`}
        active={tool.tool === 'pan'}
        onClick={() => onSelectTool('pan')}
      >
        <Hand size={16} />
      </RailButton>

      <div className="my-1 h-px w-6 bg-border/60" />

      {INK_BRUSH_ORDER.map((kind) => (
        <RailButton
          key={kind}
          label={INK_DEFAULT_BRUSHES[kind]?.name ?? kind}
          active={tool.tool === 'pen' && tool.brush.kind === kind}
          disabled={readOnly}
          onClick={() => onSelectBrush(kind)}
        >
          {BRUSH_ICONS[kind]}
        </RailButton>
      ))}
    </div>
  );
}
