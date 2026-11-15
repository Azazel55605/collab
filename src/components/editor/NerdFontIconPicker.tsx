import { startTransition, useDeferredValue, useEffect, useMemo, useState } from 'react';

import { Shapes } from 'lucide-react';

import { EDITOR_TOOLBAR_ACTION_EVENT } from '../../lib/editorToolbarActions';
import { formatNerdFontHexCode, groupNerdFontIcons } from '../../lib/nerdFontIconQuery';
import { useNerdFontIcons } from '../../lib/useNerdFontIcons';
import { Popover, PopoverTrigger } from '../ui/popover';
import {
  KeyHints,
  PickerCommand,
  PickerEmpty,
  PickerGroup,
  PickerInput,
  PickerItem,
  PickerList,
  PopoverPanel,
  PopoverPanelFooter,
  PopoverPanelHeader,
} from '../ui/popover-patterns';
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

  const { entries: filteredEntries, loading, error } = useNerdFontIcons(deferredQuery, 180, open);
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

      <PopoverPanel align="start" sideOffset={8} className="w-[26rem]">
        <PickerCommand shouldFilter={false}>
          <PopoverPanelHeader
            title="Insert icon"
            meta={`${filteredEntries.length} icon${filteredEntries.length === 1 ? '' : 's'}`}
          />
          <PickerInput
            value={query}
            onValueChange={(value) => {
              startTransition(() => setQuery(value));
            }}
            autoFocus
            placeholder="Search icons by name, id or category"
          />
          <PickerList className="max-h-[24rem]">
            <PickerEmpty>
              {error
                ? 'Could not load icons. Reopen Collab to retry.'
                : loading
                  ? 'Loading icons…'
                  : 'No icons found.'}
            </PickerEmpty>
            {groupedEntries.map(([categoryLabel, entries]) => (
              <PickerGroup key={categoryLabel} heading={categoryLabel}>
                {entries.map((entry) => (
                  <PickerItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => handleInsert(entry.glyph)}
                    icon={
                      <span
                        className="text-[16px] leading-none"
                        style={{ fontFamily: "'Pure Nerd Font', PureNerdFont, monospace" }}
                        aria-hidden="true"
                      >
                        {entry.glyph}
                      </span>
                    }
                    title={entry.nameLabel}
                    detail={entry.id}
                    meta={<span className="font-mono">{formatNerdFontHexCode(entry.hexCode)}</span>}
                  />
                ))}
              </PickerGroup>
            ))}
          </PickerList>
          <PopoverPanelFooter
            start={
              <KeyHints
                hints={[
                  ['↑↓', 'move'],
                  ['↵', 'insert'],
                ]}
              />
            }
          >
            <span className="text-[11.5px] text-muted-foreground">Raw glyph, Nerd Font</span>
          </PopoverPanelFooter>
        </PickerCommand>
      </PopoverPanel>
    </Popover>
  );
}
