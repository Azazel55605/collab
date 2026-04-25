import { Eraser } from 'lucide-react';

import { cn } from '../../lib/utils';
import type { ImageOverlayItem } from '../../types/image';
import { Button } from '../ui/button';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '../ui/popover';
import {
  describeOverlayCount,
  getOverlayItemLabel,
  getOverlayItemMeta,
} from './ImageViewUtils';

interface ImageAnnotationsPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: ImageOverlayItem[];
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  onDeleteItem: (id: string) => void;
}

export function ImageAnnotationsPopover({
  open,
  onOpenChange,
  items,
  selectedItemId,
  onSelectItem,
  onDeleteItem,
}: ImageAnnotationsPopoverProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-full border border-border/50 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/90 transition-colors app-motion-fast hover:border-primary/40 hover:bg-primary/8 hover:text-foreground"
        >
          {describeOverlayCount(items.length)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-w-[calc(100vw-40px)] p-3">
        <PopoverHeader className="mb-1">
          <PopoverTitle>Annotations</PopoverTitle>
          <PopoverDescription>
            Select an additive annotation or remove it from the image.
          </PopoverDescription>
        </PopoverHeader>

        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
            No additive annotations yet.
          </div>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
            {items.map((item, index) => {
              const isSelected = item.id === selectedItemId;
              return (
                <div
                  key={item.id}
                  className={cn(
                    'flex items-start gap-2 rounded-xl border px-3 py-2 transition-colors app-motion-fast',
                    isSelected
                      ? 'border-primary/45 bg-primary/10'
                      : 'border-border/50 bg-background/45 hover:border-border hover:bg-background/70',
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      onSelectItem(item.id);
                      onOpenChange(false);
                    }}
                  >
                    <div className="truncate text-sm font-medium text-foreground">
                      {getOverlayItemLabel(item, index)}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {getOverlayItemMeta(item)}
                    </div>
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 shrink-0 px-2 text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      onDeleteItem(item.id);
                    }}
                  >
                    <Eraser size={14} />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
