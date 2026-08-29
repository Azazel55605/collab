import { Check } from 'lucide-react';

import { cn } from '../../lib/utils';
import {
  type CalendarDefaultDuration,
  DATE_FORMAT_OPTIONS,
  type DateFormat,
  formatDate,
  type TimeFormat,
  type WeekStart,
} from '../../store/uiStore';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Separator } from '../ui/separator';
import { TimePicker } from '../ui/time-picker';

import { OptionRow, SectionLabel, ToggleSwitch } from './settingsControls';
import TimeZoneSelect from './TimeZoneSelect';

type Props = {
  dateFormat: DateFormat;
  setDateFormat: (format: DateFormat) => void;
  weekStart: WeekStart;
  setWeekStart: (weekStart: WeekStart) => void;
  timeFormat: TimeFormat;
  setTimeFormat: (format: TimeFormat) => void;
  defaultTimeZone: string;
  setDefaultTimeZone: (timeZone: string) => void;
  defaultDurationMinutes: CalendarDefaultDuration;
  setDefaultDurationMinutes: (minutes: CalendarDefaultDuration) => void;
  workingHoursStart: string;
  setWorkingHoursStart: (time: string) => void;
  workingHoursEnd: string;
  setWorkingHoursEnd: (time: string) => void;
  defaultReminderMinutes: number | null;
  setDefaultReminderMinutes: (minutes: number | null) => void;
  hideWeekends: boolean;
  setHideWeekends: (hidden: boolean) => void;
  showDeclined: boolean;
  setShowDeclined: (visible: boolean) => void;
};

export default function SettingsCalendarSection({
  dateFormat,
  setDateFormat,
  weekStart,
  setWeekStart,
  timeFormat,
  setTimeFormat,
  defaultTimeZone,
  setDefaultTimeZone,
  defaultDurationMinutes,
  setDefaultDurationMinutes,
  workingHoursStart,
  setWorkingHoursStart,
  workingHoursEnd,
  setWorkingHoursEnd,
  defaultReminderMinutes,
  setDefaultReminderMinutes,
  hideWeekends,
  setHideWeekends,
  showDeclined,
  setShowDeclined,
}: Props) {
  return (
    <div>
      <SectionLabel>Date Format</SectionLabel>
      <p className="text-xs text-muted-foreground mb-3">How dates are displayed across the app.</p>
      <div className="space-y-1.5 mb-5">
        {(
          Object.entries(DATE_FORMAT_OPTIONS) as [
            DateFormat,
            (typeof DATE_FORMAT_OPTIONS)[DateFormat],
          ][]
        ).map(([key, value]) => (
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
        ))}
      </div>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Time Format</SectionLabel>
      <p className="text-xs text-muted-foreground mb-3">
        Controls time labels and calendar time inputs.
      </p>
      <div className="grid grid-cols-3 gap-2">
        {(
          [
            ['system', 'System'],
            ['12-hour', '12 hour'],
            ['24-hour', '24 hour'],
          ] as Array<[TimeFormat, string]>
        ).map(([value, label]) => (
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

      <SectionLabel>Default Time Zone</SectionLabel>
      <p className="text-xs text-muted-foreground mb-3">
        Used when creating calendars. Existing calendars keep their stored time zone.
      </p>
      <TimeZoneSelect value={defaultTimeZone} onValueChange={setDefaultTimeZone} />

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Event Defaults</SectionLabel>
      <OptionRow label="Default duration" description="Length used for new timed events and tasks.">
        <Select
          value={String(defaultDurationMinutes)}
          onValueChange={(value) =>
            setDefaultDurationMinutes(Number(value) as CalendarDefaultDuration)
          }
        >
          <SelectTrigger aria-label="Default event duration" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[15, 30, 45, 60, 90, 120].map((minutes) => (
              <SelectItem key={minutes} value={String(minutes)}>
                {minutes < 60
                  ? `${minutes} minutes`
                  : `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </OptionRow>
      <OptionRow label="Default reminder" description="Applied when a new item is created.">
        <Select
          value={defaultReminderMinutes === null ? 'none' : String(defaultReminderMinutes)}
          onValueChange={(value) =>
            setDefaultReminderMinutes(value === 'none' ? null : Number(value))
          }
        >
          <SelectTrigger aria-label="Default calendar reminder" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No reminder</SelectItem>
            <SelectItem value="0">At start</SelectItem>
            <SelectItem value="10">10 minutes before</SelectItem>
            <SelectItem value="30">30 minutes before</SelectItem>
            <SelectItem value="60">1 hour before</SelectItem>
            <SelectItem value="1440">1 day before</SelectItem>
          </SelectContent>
        </Select>
      </OptionRow>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Working Hours</SectionLabel>
      <p className="text-xs text-muted-foreground mb-3">Week and day views open near this range.</p>
      <div className="grid grid-cols-2 gap-2">
        <TimePicker
          value={workingHoursStart}
          onChange={setWorkingHoursStart}
          format={timeFormat}
          label="Start"
        />
        <TimePicker
          value={workingHoursEnd}
          onChange={setWorkingHoursEnd}
          format={timeFormat}
          label="End"
        />
      </div>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Display</SectionLabel>
      <OptionRow label="Hide weekends" description="Use a five-day month and week layout.">
        <ToggleSwitch checked={hideWeekends} onToggle={() => setHideWeekends(!hideWeekends)} />
      </OptionRow>
      <OptionRow label="Show declined items" description="Keep invitations you declined visible.">
        <ToggleSwitch checked={showDeclined} onToggle={() => setShowDeclined(!showDeclined)} />
      </OptionRow>

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
        <p>
          Today:{' '}
          <span className="text-foreground font-medium">{formatDate(new Date(), dateFormat)}</span>
        </p>
        <p className="mt-1.5">
          Week starts on:{' '}
          <span className="text-foreground font-medium">
            {weekStart === 1 ? 'Monday' : 'Sunday'}
          </span>
        </p>
        <p className="mt-1.5">
          Time format:{' '}
          <span className="text-foreground font-medium">
            {timeFormat === 'system' ? 'System default' : timeFormat}
          </span>
        </p>
        <p className="mt-1.5">
          Default time zone: <span className="text-foreground font-medium">{defaultTimeZone}</span>
        </p>
      </div>
    </div>
  );
}
