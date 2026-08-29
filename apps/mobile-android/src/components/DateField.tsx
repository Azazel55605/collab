import { useEffect, useMemo, useState } from 'react';

import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

/** Parse a `YYYY-MM-DD` value into a local noon Date (avoids TZ off-by-one). */
function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function formatDisplay(value: string | undefined): string | null {
  const date = parseDate(value);
  if (!date) return null;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * A touch-friendly date control that matches the app's sheet/visual language
 * instead of the platform `<input type="date">` chrome. Value is a
 * `YYYY-MM-DD` string (or undefined when cleared).
 */
export function DateField({
  value,
  onChange,
  readOnly = false,
  min,
  max,
  placeholder = 'Set date',
}: {
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  readOnly?: boolean;
  min?: string;
  max?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const display = formatDisplay(value);

  return (
    <>
      <button
        type="button"
        className={`date-field ${display ? 'has-value' : ''}`}
        disabled={readOnly}
        onClick={() => setOpen(true)}
      >
        <CalendarDays size={16} aria-hidden />
        <span className="date-field-text">{display ?? placeholder}</span>
        {display && !readOnly ? (
          <span
            className="date-field-clear"
            role="button"
            aria-label="Clear date"
            onClick={(event) => {
              event.stopPropagation();
              onChange(undefined);
            }}
          >
            <X size={14} aria-hidden />
          </span>
        ) : null}
      </button>
      {open ? (
        <CalendarSheet
          value={value}
          min={min}
          max={max}
          onClose={() => setOpen(false)}
          onSelect={(next) => {
            onChange(next);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function CalendarSheet({
  value,
  min,
  max,
  onClose,
  onSelect,
}: {
  value: string | undefined;
  min?: string;
  max?: string;
  onClose: () => void;
  onSelect: (next: string | undefined) => void;
}) {
  const initial = parseDate(value) ?? new Date();
  const [view, setView] = useState({ year: initial.getFullYear(), month: initial.getMonth() });
  const todayStr = toDateStr(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  // Close on Escape for keyboard/emulator ergonomics.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const grid = useMemo(() => {
    const firstWeekday = new Date(view.year, view.month, 1).getDay();
    const daysInMonth = new Date(view.year, view.month + 1, 0).getDate();
    const cells: Array<{ day: number; str: string } | null> = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      cells.push({ day, str: toDateStr(view.year, view.month, day) });
    }
    return cells;
  }, [view]);

  const monthLabel = new Date(view.year, view.month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  const step = (delta: number) => {
    setView((prev) => {
      const next = new Date(prev.year, prev.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  const disabled = (str: string) => (min ? str < min : false) || (max ? str > max : false);

  return (
    <div className="sheet-backdrop calendar-backdrop" onClick={onClose}>
      <div
        className="sheet calendar-sheet"
        role="dialog"
        aria-label="Choose a date"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-handle" />
        <div className="calendar-head">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous month"
            onClick={() => step(-1)}
          >
            <ChevronLeft size={18} aria-hidden />
          </button>
          <strong>{monthLabel}</strong>
          <button
            type="button"
            className="icon-button"
            aria-label="Next month"
            onClick={() => step(1)}
          >
            <ChevronRight size={18} aria-hidden />
          </button>
        </div>
        <div className="calendar-weekdays">
          {WEEKDAYS.map((weekday) => (
            <span key={weekday}>{weekday}</span>
          ))}
        </div>
        <div className="calendar-grid">
          {grid.map((cell, index) =>
            cell ? (
              <button
                key={cell.str}
                type="button"
                className={`calendar-day ${cell.str === value ? 'selected' : ''} ${
                  cell.str === todayStr ? 'today' : ''
                }`}
                disabled={disabled(cell.str)}
                onClick={() => onSelect(cell.str)}
              >
                {cell.day}
              </button>
            ) : (
              <span key={`blank-${index}`} className="calendar-blank" />
            ),
          )}
        </div>
        <div className="calendar-actions">
          <button type="button" className="text-button" onClick={() => onSelect(undefined)}>
            Clear
          </button>
          <button
            type="button"
            className="text-button"
            disabled={disabled(todayStr)}
            onClick={() => onSelect(todayStr)}
          >
            Today
          </button>
        </div>
      </div>
    </div>
  );
}
