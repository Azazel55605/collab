import { Eraser } from 'lucide-react';

import { cn } from '../../lib/utils';
import type { ImageOverlayItem } from '../../types/image';
import { Button } from '../ui/button';
import { Popover, PopoverTrigger } from '../ui/popover';
import { PopoverPanel, PopoverPanelHeader } from '../ui/popover-patterns';

import { describeOverlayCount, getOverlayItemLabel, getOverlayItemMeta } from './ImageViewUtils';

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
      <PopoverPanel align="end" className="w-88 max-w-[calc(100vw-40px)]">
        <PopoverPanelHeader title="Annotations" meta={describeOverlayCount(items.length)} />
        {items.length === 0 ? (
          <p className="px-3 pt-2 pb-6 text-center text-[12.5px] text-muted-foreground">
            No additive annotations yet. Draw on the image in Annotate mode.
          </p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto px-1.5 pb-1.5">
            {items.map((item, index) => {
              const isSelected = item.id === selectedItemId;
              return (
                <li
                  key={item.id}
                  className={cn(
                    'group flex items-center gap-1 rounded-lg transition-colors',
                    isSelected ? 'bg-primary/15' : 'hover:bg-muted/60',
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 px-2 py-1.5 text-left"
                    onClick={() => {
                      onSelectItem(item.id);
                      onOpenChange(false);
                    }}
                  >
                    <span className="block truncate text-[13px]">
                      {getOverlayItemLabel(item, index)}
                    </span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">
                      {getOverlayItemMeta(item)}
                    </span>
                  </button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove annotation ${index + 1}`}
                    className="mr-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                    onClick={() => onDeleteItem(item.id)}
                  >
                    <Eraser />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverPanel>
    </Popover>
  );
}
