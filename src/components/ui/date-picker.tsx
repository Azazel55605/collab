import { useState } from 'react';

import { CalendarDays, X } from 'lucide-react';

import { cn } from '../../lib/utils';
import { formatDate, useUiStore } from '../../store/uiStore';

import { Button } from './button';
import { DatePanel } from './date-panel';
import { Popover, PopoverTrigger } from './popover';
import { PopoverPanel } from './popover-patterns';

type Props = {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  min?: string;
  className?: string;
  /** Adds "No date" and an × on the field. */
  clearable?: boolean;
  placeholder?: string;
  /** Accessible name when there is no visible label. */
  ariaLabel?: string;
};

function parseDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return new Date(`${value}T12:00:00`);
}

export function DatePicker({
  value,
  onChange,
  label,
  min,
  className,
  clearable,
  placeholder = 'Pick a date',
  ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const dateFormat = useUiStore((state) => state.dateFormat);
  const selected = parseDate(value);
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && <span className="text-[12.5px] font-medium text-foreground/85">{label}</span>}
      <Popover open={open} onOpenChange={setOpen}>
        <div className="relative">
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              aria-label={ariaLabel ?? label}
              className={cn(
                'w-full justify-start gap-2 font-normal',
                clearable && selected && 'pr-8',
              )}
            >
              <CalendarDays className="size-3.5 text-muted-foreground" />
              {selected ? (
                formatDate(selected, dateFormat)
              ) : (
                <span className="text-muted-foreground">{placeholder}</span>
              )}
            </Button>
          </PopoverTrigger>
          {clearable && selected && (
            <button
              type="button"
              aria-label={`Clear ${(ariaLabel ?? label ?? 'date').toLowerCase()}`}
              onClick={() => onChange('')}
              className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        <PopoverPanel align="start" className="w-auto" sideOffset={4}>
          <DatePanel
            value={value}
            min={min}
            clearable={clearable}
            onChange={(next) => {
              onChange(next);
              setOpen(false);
            }}
          />
        </PopoverPanel>
      </Popover>
    </div>
  );
}
