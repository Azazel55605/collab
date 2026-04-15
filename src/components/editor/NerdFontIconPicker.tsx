import { useMemo, useState } from 'react';
import mappings from '../../generated/nerd-font-mappings.json';
import { Shapes } from 'lucide-react';
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

interface NerdFontIconEntry {
  id: string;
  glyph: string;
  hexCode: number;
  categoryKey: string;
  categoryLabel: string;
  nameLabel: string;
  searchText: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  cod: 'VS Code',
  custom: 'Custom',
  dev: 'Devicons',
  fa: 'Font Awesome',
  fae: 'Font Awesome Extension',
  iec: 'IEC Power',
  indent: 'Indent',
  linux: 'Linux',
  md: 'Material Design',
  oct: 'Octicons',
  pl: 'Powerline',
  ple: 'Powerline Extra',
  pom: 'Pomicons',
  seti: 'Seti',
  weather: 'Weather',
};

function titleCaseToken(token: string) {
  return token
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildCategoryLabel(categoryKey: string) {
  return CATEGORY_LABELS[categoryKey] ?? titleCaseToken(categoryKey);
}

function buildNameLabel(id: string) {
  const [, , ...nameTokens] = id.split('-');
  return titleCaseToken(nameTokens.join(' '));
}

function buildSearchText(id: string, categoryLabel: string, nameLabel: string) {
  return `${id} ${categoryLabel} ${nameLabel} ${id.replace(/[-_]/g, ' ')}`.toLowerCase();
}

function scoreEntry(entry: NerdFontIconEntry, query: string) {
  const exactName = entry.nameLabel.toLowerCase();
  const exactId = entry.id.toLowerCase();
  const category = entry.categoryLabel.toLowerCase();

  if (exactId === query || exactName === query) return 0;
  if (exactName.startsWith(query)) return 1;
  if (exactId.startsWith(query)) return 2;
  if (category.startsWith(query)) return 3;

  const nameWordIndex = exactName.split(/\s+/).findIndex((word) => word.startsWith(query));
  if (nameWordIndex >= 0) return 4 + nameWordIndex;

  if (entry.searchText.includes(query)) return 12;
  return null;
}

const NERD_FONT_ICONS: NerdFontIconEntry[] = (Object.entries(mappings) as [string, number][])
  .map(([id, hexCode]) => {
    const [, categoryKey = 'custom'] = id.split('-');
    const categoryLabel = buildCategoryLabel(categoryKey);
    const nameLabel = buildNameLabel(id);
    return {
      id,
      glyph: String.fromCodePoint(hexCode),
      hexCode,
      categoryKey,
      categoryLabel,
      nameLabel,
      searchText: buildSearchText(id, categoryLabel, nameLabel),
    };
  })
  .sort((left, right) => (
    left.categoryLabel.localeCompare(right.categoryLabel) ||
    left.nameLabel.localeCompare(right.nameLabel) ||
    left.id.localeCompare(right.id)
  ));

function formatHexCode(hexCode: number) {
  return `U+${hexCode.toString(16).toUpperCase()}`;
}

function groupEntries(entries: NerdFontIconEntry[]) {
  const grouped = new Map<string, NerdFontIconEntry[]>();
  for (const entry of entries) {
    const current = grouped.get(entry.categoryLabel);
    if (current) {
      current.push(entry);
    } else {
      grouped.set(entry.categoryLabel, [entry]);
    }
  }
  return Array.from(grouped.entries());
}

export function NerdFontIconPicker({ onInsert }: NerdFontIconPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return NERD_FONT_ICONS.slice(0, 240);

    return NERD_FONT_ICONS
      .map((entry) => ({ entry, score: scoreEntry(entry, normalizedQuery) }))
      .filter((result): result is { entry: NerdFontIconEntry; score: number } => result.score != null)
      .sort((left, right) => (
        left.score - right.score ||
        left.entry.categoryLabel.localeCompare(right.entry.categoryLabel) ||
        left.entry.nameLabel.localeCompare(right.entry.nameLabel) ||
        left.entry.id.localeCompare(right.entry.id)
      ))
      .slice(0, 240)
      .map((result) => result.entry);
  }, [query]);

  const groupedEntries = useMemo(() => groupEntries(filteredEntries), [filteredEntries]);

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
        <TooltipContent side="bottom">Insert Nerd Font icon</TooltipContent>
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
            onValueChange={setQuery}
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
                    <CommandShortcut className="tracking-normal">{formatHexCode(entry.hexCode)}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            <div className="border-t border-border/70 px-3 py-2 text-[11px] text-muted-foreground">
              Showing {filteredEntries.length} icon{filteredEntries.length === 1 ? '' : 's'}
              {query.trim() ? ' for this search' : ' from the bundled catalog'}.
            </div>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
