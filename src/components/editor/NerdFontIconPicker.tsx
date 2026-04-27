import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Shapes } from 'lucide-react';
import {
  formatNerdFontHexCode,
  groupNerdFontIcons,
  searchNerdFontIcons,
} from '../../lib/nerdFontIcons';
import { EDITOR_TOOLBAR_ACTION_EVENT } from '../../lib/editorToolbarActions';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

interface NerdFontIconPickerProps {
  onInsert: (glyph: string) => void;
}

export function NerdFontIconPicker({ onInsert }: NerdFontIconPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    const handler = (event: Event) => {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      if (action !== 'icon') return;
      setOpen(true);
    };

    window.addEventListener(EDITOR_TOOLBAR_ACTION_EVENT, handler);
    return () => window.removeEventListener(EDITOR_TOOLBAR_ACTION_EVENT, handler);
  }, []);

  const filteredEntries = useMemo(() => searchNerdFontIcons(deferredQuery, 180), [deferredQuery]);
  const groupedEntries = useMemo(() => groupNerdFontIcons(filteredEntries), [filteredEntries]);

  const handleInsert = (glyph: string) => {
    onInsert(glyph);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery('');
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              aria-label="Insert Nerd Font icon"
            >
              <Shapes size={13} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Insert Nerd Font icon (Ctrl+Alt+S)</TooltipContent>
      </Tooltip>

      <PopoverContent align="start" sideOffset={8} className="w-[28rem] p-0">
        <Command shouldFilter={false} className="rounded-lg border-0 bg-transparent p-0">
          <div className="border-b border-border/70 px-3 py-2">
            <div className="text-sm font-medium">Insert Icon</div>
            <div className="text-xs text-muted-foreground">
              Search Nerd Font icons and insert the raw glyph into the note.
            </div>
          </div>
          <CommandInput
            value={query}
            onValueChange={(value) => {
              startTransition(() => setQuery(value));
            }}
            autoFocus
            placeholder="Search icons by name, id, or category..."
          />
          <CommandList className="max-h-[26rem]">
            <CommandEmpty>No icons found.</CommandEmpty>
            {groupedEntries.map(([categoryLabel, entries]) => (
              <CommandGroup key={categoryLabel} heading={categoryLabel}>
                {entries.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => handleInsert(entry.glyph)}
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
                      <span className="block truncate text-xs text-muted-foreground">{entry.id}</span>
                    </span>
                    <CommandShortcut className="tracking-normal">{formatNerdFontHexCode(entry.hexCode)}</CommandShortcut>
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
      </PopoverContent>
    </Popover>
  );
}
