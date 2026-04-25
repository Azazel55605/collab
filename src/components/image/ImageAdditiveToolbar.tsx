import { Eraser, MoveUpRight, Paintbrush, PencilLine, Type } from 'lucide-react';

import type { ImageLineStyle, ImageOverlayTool } from '../../types/image';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

interface ImageAdditiveToolbarProps {
  tool: ImageOverlayTool;
  onToolChange: (tool: ImageOverlayTool) => void;
  activeColor: string;
  overlayColors: string[];
  colorOpen: boolean;
  onColorOpenChange: (open: boolean) => void;
  hexDraft: string;
  onHexDraftChange: (value: string) => void;
  onApplyHexColor: () => void;
  onColorSelect: (color: string) => void;
  strokeWidth: number;
  onStrokeWidthChange: (value: string) => void;
  lineStyle: ImageLineStyle | null;
  onLineStyleChange: (value: ImageLineStyle) => void;
  fontSize: number;
  onFontSizeChange: (value: string) => void;
  hasSelectedItem: boolean;
  onDeleteSelected: () => void;
  hasAdditiveItems: boolean;
  onBakeIntoImage: () => void;
}

export function ImageAdditiveToolbar({
  tool,
  onToolChange,
  activeColor,
  overlayColors,
  colorOpen,
  onColorOpenChange,
  hexDraft,
  onHexDraftChange,
  onApplyHexColor,
  onColorSelect,
  strokeWidth,
  onStrokeWidthChange,
  lineStyle,
  onLineStyleChange,
  fontSize,
  onFontSizeChange,
  hasSelectedItem,
  onDeleteSelected,
  hasAdditiveItems,
  onBakeIntoImage,
}: ImageAdditiveToolbarProps) {
  return (
    <>
      <div className="flex items-center gap-1 rounded-xl border border-border/60 bg-background/55 p-1">
        {([
          ['select', PencilLine, 'Select'],
          ['text', Type, 'Text'],
          ['arrow', MoveUpRight, 'Arrow'],
          ['pen', Paintbrush, 'Freehand'],
        ] as const).map(([nextTool, Icon, label]) => (
          <Button
            key={nextTool}
            size="sm"
            variant="ghost"
            className={cn('h-8 gap-1.5 px-2.5 text-xs app-motion-fast', tool === nextTool && 'bg-accent text-accent-foreground')}
            onClick={() => onToolChange(nextTool)}
          >
            <Icon size={14} />
            {label}
          </Button>
        ))}
      </div>

      <label className="ml-2 flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2 py-1 text-[11px]">
        <span>Color</span>
        <Popover open={colorOpen} onOpenChange={onColorOpenChange}>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-7 w-9 border-border/50 bg-background/70 px-1.5"
            >
              <span
                className="h-3.5 w-full rounded-sm border border-black/20"
                style={{ backgroundColor: activeColor }}
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="flex w-auto flex-col gap-2 p-2.5">
            <div className="grid grid-cols-5 gap-2">
              {overlayColors.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => onColorSelect(swatch)}
                  className={cn(
                    'h-7 w-7 rounded-full border border-white/10 transition-transform hover:scale-110',
                    activeColor === swatch && 'ring-2 ring-white/60 ring-offset-1 ring-offset-popover',
                  )}
                  style={{ backgroundColor: swatch }}
                  aria-label={`Select color ${swatch}`}
                />
              ))}
            </div>
            <div className="flex items-center gap-2 border-t border-border/40 pt-2">
              <div
                className="h-6 w-6 shrink-0 rounded-md border border-white/15"
                style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(hexDraft) ? hexDraft : activeColor }}
              />
              <Input
                value={hexDraft}
                onChange={(event) => onHexDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    onApplyHexColor();
                  }
                }}
                onBlur={onApplyHexColor}
                placeholder="#rrggbb"
                className="h-7 w-28 px-2 font-mono text-xs"
                maxLength={7}
                spellCheck={false}
              />
            </div>
          </PopoverContent>
        </Popover>
      </label>

      <label className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2 py-1 text-[11px]">
        <span>Stroke</span>
        <Input
          type="number"
          min={1}
          max={18}
          value={strokeWidth}
          className="h-7 w-16"
          onChange={(event) => onStrokeWidthChange(event.target.value)}
        />
      </label>

      {lineStyle && (
        <label className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2 py-1 text-[11px]">
          <span>Line</span>
          <Select value={lineStyle} onValueChange={(value) => onLineStyleChange(value as ImageLineStyle)}>
            <SelectTrigger size="sm" className="h-7 bg-background/70 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="solid">Solid</SelectItem>
              <SelectItem value="dashed">Dashed</SelectItem>
              <SelectItem value="dotted">Dotted</SelectItem>
            </SelectContent>
          </Select>
        </label>
      )}

      <label className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2 py-1 text-[11px]">
        <span>Text</span>
        <Input
          type="number"
          min={10}
          max={64}
          value={fontSize}
          className="h-7 w-16"
          onChange={(event) => onFontSizeChange(event.target.value)}
        />
      </label>

      {hasSelectedItem && (
        <Button size="sm" variant="ghost" className="h-8 text-destructive" onClick={onDeleteSelected}>
          <Eraser size={14} className="mr-1.5" />
          Delete selected
        </Button>
      )}

      {hasAdditiveItems && (
        <Button size="sm" variant="secondary" className="h-8" onClick={onBakeIntoImage}>
          Bake Into Image
        </Button>
      )}
    </>
  );
}
