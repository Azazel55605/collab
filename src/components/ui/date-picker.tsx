import { format } from 'date-fns';
import { CalendarDays } from 'lucide-react';
import { useState } from 'react';
import { formatDate, useUiStore } from '../../store/uiStore';
import { Button } from './button';
import { Calendar } from './calendar';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { cn } from '../../lib/utils';

type Props = {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  min?: string;
  className?: string;
};

function parseDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return new Date(`${value}T12:00:00`);
}

export function DatePicker({ value, onChange, label, min, className }: Props) {
  const [open, setOpen] = useState(false);
  const dateFormat = useUiStore((state) => state.dateFormat);
  const selected = parseDate(value);
  const minimum = parseDate(min ?? '');
  return (
    <div className={cn('space-y-1', className)}>
      {label && <span className="text-xs font-medium">{label}</span>}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="w-full justify-start gap-2 font-normal">
            <CalendarDays className="size-3.5 text-muted-foreground" />
            {selected ? formatDate(selected, dateFormat) : <span className="text-muted-foreground">Pick a date</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0" sideOffset={4}>
          <Calendar
            mode="single"
            selected={selected}
            disabled={minimum ? { before: minimum } : undefined}
            onSelect={(date) => {
              if (!date) return;
              onChange(format(date, 'yyyy-MM-dd'));
              setOpen(false);
            }}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
