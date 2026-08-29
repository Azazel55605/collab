import { useMemo } from 'react';

import { cn } from '../../lib/utils';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';

import { type CanvasInsertItem, canvasInsertItems } from './canvasInsertItems';

interface CanvasInsertMenuProps {
  open: boolean;
  x: number;
  y: number;
  onSelect: (item: CanvasInsertItem) => void;
  onClose: () => void;
}

export function CanvasInsertMenu({ open, x, y, onSelect, onClose }: CanvasInsertMenuProps) {
  const groupedItems = useMemo(() => {
    const groups = new Map<string, CanvasInsertItem[]>();
    for (const item of canvasInsertItems) {
      const existing = groups.get(item.group) ?? [];
      existing.push(item);
      groups.set(item.group, existing);
    }
    return [...groups.entries()];
  }, []);

  if (!open) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Close insert menu"
        className="absolute inset-0 z-20 cursor-default bg-transparent"
        onClick={onClose}
      />
      <div
        className="absolute z-30 w-[320px] max-w-[calc(100%-24px)] app-panel-enter"
        style={{ left: x, top: y }}
      >
        <Command
          className={cn(
            'rounded-2xl border border-border/70 bg-popover/96 p-1 shadow-2xl ring-1 ring-black/5 backdrop-blur-xs-webkit',
          )}
        >
          <CommandInput autoFocus placeholder="Add to canvas…" />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>No matching elements.</CommandEmpty>
            {groupedItems.map(([group, items]) => (
              <CommandGroup key={group} heading={group}>
                {items.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={`${item.label} ${item.keywords}`}
                    onSelect={() => onSelect(item)}
                    className="gap-2"
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </div>
    </>
  );
}
