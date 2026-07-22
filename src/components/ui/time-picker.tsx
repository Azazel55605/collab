import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Clock3 } from 'lucide-react';
import { formatTime, type TimeFormat } from '../../store/uiStore';
import { Button } from './button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { Input } from './input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

type Props = {
  value: string;
  onChange: (value: string) => void;
  format: TimeFormat;
  label?: string;
};

function usesTwelveHourClock(format: TimeFormat): boolean {
  if (format === '12-hour') return true;
  if (format === '24-hour') return false;
  const options = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions() as Intl.ResolvedDateTimeFormatOptions & { hour12?: boolean };
  return options.hour12 === true;
}

function displayTime(value: string, format: TimeFormat): string {
  const [hour, minute] = value.split(':').map(Number);
  const date = new Date(2026, 0, 1, hour, minute);
  return formatTime(date, format);
}

export function addMinutesToTime(value: string, minutes: number): { time: string; dayOffset: number } {
  const [hour, minute] = value.split(':').map(Number);
  const total = hour * 60 + minute + minutes;
  const dayOffset = Math.floor(total / (24 * 60));
  const withinDay = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  return {
    time: `${String(Math.floor(withinDay / 60)).padStart(2, '0')}:${String(withinDay % 60).padStart(2, '0')}`,
    dayOffset,
  };
}

export function TimePicker({ value, onChange, format, label }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const twelveHour = usesTwelveHourClock(format);
  const [rawHour, rawMinute] = draft.split(':').map(Number);
  const period = rawHour >= 12 ? 'PM' : 'AM';
  const displayHour = twelveHour ? String(rawHour % 12 || 12) : String(rawHour).padStart(2, '0');
  useEffect(() => { if (open) setDraft(value); }, [open, value]);

  const setHour = (hour: number) => {
    let next = Math.trunc(hour);
    next = twelveHour ? Math.max(1, Math.min(12, next)) : Math.max(0, Math.min(23, next));
    if (twelveHour) next = (next % 12) + (period === 'PM' ? 12 : 0);
    setDraft(`${String(next).padStart(2, '0')}:${String(rawMinute).padStart(2, '0')}`);
  };
  const setPeriod = (nextPeriod: string) => {
    const hour = rawHour % 12 + (nextPeriod === 'PM' ? 12 : 0);
    setDraft(`${String(hour).padStart(2, '0')}:${String(rawMinute).padStart(2, '0')}`);
  };
  const setMinute = (minute: number) => {
    const next = Math.max(0, Math.min(59, Math.trunc(minute)));
    setDraft(`${String(rawHour).padStart(2, '0')}:${String(next).padStart(2, '0')}`);
  };
  const adjustMinutes = (delta: number) => {
    const total = (rawHour * 60 + rawMinute + delta + 24 * 60) % (24 * 60);
    setDraft(`${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`);
  };
  const adjustHours = (delta: number) => {
    const hour = (rawHour + delta + 24) % 24;
    setDraft(`${String(hour).padStart(2, '0')}:${String(rawMinute).padStart(2, '0')}`);
  };

  return (
    <div className="space-y-1">
      {label && <span className="text-xs font-medium">{label}</span>}
      <Button type="button" variant="outline" className="w-full justify-start gap-2 font-normal" onClick={() => setOpen(true)}>
        <Clock3 className="size-3.5 text-muted-foreground" />
        {displayTime(value, format)}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{label ?? 'Choose time'}</DialogTitle></DialogHeader>
          <div className="flex items-center justify-center gap-2 py-4">
            <TimeNumberField
              label="Hour"
              value={Number(displayHour)}
              min={twelveHour ? 1 : 0}
              max={twelveHour ? 12 : 23}
              onChange={setHour}
              onIncrease={() => adjustHours(1)}
              onDecrease={() => adjustHours(-1)}
            />
            <span className="text-xl font-semibold text-muted-foreground">:</span>
            <TimeNumberField
              label="Minute"
              value={rawMinute}
              min={0}
              max={59}
              onChange={setMinute}
              onIncrease={() => adjustMinutes(5)}
              onDecrease={() => adjustMinutes(-5)}
              increaseLabel="Add five minutes"
              decreaseLabel="Subtract five minutes"
            />
            {twelveHour && <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger aria-label="Period" className="w-24 text-lg"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-64"><SelectItem value="AM">AM</SelectItem><SelectItem value="PM">PM</SelectItem></SelectContent>
            </Select>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" onClick={() => { onChange(draft); setOpen(false); }}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TimeNumberField({
  label,
  value,
  min,
  max,
  onChange,
  onIncrease,
  onDecrease,
  increaseLabel = `Increase ${label.toLowerCase()}`,
  decreaseLabel = `Decrease ${label.toLowerCase()}`,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onIncrease: () => void;
  onDecrease: () => void;
  increaseLabel?: string;
  decreaseLabel?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    if (text.trim() === '') {
      setText(String(value));
      return;
    }
    const next = Math.max(min, Math.min(max, Math.trunc(Number(text) || 0)));
    onChange(next);
    setText(String(next));
  };
  return (
    <div className="flex h-8 w-24 overflow-hidden rounded-lg border border-input bg-background dark:bg-input/30">
      <Input
        aria-label={label}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          if (!/^\d{0,2}$/.test(next)) return;
          setText(next);
          if (next !== '' && Number(next) >= min && Number(next) <= max) onChange(Number(next));
        }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
        className="h-full rounded-none border-0 bg-transparent px-2 text-center text-lg shadow-none [appearance:textfield] focus-visible:ring-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <div className="grid w-7 shrink-0 grid-rows-2 border-l border-input">
        <Button type="button" variant="ghost" aria-label={increaseLabel} onClick={onIncrease} className="h-4 min-h-0 w-7 rounded-none p-0"><ChevronUp className="size-3" /></Button>
        <Button type="button" variant="ghost" aria-label={decreaseLabel} onClick={onDecrease} className="h-4 min-h-0 w-7 rounded-none border-t border-input p-0"><ChevronDown className="size-3" /></Button>
      </div>
    </div>
  );
}
