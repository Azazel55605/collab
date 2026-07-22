import { Check } from 'lucide-react';

import {
  DATE_FORMAT_OPTIONS,
  formatDate,
  type DateFormat,
  type WeekStart,
  type TimeFormat,
} from '../../store/uiStore';
import { cn } from '../../lib/utils';
import { Separator } from '../ui/separator';
import { SectionLabel } from './settingsControls';

type Props = {
  dateFormat: DateFormat;
  setDateFormat: (format: DateFormat) => void;
  weekStart: WeekStart;
  setWeekStart: (weekStart: WeekStart) => void;
  timeFormat: TimeFormat;
  setTimeFormat: (format: TimeFormat) => void;
};

export default function SettingsCalendarSection({
  dateFormat,
  setDateFormat,
  weekStart,
  setWeekStart,
  timeFormat,
  setTimeFormat,
}: Props) {
  return (
    <div>
      <SectionLabel>Date Format</SectionLabel>
      <p className="text-xs text-muted-foreground mb-3">
        How dates are displayed across the app.
      </p>
      <div className="space-y-1.5 mb-5">
        {(Object.entries(DATE_FORMAT_OPTIONS) as [DateFormat, typeof DATE_FORMAT_OPTIONS[DateFormat]][]).map(
          ([key, value]) => (
            <button
              key={key}
              onClick={() => setDateFormat(key)}
              className={cn(
                'w-full flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition-all app-motion-fast',
                dateFormat === key
                  ? 'border-primary/45 bg-primary/8 shadow-sm shadow-primary/10'
                  : 'border-border/40 bg-card/25 hover:border-border hover:bg-accent/25',
              )}
            >
              <div>
                <p className="text-sm font-medium font-mono">{value.label}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{value.description}</p>
              </div>
              {dateFormat === key && <Check size={14} className="text-primary shrink-0 ml-2" />}
            </button>
          ),
        )}
      </div>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Time Format</SectionLabel>
      <p className="text-xs text-muted-foreground mb-3">
        Controls time labels and calendar time inputs.
      </p>
      <div className="grid grid-cols-3 gap-2">
        {([
          ['system', 'System'],
          ['12-hour', '12 hour'],
          ['24-hour', '24 hour'],
        ] as Array<[TimeFormat, string]>).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTimeFormat(value)}
            className={cn(
              'rounded-xl border py-2.5 text-sm font-medium transition-all app-motion-fast',
              timeFormat === value
                ? 'border-primary/45 bg-primary/8 text-primary shadow-sm shadow-primary/10'
                : 'border-border/40 bg-card/25 text-muted-foreground hover:border-border hover:bg-accent/25 hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>First Day of Week</SectionLabel>
      <p className="text-xs text-muted-foreground mb-3">
        Sets the starting column in the calendar view.
      </p>
      <div className="flex gap-2">
        {([1, 0] as WeekStart[]).map((day) => (
          <button
            key={day}
            onClick={() => setWeekStart(day)}
            className={cn(
              'flex-1 rounded-xl border py-2.5 text-sm font-medium transition-all app-motion-fast',
              weekStart === day
                ? 'border-primary/45 bg-primary/8 text-primary shadow-sm shadow-primary/10'
                : 'border-border/40 bg-card/25 text-muted-foreground hover:border-border hover:bg-accent/25 hover:text-foreground',
            )}
          >
            {day === 1 ? 'Monday' : 'Sunday'}
          </button>
        ))}
      </div>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Preview</SectionLabel>
      <div className="rounded-xl border border-border/40 bg-card/25 p-3 text-sm text-muted-foreground">
        <p>Today: <span className="text-foreground font-medium">{formatDate(new Date(), dateFormat)}</span></p>
        <p className="mt-1.5">Week starts on: <span className="text-foreground font-medium">{weekStart === 1 ? 'Monday' : 'Sunday'}</span></p>
        <p className="mt-1.5">Time format: <span className="text-foreground font-medium">{timeFormat === 'system' ? 'System default' : timeFormat}</span></p>
      </div>
    </div>
  );
}
