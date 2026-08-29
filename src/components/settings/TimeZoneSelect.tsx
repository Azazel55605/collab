import { useMemo, useState } from 'react';

import { ChevronsUpDown, Clock3 } from 'lucide-react';

import { systemTimeZone } from '../../store/uiStore';
import { Button } from '../ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

const FALLBACK_TIME_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Helsinki',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

type IntlWithSupportedValues = typeof Intl & {
  supportedValuesOf?: (key: 'timeZone') => string[];
};

export function supportedTimeZones(): string[] {
  const detected = systemTimeZone();
  const runtimeZones = (Intl as IntlWithSupportedValues).supportedValuesOf?.('timeZone');
  return Array.from(new Set([detected, 'UTC', ...(runtimeZones ?? FALLBACK_TIME_ZONES)])).sort();
}

function currentTimeInZone(timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date());
}

export default function TimeZoneSelect({
  value,
  onValueChange,
}: {
  value: string;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const zones = useMemo(supportedTimeZones, []);
  const systemZone = systemTimeZone();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Default calendar time zone"
          className="w-full justify-between font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Clock3 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{value}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command>
          <CommandInput placeholder="Search time zones..." />
          <CommandList
            className="h-72 max-h-72 touch-pan-y overscroll-contain overflow-y-scroll [scrollbar-gutter:stable] [scrollbar-width:thin]"
            onWheelCapture={(event) => event.stopPropagation()}
            onTouchMove={(event) => event.stopPropagation()}
          >
            <CommandEmpty>No matching time zone</CommandEmpty>
            <CommandGroup>
              {zones.map((zone) => (
                <CommandItem
                  key={zone}
                  value={`${zone} ${zone.replace(/_/g, ' ')}`}
                  data-checked={zone === value}
                  onSelect={() => {
                    onValueChange(zone);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{zone}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {zone === systemZone ? 'System time zone · ' : ''}
                      {currentTimeInZone(zone)}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
