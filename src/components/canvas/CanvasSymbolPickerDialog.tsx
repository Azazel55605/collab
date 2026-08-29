import { useDeferredValue, useMemo, useState } from 'react';

import {
  formatNerdFontHexCode,
  groupNerdFontIcons,
  searchNerdFontIcons,
} from '../../lib/nerdFontIcons';
import type { CanvasSymbolDefinition } from '../../types/canvas';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '../ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';

export interface CanvasSymbolChoice extends CanvasSymbolDefinition {}

export function CanvasSymbolPickerDialog({
  open,
  title,
  description,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  title: string;
  description: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (choice: CanvasSymbolChoice) => void;
}) {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const filteredEntries = useMemo(() => searchNerdFontIcons(deferredQuery, 180), [deferredQuery]);
  const groupedEntries = useMemo(() => groupNerdFontIcons(filteredEntries), [filteredEntries]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) setQuery('');
      }}
    >
      <DialogContent className="max-w-[30rem] overflow-hidden p-0">
        <DialogHeader className="border-b border-border/50 px-4 py-3">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} className="rounded-none border-none bg-transparent p-0">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            autoFocus
            placeholder="Search icons by name, id, or category..."
          />
          <CommandList className="max-h-[28rem]">
            <CommandEmpty>No icons found.</CommandEmpty>
            {groupedEntries.map(([categoryLabel, entries]) => (
              <CommandGroup key={categoryLabel} heading={categoryLabel}>
                {entries.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() =>
                      onSelect({
                        glyph: entry.glyph,
                        iconId: entry.id,
                        iconLabel: entry.nameLabel,
                      })
                    }
                    className="gap-3"
                  >
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-[18px] leading-none"
                      style={{ fontFamily: "'Pure Nerd Font', PureNerdFont, monospace" }}
                      aria-hidden="true"
                    >
                      {entry.glyph}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{entry.nameLabel}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {entry.id}
                      </span>
                    </span>
                    <CommandShortcut className="tracking-normal">
                      {formatNerdFontHexCode(entry.hexCode)}
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            <div className="border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
              Showing {filteredEntries.length} icon{filteredEntries.length === 1 ? '' : 's'}
              {deferredQuery.trim() ? ' for this search' : ' from the bundled catalog'}.
            </div>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
