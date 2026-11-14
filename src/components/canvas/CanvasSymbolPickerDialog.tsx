import { useDeferredValue, useMemo, useState } from 'react';

import { Shapes } from 'lucide-react';

import { formatNerdFontHexCode, groupNerdFontIcons } from '../../lib/nerdFontIconQuery';
import { useNerdFontIcons } from '../../lib/useNerdFontIcons';
import type { CanvasSymbolDefinition } from '../../types/canvas';
import { PickerDialog } from '../ui/picker-dialog';

export type CanvasSymbolChoice = CanvasSymbolDefinition;

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
  const [selected, setSelected] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);
  const { entries: filteredEntries, loading, error } = useNerdFontIcons(deferredQuery, 180, open);
  const groupedEntries = useMemo(() => groupNerdFontIcons(filteredEntries), [filteredEntries]);

  type Entry = (typeof filteredEntries)[number];
  return (
    <PickerDialog<Entry>
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) setQuery('');
      }}
      icon={<Shapes />}
      title={title}
      description={description}
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search icons by name, id or category"
      layout="grid"
      groups={groupedEntries.map(([label, entries]) => ({ label, items: entries }))}
      getKey={(entry) => entry.id}
      selectedKey={selected}
      onSelect={setSelected}
      renderItem={(entry) => (
        <div className="flex items-center gap-2.5">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted/60 text-[20px] leading-none"
            style={{ fontFamily: "'Pure Nerd Font', PureNerdFont, monospace" }}
            aria-hidden="true"
          >
            {entry.glyph}
          </span>
          <span className="min-w-0 flex-1 leading-snug">
            <span className="block truncate text-[12.5px]">{entry.nameLabel}</span>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">
              {formatNerdFontHexCode(entry.hexCode)}
            </span>
          </span>
        </div>
      )}
      onPick={(entry) =>
        onSelect({ glyph: entry.glyph, iconId: entry.id, iconLabel: entry.nameLabel })
      }
      pickLabel={(entry) => (entry ? `Use ${entry.nameLabel}` : 'Use icon')}
      emptyText={
        error
          ? 'Could not load icons. Reopen Collab to retry.'
          : loading
            ? 'Loading icons…'
            : 'No icons found.'
      }
      secondary={
        <span className="text-xs text-muted-foreground">
          {filteredEntries.length} icon{filteredEntries.length === 1 ? '' : 's'}
          {deferredQuery.trim() ? ' for this search' : ' in the catalog'}
        </span>
      }
    />
  );
}
