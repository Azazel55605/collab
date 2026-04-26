import { Check } from 'lucide-react';

import {
  DATE_FORMAT_OPTIONS,
  formatDate,
  type DateFormat,
  type WeekStart,
} from '../../store/uiStore';
import { cn } from '../../lib/utils';
import { Separator } from '../ui/separator';
import { SectionLabel } from './settingsControls';

type Props = {
  dateFormat: DateFormat;
  setDateFormat: (format: DateFormat) => void;
  weekStart: WeekStart;
  setWeekStart: (weekStart: WeekStart) => void;
};

export default function SettingsCalendarSection({
  dateFormat,
  setDateFormat,
  weekStart,
  setWeekStart,
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
                'w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-left transition-all',
                dateFormat === key
                  ? 'border-primary/50 bg-primary/8'
                  : 'border-border/40 hover:border-border hover:bg-accent/30',
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
              'flex-1 py-2.5 rounded-lg border text-sm font-medium transition-all',
              weekStart === day
                ? 'border-primary/50 bg-primary/8 text-primary'
                : 'border-border/40 hover:border-border hover:bg-accent/30 text-muted-foreground hover:text-foreground',
            )}
          >
            {day === 1 ? 'Monday' : 'Sunday'}
          </button>
        ))}
      </div>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Preview</SectionLabel>
      <div className="rounded-lg border border-border/40 bg-accent/10 p-3 text-sm text-muted-foreground">
        <p>Today: <span className="text-foreground font-medium">{formatDate(new Date(), dateFormat)}</span></p>
        <p className="mt-1.5">Week starts on: <span className="text-foreground font-medium">{weekStart === 1 ? 'Monday' : 'Sunday'}</span></p>
      </div>
    </div>
  );
}
