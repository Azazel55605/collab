import { type ReactNode, useMemo, useState } from 'react';

import { Search } from 'lucide-react';

import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

import { EMOJI_CATEGORIES } from './emojiData';

/** Popover emoji grid with keyword search; the trigger is the child element. */
export function EmojiPicker({
  children,
  onPick,
  label = 'Emoji',
  side = 'top',
  align = 'end',
  open,
  onOpenChange,
}: {
  children: ReactNode;
  onPick: (emoji: string) => void;
  label?: string;
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState(EMOJI_CATEGORIES[0].id);
  const terms = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      terms
        ? EMOJI_CATEGORIES.flatMap((group) => group.emojis).filter(([, keywords]) =>
            keywords.includes(terms),
          )
        : (EMOJI_CATEGORIES.find((group) => group.id === category) ?? EMOJI_CATEGORIES[0]).emojis,
    [terms, category],
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange?.(next);
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className="conversation-emoji-panel"
        aria-label={label}
        onOpenAutoFocus={(event) => {
          // Touch keyboards would cover the grid; desktop gets search focus.
          if (window.matchMedia('(pointer: coarse)').matches) event.preventDefault();
        }}
      >
        <label className="conversation-emoji-search">
          <Search size={15} aria-hidden="true" />
          <Input
            value={query}
            maxLength={40}
            placeholder="Search emoji"
            aria-label="Search emoji"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {!terms && (
          <div className="conversation-emoji-tabs" role="tablist" aria-label="Emoji categories">
            {EMOJI_CATEGORIES.map((group) => (
              <Button
                key={group.id}
                type="button"
                variant="ghost"
                role="tab"
                aria-selected={group.id === category}
                aria-label={group.label}
                title={group.label}
                onClick={() => setCategory(group.id)}
              >
                {group.emojis[0][0]}
              </Button>
            ))}
          </div>
        )}
        <div className="conversation-emoji-grid" role="listbox" aria-label={label}>
          {shown.map(([emoji, keywords]) => (
            <Button
              key={emoji}
              type="button"
              variant="ghost"
              role="option"
              aria-selected={false}
              aria-label={keywords.split(' ')[0]}
              title={keywords.split(' ')[0]}
              onClick={() => onPick(emoji)}
            >
              {emoji}
            </Button>
          ))}
          {!shown.length && <p>No emoji found.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
