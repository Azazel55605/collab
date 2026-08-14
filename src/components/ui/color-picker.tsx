import * as React from 'react';
import { Check, Pipette } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from './button';
import { Input } from './input';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

const DEFAULT_COLORS = [
  '#ffffff', '#e5e7eb', '#94a3b8', '#1f2933',
  '#7c3aed', '#2563eb', '#0e7490', '#1a7f37',
  '#b7791f', '#ea580c', '#c0392b', '#be185d',
];

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

interface ColorPickerProps {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  colors?: string[];
  className?: string;
}

function ColorPicker({
  value,
  onValueChange,
  disabled = false,
  label,
  colors = DEFAULT_COLORS,
  className,
}: ColorPickerProps) {
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => setDraft(value), [value]);

  const commitDraft = () => {
    const normalized = draft.trim();
    if (HEX_COLOR.test(normalized)) onValueChange(normalized);
    else setDraft(value);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={label}
          className={cn('h-8 justify-start gap-2 px-2', className)}
        >
          <span
            aria-hidden
            className="size-4 rounded-sm border border-foreground/20 shadow-inner"
            style={{ backgroundColor: value }}
          />
          <span className="font-mono text-[10px] uppercase text-muted-foreground">{value}</span>
          <Pipette className="ml-auto size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56">
        <div className="grid grid-cols-6 gap-1.5" role="radiogroup" aria-label={`${label} palette`}>
          {colors.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={color.toLowerCase() === value.toLowerCase()}
              aria-label={`${label} ${color}`}
              onClick={() => onValueChange(color)}
              className="relative size-7 rounded-md border border-foreground/15 shadow-sm outline-none transition-transform app-motion-fast hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring"
              style={{ backgroundColor: color }}
            >
              {color.toLowerCase() === value.toLowerCase() ? (
                <Check className="absolute inset-0 m-auto size-4 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]" />
              ) : null}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={draft}
            aria-label={`${label} hex`}
            spellCheck={false}
            className="h-8 font-mono text-xs"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitDraft();
              }
            }}
          />
          <Button type="button" size="sm" variant="secondary" onClick={commitDraft}>Apply</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export { ColorPicker };
