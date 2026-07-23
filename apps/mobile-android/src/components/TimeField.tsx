import { ChevronDown, ChevronUp, Clock3, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { CalendarTimeFormat } from '../lib/theme';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parse(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(':').map(Number);
  return { hour: clamp(hour || 0, 0, 23), minute: clamp(minute || 0, 0, 59) };
}

function prefersTwelveHourClock(format: CalendarTimeFormat): boolean {
  if (format !== 'system') return format === '12-hour';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 ?? false;
}

function displayTime(value: string, format: CalendarTimeFormat): string {
  const { hour, minute } = parse(value);
  if (!prefersTwelveHourClock(format)) return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

export function TimeField({ value, onChange, label, format = '24-hour' }: { value: string; onChange: (value: string) => void; label: string; format?: CalendarTimeFormat }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => parse(value));
  const twelveHour = prefersTwelveHourClock(format);
  useEffect(() => {
    if (open) setDraft(parse(value));
  }, [open, value]);
  const update = (part: 'hour' | 'minute', value: number) => {
    setDraft((current) => ({ ...current, [part]: clamp(value, 0, part === 'hour' ? 23 : 59) }));
  };
  const step = (part: 'hour' | 'minute', amount: number) => {
    setDraft((current) => {
      const modulus = part === 'hour' ? 24 : 60;
      return { ...current, [part]: (current[part] + amount + modulus) % modulus };
    });
  };
  return <>
    <button type="button" className="date-field has-value" onClick={() => setOpen(true)}>
      <Clock3 size={16} aria-hidden />
      <span className="date-field-text">{displayTime(value, format)}</span>
    </button>
    {open ? <div className="sheet-backdrop" onClick={() => setOpen(false)}>
      <div className="sheet mobile-time-sheet" role="dialog" aria-label={label} onClick={(event) => event.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-head"><strong>{label}</strong><button type="button" className="icon-button" aria-label="Close time picker" onClick={() => setOpen(false)}><X size={18} /></button></div>
        <div className="mobile-time-fields">
          <TimeNumber
            label="Hour"
            value={twelveHour ? draft.hour % 12 || 12 : draft.hour}
            min={twelveHour ? 1 : 0}
            max={twelveHour ? 12 : 23}
            onChange={value => update('hour', twelveHour ? (value % 12) + (draft.hour >= 12 ? 12 : 0) : value)}
            onStep={amount => step('hour', amount)}
          />
          <span>:</span>
          <TimeNumber label="Minute" value={draft.minute} max={59} onChange={value => update('minute', value)} onStep={amount => step('minute', amount * 5)} />
        </div>
        {twelveHour ? <div className="mobile-time-period" role="group" aria-label="Time period">
          <button type="button" className={draft.hour < 12 ? 'active' : ''} onClick={() => setDraft(current => ({ ...current, hour: current.hour % 12 }))}>AM</button>
          <button type="button" className={draft.hour >= 12 ? 'active' : ''} onClick={() => setDraft(current => ({ ...current, hour: current.hour % 12 + 12 }))}>PM</button>
        </div> : null}
        <div className="form-actions"><button type="button" className="ghost-button" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="primary-button" onClick={() => {
          onChange(`${String(draft.hour).padStart(2, '0')}:${String(draft.minute).padStart(2, '0')}`);
          setOpen(false);
        }}>Apply</button></div>
      </div>
    </div> : null}
  </>;
}

function TimeNumber({ label, value, min = 0, max, onChange, onStep }: {
  label: string; value: number; min?: number; max: number; onChange: (value: number) => void; onStep: (amount: number) => void;
}) {
  return <label><span>{label}</span><div><input aria-label={label} inputMode="numeric" type="number" min={min} max={max} value={value} onChange={event => onChange(Number(event.target.value))} /><aside><button type="button" aria-label={`Increase ${label.toLowerCase()}`} onClick={() => onStep(1)}><ChevronUp size={15} /></button><button type="button" aria-label={`Decrease ${label.toLowerCase()}`} onClick={() => onStep(-1)}><ChevronDown size={15} /></button></aside></div></label>;
}
