import { type ReactNode, useState } from 'react';

import { addDays, format, nextMonday } from 'date-fns';
import { Clock } from 'lucide-react';

import { cn } from '@/lib/utils';

import { Button } from './button';
import { Calendar } from './calendar';
import { PopoverPanelFooter } from './popover-patterns';

/*
 * Pop-over pattern B. Kept apart from popover-patterns.tsx: the calendar and
 * date-fns are large, and the other patterns are used by views that load at
 * startup.
 */

// ─── B · date ─────────────────────────────────────────────────────────────────

function parseDateKey(value: string | undefined): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return new Date(`${value}T12:00:00`);
}

const dateKey = (date: Date) => format(date, 'yyyy-MM-dd');

export interface DatePanelProps {
  /** yyyy-MM-dd or empty. */
  value: string;
  /** Called with yyyy-MM-dd, or '' when cleared. */
  onChange: (value: string) => void;
  min?: string;
  /** Today / Tomorrow / Next Mon / In 1 week above the month (default on). */
  quickPicks?: boolean;
  /** Shows "No date" in the footer. */
  clearable?: boolean;
  /** An optional time (HH:mm) in the footer. */
  time?: { value: string; onChange: (value: string) => void };
  /** Replaces the footer's left side (e.g. "Today" for jump-to). */
  footerStart?: ReactNode;
  /** Shown on the right of the footer when there is no time field ("Week 47"). */
  footerMeta?: ReactNode;
  /** Range to tint in the month, e.g. the visible week. */
  highlight?: { from: Date; to: Date };
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * Template B — the one date pop-over body. Quick picks first (the common case
 * is "tomorrow"), then the month; today is outlined and the value filled.
 */
export function DatePanel({
  value,
  onChange,
  min,
  quickPicks = true,
  clearable,
  time,
  footerStart,
  footerMeta,
  highlight,
  weekStartsOn,
}: DatePanelProps) {
  const selected = parseDateKey(value);
  const minimum = parseDateKey(min);
  const today = new Date();
  const picks: [string, Date][] = [
    ['Today', today],
    ['Tomorrow', addDays(today, 1)],
    ['Next Mon', nextMonday(today)],
    ['In 1 week', addDays(today, 7)],
  ];
  const [month, setMonth] = useState<Date>(selected ?? today);
  const showFooter = clearable || time || footerStart || footerMeta;
  return (
    // The month sets the width; quick picks and the footer wrap inside it
    // (w-0 min-w-full keeps them out of the intrinsic width).
    <div className="flex w-fit flex-col">
      {quickPicks && (
        <div
          className="flex w-0 min-w-full flex-wrap gap-1.5 px-3 pt-2.5 pb-1"
          role="group"
          aria-label="Quick picks"
        >
          {picks.map(([label, date]) => {
            const key = dateKey(date);
            const disabled = minimum ? date < minimum && key !== min : false;
            return (
              <button
                key={label}
                type="button"
                disabled={disabled}
                aria-pressed={value === key}
                onClick={() => onChange(key)}
                className={cn(
                  'h-6 rounded-full px-2.5 text-[11.5px] transition-colors disabled:opacity-40',
                  value === key
                    ? 'bg-primary/15 font-medium text-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
      <Calendar
        mode="single"
        selected={selected}
        month={month}
        onMonthChange={setMonth}
        disabled={minimum ? { before: minimum } : undefined}
        modifiers={highlight ? { highlighted: highlight } : undefined}
        modifiersClassNames={highlight ? { highlighted: 'bg-primary/10 rounded-md' } : undefined}
        onSelect={(date) => date && onChange(dateKey(date))}
        weekStartsOn={weekStartsOn}
        autoFocus
      />
      {showFooter && (
        <PopoverPanelFooter
          className="w-0 min-w-full"
          start={
            footerStart ??
            (clearable ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!value}
                onClick={() => onChange('')}
              >
                No date
              </Button>
            ) : undefined)
          }
        >
          {time ? (
            <label className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[12px]">
              <Clock className="size-3 text-muted-foreground" />
              <input
                type="time"
                aria-label="Time"
                value={time.value}
                onChange={(event) => time.onChange(event.target.value)}
                className="w-[5.5rem] bg-transparent outline-none"
              />
            </label>
          ) : (
            footerMeta && <span className="text-[11.5px] text-muted-foreground">{footerMeta}</span>
          )}
        </PopoverPanelFooter>
      )}
    </div>
  );
}
