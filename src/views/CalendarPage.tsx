import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  ClipboardCheck,
  Ellipsis,
  Gift,
  Bell,
  CheckCircle2,
  LoaderCircle,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  SquareKanban,
  Trash2,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import {
  CalendarAttachmentEditor,
  CalendarAttendeeEditor,
  CalendarInvitations,
} from '../components/calendar/CalendarRelations';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Checkbox } from '../components/ui/checkbox';
import { DatePicker } from '../components/ui/date-picker';
import { addMinutesToTime, TimePicker } from '../components/ui/time-picker';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../components/ui/popover';
import { cn } from '../lib/utils';
import {
  CALENDAR_MINUTES_PER_DAY,
  layoutCalendarTimedItems,
  rescheduleCalendarAllDayItem,
  rescheduleCalendarTimedItem,
  resizeCalendarTimedItem,
  snapCalendarEndMinute,
  snapCalendarMinute,
} from '../lib/calendarTimedLayout';
import type { CalendarRecurrenceEditScope } from '../lib/calendarRecurringEdit';
import { useCalendarStore } from '../store/calendarStore';
import { useCollabStore } from '../store/collabStore';
import { useServerStore } from '../store/serverStore';
import { formatTime, useUiStore } from '../store/uiStore';
import {
  calendarItemRange,
  normalizeCalendarItem,
  type CalendarDefinition,
  type CalendarAttachment,
  type CalendarAttendee,
  type CalendarItem,
  type CalendarItemKind,
  type CalendarLocation,
  type CalendarTaskPriority,
  type CalendarTaskStatus,
} from '../types/calendar';

export type CalendarViewMode = 'month' | 'week' | 'day' | 'agenda' | 'tasks' | 'year';
type EditorRequest = { date: string; kind: CalendarItemKind; item?: CalendarItem; initialTime?: string };
type RescheduleRequest = { item: CalendarItem };
type RecurrencePreset = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';

const DAY_MS = 86_400_000;
const WEEK_HOUR_HEIGHT = 48;
const CALENDAR_TIMED_ITEM_DRAG_TYPE = 'application/x-collab-calendar-timed-item';
const CALENDAR_ALL_DAY_ITEM_DRAG_TYPE = 'application/x-collab-calendar-all-day-item';
const HORIZONTAL_GESTURE_THRESHOLD = 90;
const HORIZONTAL_GESTURE_SETTLE_MS = 180;
const CALENDAR_COLORS = ['#a78bfa', '#60a5fa', '#34d399', '#fb7185', '#fb923c', '#22d3ee'];
const VIEW_MODES: Array<{ value: CalendarViewMode; label: string }> = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'day', label: 'Day' },
  { value: 'agenda', label: 'Agenda' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'year', label: 'Year' },
];
const RECURRENCE_PRESETS: Array<{ value: RecurrencePreset; label: string; rule?: string }> = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Every day', rule: 'FREQ=DAILY' },
  { value: 'weekly', label: 'Every week', rule: 'FREQ=WEEKLY' },
  { value: 'monthly', label: 'Every month', rule: 'FREQ=MONTHLY' },
  { value: 'yearly', label: 'Every year', rule: 'FREQ=YEARLY' },
  { value: 'custom', label: 'Custom' },
];

function recurrencePreset(rule: string | undefined): RecurrencePreset {
  if (!rule) return 'none';
  return RECURRENCE_PRESETS.find((preset) => preset.rule === rule)?.value ?? 'custom';
}

export function calendarDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateFromKey(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

function startOfWeek(date: Date, weekStart: 0 | 1): Date {
  return addDays(date, -((date.getDay() - weekStart + 7) % 7));
}

export function calendarMonthGrid(anchor: Date, weekStart: 0 | 1): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first, weekStart);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function calendarHorizontalGestureDelta(input: {
  deltaX: number;
  deltaY: number;
  deltaMode?: number;
}): number {
  if (Math.abs(input.deltaX) <= Math.abs(input.deltaY) * 1.15) return 0;
  const scale = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? 240 : 1;
  return input.deltaX * scale;
}

function itemOccursOn(item: CalendarItem, day: Date): boolean {
  const key = calendarDateKey(day);
  if (item.kind === 'birthday') return item.date.slice(5) === key.slice(5);
  if (item.kind === 'event' && item.start.kind === 'date' && item.end.kind === 'date') {
    return item.start.date <= key && item.end.date > key;
  }
  const range = calendarItemRange(item);
  if (!range) return false;
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  return range.start < start + DAY_MS && range.end > start;
}

function itemTime(item: CalendarItem): string {
  if (item.kind === 'birthday') return 'Birthday';
  const value = item.kind === 'event' ? item.start : item.due ?? item.start;
  if (!value || value.kind === 'date') return item.kind === 'task' ? 'Task' : 'All day';
  return formatTime(new Date(value.dateTime), useUiStore.getState().timeFormat);
}

function ItemTypeIcon({ item, className }: { item: CalendarItem; className?: string }) {
  if (item.kind === 'birthday') return <Gift role="img" aria-label="Birthday" className={className} />;
  if (item.kind === 'task' && item.sourceBinding?.kind === 'kanban') return <SquareKanban role="img" aria-label="Kanban task" className={className} />;
  if (item.kind === 'task') return <ClipboardCheck role="img" aria-label="Task" className={className} />;
  return <CalendarDays role="img" aria-label="Event" className={className} />;
}

function nextDateKey(value: string): string {
  return calendarDateKey(addDays(dateFromKey(value), 1));
}

function itemDate(item: CalendarItem): string {
  if (item.kind === 'birthday') return item.date;
  const value = item.kind === 'event' ? item.start : item.due ?? item.start;
  if (!value) return calendarDateKey(new Date());
  return value.kind === 'date' ? value.date : calendarDateKey(new Date(value.dateTime));
}

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function DateContextMenu({ children, date, onAdd }: {
  children: React.ReactNode;
  date: string;
  onAdd: (request: EditorRequest) => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onAdd({ date, kind: 'event' })}><CalendarDays /> Add event</ContextMenuItem>
        <ContextMenuItem onSelect={() => onAdd({ date, kind: 'task' })}><ClipboardCheck /> Add task</ContextMenuItem>
        <ContextMenuItem onSelect={() => onAdd({ date, kind: 'birthday' })}><Gift /> Add birthday</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ItemContextMenu({ children, item, onEdit, onDelete }: {
  children: React.ReactNode;
  item: CalendarItem;
  onEdit: (item: CalendarItem) => void;
  onDelete: (item: CalendarItem) => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onEdit(item)}><Pencil /> Edit</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onDelete(item)}><Trash2 /> Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export default function CalendarPage() {
  const profileId = useCollabStore((state) => state.myUserId);
  const weekStart = useUiStore((state) => state.weekStart);
  const timeFormat = useUiStore((state) => state.timeFormat);
  const hideWeekends = useUiStore((state) => state.calendarHideWeekends);
  const showDeclined = useUiStore((state) => state.calendarShowDeclined);
  const serverConnections = useServerStore((state) => state.connections);
  const store = useCalendarStore();
  const [rootRef, rootWidth] = useElementWidth<HTMLDivElement>();
  const [viewMode, setViewMode] = useState<CalendarViewMode>('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => calendarDateKey(new Date()));
  const [editorRequest, setEditorRequest] = useState<EditorRequest | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<CalendarItem | null>(null);
  const [rescheduleRequest, setRescheduleRequest] = useState<RescheduleRequest | null>(null);
  const [calendarDialogOpen, setCalendarDialogOpen] = useState(false);
  const [calendarEditor, setCalendarEditor] = useState<CalendarDefinition | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<CalendarItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [periodTransition, setPeriodTransition] = useState<{ direction: -1 | 1; sequence: number }>({ direction: 1, sequence: 0 });
  const horizontalGestureDelta = useRef(0);
  const horizontalGestureLocked = useRef(false);
  const horizontalGestureReset = useRef<number | null>(null);

  const monthDays = useMemo(() => calendarMonthGrid(anchor, weekStart), [anchor, weekStart]);
  const fullWeekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(anchor, weekStart), index)), [anchor, weekStart]);
  const weekDays = useMemo(
    () => hideWeekends ? fullWeekDays.filter((day) => day.getDay() !== 0 && day.getDay() !== 6) : fullWeekDays,
    [fullWeekDays, hideWeekends],
  );
  const range = useMemo(() => {
    if (viewMode === 'year') return { from: `${anchor.getFullYear()}-01-01`, to: `${anchor.getFullYear() + 1}-01-01` };
    if (viewMode === 'week') return { from: calendarDateKey(fullWeekDays[0]), to: calendarDateKey(addDays(fullWeekDays[6], 1)) };
    if (viewMode === 'day' || viewMode === 'agenda') return { from: selectedDate, to: nextDateKey(selectedDate) };
    return { from: calendarDateKey(monthDays[0]), to: calendarDateKey(addDays(monthDays[41], 1)) };
  }, [anchor, fullWeekDays, monthDays, selectedDate, viewMode]);
  const hostedOrigins = useMemo(() => Object.values(serverConnections).flatMap((connection) => {
    const { status } = connection;
    return status.connected && status.serverUrl && status.user
      ? [{ serverUrl: status.serverUrl, userId: status.user.id }]
      : [];
  }), [serverConnections]);

  useEffect(() => { void store.initialize(profileId); }, [profileId, store.initialize]);
  useEffect(() => {
    if (store.profileId === profileId && store.calendars.length > 0) {
      void store.loadRange(range.from, range.to);
    }
  }, [profileId, range.from, range.to, store.calendars.length, store.loadRange, store.profileId]);
  useEffect(() => {
    if (!searchOpen || searchQuery.trim().length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    let active = true;
    setSearching(true);
    const timeout = window.setTimeout(() => {
      void store.searchItems(searchQuery, 100)
        .then((results) => {
          if (active) setSearchResults(results);
        })
        .catch(() => {
          if (active) setSearchResults([]);
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [searchOpen, searchQuery, store.searchItems]);
  useEffect(() => () => {
    if (horizontalGestureReset.current != null) window.clearTimeout(horizontalGestureReset.current);
  }, []);

  const visibleItems = useMemo(
    () => store.items.filter((item) => (
      store.visibleCalendarIds.includes(item.calendarId)
      && (
        showDeclined
        || !item.attendees.some((attendee) => (
          attendee.kind === 'collabUser'
          && attendee.userId === profileId
          && attendee.response === 'declined'
        ))
      )
    )),
    [profileId, showDeclined, store.items, store.visibleCalendarIds],
  );
  const calendarById = useMemo(() => new Map(store.calendars.map((calendar) => [calendar.id, calendar])), [store.calendars]);
  const editableCalendars = useMemo(
    () => store.calendars.filter((calendar) => !calendar.archived && !calendar.readOnly),
    [store.calendars],
  );
  const calendarLocations = useMemo(() => [
    { value: 'local', label: 'Local profile', location: { kind: 'local' as const, profileId } },
    ...Object.values(serverConnections)
      .filter((connection) => connection.status.connected && connection.status.serverUrl && connection.status.user)
      .map((connection) => ({
        value: `hosted:${connection.status.serverUrl}`,
        label: connection.status.serverUrl!,
        location: {
          kind: 'hosted' as const,
          serverUrl: connection.status.serverUrl!,
          userId: connection.status.user!.id,
        },
      })),
  ], [profileId, serverConnections]);
  const showCalendarRail = rootWidth >= 720;
  const showMonthAgenda = rootWidth >= 1080 && viewMode === 'month';

  const movePeriod = (direction: -1 | 1) => {
    setPeriodTransition((current) => ({ direction, sequence: current.sequence + 1 }));
    if (viewMode === 'month' || viewMode === 'tasks') setAnchor((current) => new Date(current.getFullYear(), current.getMonth() + direction, 1));
    else if (viewMode === 'year') setAnchor((current) => new Date(current.getFullYear() + direction, current.getMonth(), 1));
    else {
      const amount = calendarPeriodDayStep(viewMode);
      setAnchor((current) => addDays(current, direction * amount));
      setSelectedDate((current) => calendarDateKey(addDays(dateFromKey(current), direction * amount)));
    }
  };

  const handleWheel = (event: React.WheelEvent) => {
    if (event.ctrlKey) return;
    const delta = calendarHorizontalGestureDelta(event);
    if (delta === 0) return;
    event.preventDefault();
    if (horizontalGestureReset.current != null) window.clearTimeout(horizontalGestureReset.current);
    horizontalGestureReset.current = window.setTimeout(() => {
      horizontalGestureDelta.current = 0;
      horizontalGestureLocked.current = false;
    }, HORIZONTAL_GESTURE_SETTLE_MS);
    if (horizontalGestureLocked.current) return;
    horizontalGestureDelta.current += delta;
    if (Math.abs(horizontalGestureDelta.current) < HORIZONTAL_GESTURE_THRESHOLD) return;
    const direction = horizontalGestureDelta.current > 0 ? 1 : -1;
    horizontalGestureDelta.current = 0;
    horizontalGestureLocked.current = true;
    movePeriod(direction);
  };

  const openEditor = (request: EditorRequest) => {
    setSelectedDate(request.date);
    setEditorRequest(request);
  };
  const editItem = (item: CalendarItem) => openEditor({ date: itemDate(item), kind: item.kind, item });
  const deleteItem = (item: CalendarItem) => {
    if (item.recurrenceId && item.recurrenceSeriesId) setDeleteRequest(item);
    else void store.deleteItem(item);
  };
  const saveRescheduledItem = (item: CalendarItem, edited: CalendarItem | null) => {
    if (!edited || JSON.stringify(edited) === JSON.stringify(item)) return;
    if (item.recurrenceId && item.recurrenceSeriesId) {
      setRescheduleRequest({ item: edited });
      return;
    }
    void store.saveItem(edited, 'series').catch(() => {});
  };
  const rescheduleItem = (item: CalendarItem, dateKey: string, startMinute: number) => {
    saveRescheduledItem(item, rescheduleCalendarTimedItem(item, dateKey, startMinute));
  };
  const rescheduleAllDayItem = (item: CalendarItem, dateKey: string, sourceDateKey: string) => {
    saveRescheduledItem(item, rescheduleCalendarAllDayItem(item, dateKey, sourceDateKey));
  };
  const resizeItem = (item: CalendarItem, dateKey: string, endMinute: number) => {
    saveRescheduledItem(item, resizeCalendarTimedItem(item, dateKey, endMinute));
  };
  const selectedDay = dateFromKey(selectedDate);
  const selectedItems = visibleItems.filter((item) => itemOccursOn(item, selectedDay));

  return (
    <div ref={rootRef} data-time-format={timeFormat} className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <CalendarDays className="size-4 text-primary" />
        <h1 className="mr-1 text-sm font-semibold">Calendar</h1>
        <Button variant="outline" size="sm" onClick={() => {
          const today = new Date();
          setAnchor(today);
          setSelectedDate(calendarDateKey(today));
        }}>Today</Button>
        <Button variant="ghost" size="icon-sm" aria-label="Previous period" onClick={() => movePeriod(-1)}><ChevronLeft /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next period" onClick={() => movePeriod(1)}><ChevronRight /></Button>
        <div className="min-w-28 flex-1 truncate text-center text-sm font-medium">{viewTitle(viewMode, anchor, selectedDay, weekDays)}</div>
        <CalendarSearch
          open={searchOpen}
          onOpenChange={setSearchOpen}
          query={searchQuery}
          onQueryChange={setSearchQuery}
          results={searchResults}
          searching={searching}
          calendarById={calendarById}
          onOpenItem={(item) => {
            setSearchOpen(false);
            editItem(item);
          }}
        />
        <div role="group" aria-label="Calendar view" className="flex rounded-md border border-border bg-muted/30 p-0.5">
          {VIEW_MODES.map((mode) => (
            <button key={mode.value} type="button" aria-pressed={viewMode === mode.value} onClick={() => setViewMode(mode.value)} className={cn('h-6 rounded px-2 text-[11px] text-muted-foreground', viewMode === mode.value && 'bg-background text-foreground shadow-sm')}>
              {mode.label}
            </button>
          ))}
        </div>
        {store.loading && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
        {hostedOrigins.length > 0 && <CalendarInvitations origins={hostedOrigins} onChanged={() => void store.syncHosted(hostedOrigins)} />}
        {hostedOrigins.length > 0 && <Button variant="ghost" size="icon-sm" aria-label="Sync hosted calendars" title="Sync hosted calendars" disabled={store.syncing} onClick={() => void store.syncHosted(hostedOrigins)}><RefreshCw className={cn(store.syncing && 'animate-spin')} /></Button>}
        <Button size="sm" onClick={() => openEditor({ date: selectedDate, kind: 'event' })} disabled={store.calendars.length === 0}><Plus /> New</Button>
      </header>

      {store.error && <button type="button" className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-left text-xs text-destructive" onClick={store.clearError}>{store.error}</button>}

      <div className="flex min-h-0 flex-1">
        {showCalendarRail && <CalendarRail
          calendars={store.calendars}
          visibleIds={store.visibleCalendarIds}
          saving={store.saving}
          onVisible={store.setCalendarVisible}
          onAdd={() => setCalendarDialogOpen(true)}
          onEdit={setCalendarEditor}
          onArchive={(calendar, archived) => {
            void store.updateCalendar(calendar.id, { archived }).catch(() => {});
          }}
        />}
        <main className={cn('grid min-h-0 min-w-0 flex-1', showMonthAgenda && 'grid-cols-[minmax(0,1fr)_240px]')}>
          <div data-calendar-scroll className="h-full min-h-0 min-w-0 overflow-auto overscroll-contain" onWheel={handleWheel}>
            <div key={periodTransition.sequence} className={cn('h-full min-h-0', periodTransition.sequence > 0 && 'calendar-period-transition', periodTransition.direction > 0 ? 'calendar-period-transition-next' : 'calendar-period-transition-previous')}>
              {viewMode === 'month' && <MonthView anchor={anchor} days={monthDays} weekStart={weekStart} hideWeekends={hideWeekends} items={visibleItems} calendarById={calendarById} selectedDate={selectedDate} onSelect={setSelectedDate} onAdd={openEditor} onEdit={editItem} onDelete={deleteItem} />}
              {viewMode === 'week' && <WeekView days={weekDays} items={visibleItems} calendarById={calendarById} selectedDate={selectedDate} onSelect={setSelectedDate} onAdd={openEditor} onEdit={editItem} onDelete={deleteItem} onReschedule={rescheduleItem} onAllDayReschedule={rescheduleAllDayItem} onResize={resizeItem} />}
              {viewMode === 'day' && <DayView day={selectedDay} items={visibleItems} calendarById={calendarById} onAdd={openEditor} onEdit={editItem} onDelete={deleteItem} onReschedule={rescheduleItem} onAllDayReschedule={rescheduleAllDayItem} onResize={resizeItem} />}
              {viewMode === 'agenda' && <AgendaView day={selectedDay} items={selectedItems} calendarById={calendarById} onAdd={openEditor} onEdit={editItem} onDelete={deleteItem} />}
              {viewMode === 'tasks' && <TasksView anchor={anchor} items={visibleItems} calendarById={calendarById} onAdd={openEditor} onEdit={editItem} onDelete={deleteItem} />}
              {viewMode === 'year' && <YearView year={anchor.getFullYear()} weekStart={weekStart} hideWeekends={hideWeekends} items={visibleItems} calendarById={calendarById} onOpenMonth={(date) => { setAnchor(date); setSelectedDate(calendarDateKey(date)); setViewMode('month'); }} onAdd={openEditor} />}
            </div>
          </div>
          {showMonthAgenda && <AgendaPanel day={selectedDay} items={selectedItems} calendarById={calendarById} onEdit={editItem} onDelete={deleteItem} />}
        </main>
      </div>

      <ItemEditorDialog request={editorRequest} onOpenChange={(open) => !open && setEditorRequest(null)} calendars={editableCalendars} saving={store.saving} onSave={store.saveItem} />
      <RecurringDeleteDialog item={deleteRequest} saving={store.saving} onOpenChange={(open) => !open && setDeleteRequest(null)} onDelete={async (scope) => { if (!deleteRequest) return; await store.deleteItem(deleteRequest, scope); setDeleteRequest(null); }} />
      <RecurringRescheduleDialog item={rescheduleRequest?.item ?? null} saving={store.saving} onOpenChange={(open) => !open && setRescheduleRequest(null)} onSave={async (scope) => { if (!rescheduleRequest) return; await store.saveItem(rescheduleRequest.item, scope); setRescheduleRequest(null); }} />
      <CalendarDialog open={calendarDialogOpen} onOpenChange={setCalendarDialogOpen} saving={store.saving} locations={calendarLocations} onCreate={store.createCalendar} />
      <CalendarSettingsDialog
        calendar={calendarEditor}
        saving={store.saving}
        onOpenChange={(open) => !open && setCalendarEditor(null)}
        onSave={async (calendarId, changes) => {
          await store.updateCalendar(calendarId, changes);
          setCalendarEditor(null);
        }}
      />
    </div>
  );
}

function RecurringDeleteDialog({ item, saving, onOpenChange, onDelete }: {
  item: CalendarItem | null;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (scope: CalendarRecurrenceEditScope) => Promise<void>;
}) {
  const [scope, setScope] = useState<CalendarRecurrenceEditScope>('occurrence');
  useEffect(() => { if (item) setScope('occurrence'); }, [item]);
  return <Dialog open={item != null} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-sm"><DialogHeader><DialogTitle>Delete recurring item</DialogTitle></DialogHeader><div className="space-y-2"><p className="text-sm text-muted-foreground">Choose which occurrences of <span className="font-medium text-foreground">{item?.title}</span> to delete.</p><Select value={scope} onValueChange={(value) => setScope(value as CalendarRecurrenceEditScope)}><SelectTrigger aria-label="Recurring delete scope"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="occurrence">This occurrence</SelectItem><SelectItem value="following">This and following occurrences</SelectItem><SelectItem value="series">Entire series</SelectItem></SelectContent></Select></div><DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" variant="destructive" disabled={saving} onClick={() => void onDelete(scope)}>{saving ? 'Deleting...' : 'Delete'}</Button></DialogFooter></DialogContent></Dialog>;
}

function RecurringRescheduleDialog({ item, saving, onOpenChange, onSave }: {
  item: CalendarItem | null;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (scope: CalendarRecurrenceEditScope) => Promise<void>;
}) {
  const [scope, setScope] = useState<CalendarRecurrenceEditScope>('occurrence');
  useEffect(() => { if (item) setScope('occurrence'); }, [item]);
  return <Dialog open={item != null} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-sm"><DialogHeader><DialogTitle>Reschedule recurring item</DialogTitle></DialogHeader><div className="space-y-2"><p className="text-sm text-muted-foreground">Choose which occurrences of <span className="font-medium text-foreground">{item?.title}</span> to reschedule.</p><Select value={scope} onValueChange={(value) => setScope(value as CalendarRecurrenceEditScope)}><SelectTrigger aria-label="Recurring reschedule scope"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="occurrence">This occurrence</SelectItem><SelectItem value="following">This and following occurrences</SelectItem><SelectItem value="series">Entire series</SelectItem></SelectContent></Select></div><DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" disabled={saving} onClick={() => void onSave(scope)}>{saving ? 'Saving...' : 'Save'}</Button></DialogFooter></DialogContent></Dialog>;
}

function viewTitle(mode: CalendarViewMode, anchor: Date, selected: Date, weekDays: Date[]): string {
  if (mode === 'year') return String(anchor.getFullYear());
  if (mode === 'day' || mode === 'agenda') return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(selected);
  if (mode === 'week') {
    const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    return `${format.format(weekDays[0])} - ${format.format(weekDays[6])}`;
  }
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(anchor);
}

export function calendarPeriodDayStep(mode: CalendarViewMode): number {
  return mode === 'week' ? 7 : 1;
}

export function setCompactCalendarDragImage(
  dataTransfer: DataTransfer,
  source: HTMLElement,
  interfaceScale = useUiStore.getState().scale / 100,
) {
  if (typeof dataTransfer.setDragImage !== 'function') return;
  const rect = source.getBoundingClientRect();
  const scale = Math.max(0.5, interfaceScale);
  const width = Math.round(Math.max(64, Math.min(140, rect.width * scale * 0.7)) / scale);
  const height = Math.round(Math.max(18, Math.min(30, rect.height * scale * 0.7)) / scale);
  const preview = source.cloneNode(true) as HTMLElement;
  preview.removeAttribute('draggable');
  preview.style.position = 'fixed';
  preview.style.left = '-9999px';
  preview.style.top = '-9999px';
  preview.style.width = `${width}px`;
  preview.style.height = `${height}px`;
  preview.style.minHeight = '0';
  preview.style.maxHeight = `${height}px`;
  preview.style.pointerEvents = 'none';
  preview.style.overflow = 'hidden';
  preview.style.opacity = '0.9';
  preview.style.background = 'var(--card)';
  preview.style.border = '1px solid var(--border)';
  preview.style.borderRadius = '6px';
  preview.style.boxShadow = '0 8px 18px color-mix(in oklch, black 14%, transparent)';
  document.body.appendChild(preview);
  dataTransfer.setDragImage(preview, Math.min(14, width / 2), Math.min(12, height / 2));
  window.setTimeout(() => preview.remove(), 0);
}

export function CalendarRail({ calendars, visibleIds, saving, onVisible, onAdd, onEdit, onArchive }: {
  calendars: CalendarDefinition[];
  visibleIds: string[];
  saving: boolean;
  onVisible: (id: string, visible: boolean) => void;
  onAdd: () => void;
  onEdit: (calendar: CalendarDefinition) => void;
  onArchive: (calendar: CalendarDefinition, archived: boolean) => void;
}) {
  const activeCalendars = calendars.filter((calendar) => !calendar.archived);
  const archivedCalendars = calendars.filter((calendar) => calendar.archived);
  return <aside className="flex w-44 shrink-0 flex-col border-r border-border/60 bg-sidebar/40 p-3">
    <div className="mb-2 flex items-center justify-between"><span className="text-[10px] font-semibold uppercase text-muted-foreground">Calendars</span><Button variant="ghost" size="icon-xs" aria-label="Add calendar" onClick={onAdd}><CirclePlus /></Button></div>
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">{activeCalendars.map((calendar) => {
      const checkboxId = `calendar-visible-${calendar.id}`;
      return <div key={calendar.id} className="group flex items-center gap-1 rounded-md px-1.5 py-1.5 text-xs hover:bg-accent/60"><Checkbox id={checkboxId} checked={visibleIds.includes(calendar.id)} onCheckedChange={(checked) => onVisible(calendar.id, checked === true)} /><label htmlFor={checkboxId} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"><span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: calendar.color }} /><span className="truncate">{calendar.name}</span></label><CalendarActions calendar={calendar} saving={saving} onEdit={onEdit} onArchive={onArchive} /></div>;
    })}
    {archivedCalendars.length > 0 && <>
      <div className="mb-1 mt-3 px-1 text-[9px] font-semibold uppercase text-muted-foreground">Archived</div>
      {archivedCalendars.map((calendar) => <div key={calendar.id} className="group flex items-center gap-1 rounded-md px-1.5 py-1.5 text-xs text-muted-foreground hover:bg-accent/60">
        <span className="size-2.5 shrink-0 rounded-full opacity-60" style={{ backgroundColor: calendar.color }} />
        <span className="min-w-0 flex-1 truncate">{calendar.name}</span>
        <Button type="button" variant="ghost" size="icon-xs" disabled={saving || calendar.readOnly} aria-label={`Restore ${calendar.name}`} title="Restore calendar" onClick={() => onArchive(calendar, false)}><ArchiveRestore /></Button>
        <CalendarActions calendar={calendar} saving={saving} onEdit={onEdit} onArchive={onArchive} />
      </div>)}
    </>}</div>
  </aside>;
}

function CalendarActions({ calendar, saving, onEdit, onArchive }: {
  calendar: CalendarDefinition;
  saving: boolean;
  onEdit: (calendar: CalendarDefinition) => void;
  onArchive: (calendar: CalendarDefinition, archived: boolean) => void;
}) {
  return <DropdownMenu><DropdownMenuTrigger asChild><Button
    type="button"
    variant="ghost"
    size="icon-xs"
    className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100"
    aria-label={`Manage ${calendar.name}`}
  ><Ellipsis /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-36">
    <DropdownMenuItem disabled={saving || calendar.readOnly} onSelect={() => onEdit(calendar)}><Pencil />Edit</DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem disabled={saving || calendar.readOnly} onSelect={() => onArchive(calendar, !calendar.archived)}>
      {calendar.archived ? <ArchiveRestore /> : <Archive />}
      {calendar.archived ? 'Restore' : 'Archive'}
    </DropdownMenuItem>
  </DropdownMenuContent></DropdownMenu>;
}

export function CalendarSearch({ open, onOpenChange, query, onQueryChange, results, searching, calendarById, onOpenItem }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  results: CalendarItem[];
  searching: boolean;
  calendarById: Map<string, CalendarDefinition>;
  onOpenItem: (item: CalendarItem) => void;
}) {
  return <Popover open={open} onOpenChange={onOpenChange}><PopoverTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label="Search calendars" title="Search calendars"><Search /></Button></PopoverTrigger><PopoverContent align="end" className="w-80 p-0">
    <div className="border-b border-border/60 p-2"><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input autoFocus className="h-8 pl-8" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search events, tasks, birthdays..." aria-label="Search calendar items" /></div></div>
    <div className="max-h-80 overflow-y-auto p-1" aria-live="polite">
      {searching && <div className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Searching</div>}
      {!searching && query.trim().length < 2 && <div className="px-3 py-6 text-center text-xs text-muted-foreground">Enter at least two characters</div>}
      {!searching && query.trim().length >= 2 && results.length === 0 && <div className="px-3 py-6 text-center text-xs text-muted-foreground">No matching calendar items</div>}
      {!searching && results.map((item) => {
        const calendar = calendarById.get(item.calendarId);
        return <button key={item.id} type="button" onClick={() => onOpenItem(item)} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted"><ItemTypeIcon item={item} className="size-3.5 text-muted-foreground" /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{item.title}</span><span className="block truncate text-[10px] text-muted-foreground">{itemDate(item)}{calendar ? ` · ${calendar.name} · ${calendarOrigin(calendar)}` : ''}</span></span>
          {calendar && <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: calendar.color }} />}
        </button>;
      })}
    </div>
  </PopoverContent></Popover>;
}

interface ViewProps {
  items: CalendarItem[];
  calendarById: Map<string, CalendarDefinition>;
  onAdd: (request: EditorRequest) => void;
  onEdit: (item: CalendarItem) => void;
  onDelete: (item: CalendarItem) => void;
}

function MonthView({ anchor, days, weekStart, hideWeekends, items, calendarById, selectedDate, onSelect, onAdd, onEdit, onDelete }: ViewProps & { anchor: Date; days: Date[]; weekStart: 0 | 1; hideWeekends: boolean; selectedDate: string; onSelect: (date: string) => void }) {
  const columns = hideWeekends ? 5 : 7;
  const labels = Array.from({ length: 7 }, (_, index) => new Date(2026, 6, 5 + ((weekStart + index) % 7)))
    .filter((day) => !hideWeekends || (day.getDay() !== 0 && day.getDay() !== 6))
    .map((day) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day));
  return <section className="grid h-full min-h-[570px] grid-rows-[28px_repeat(6,minmax(90px,1fr))] overflow-hidden">
    <div className="grid border-b border-border/60" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{labels.map((label) => <div key={label} className="px-2 py-1 text-right text-[10px] font-medium uppercase text-muted-foreground">{label}</div>)}</div>
    {Array.from({ length: 6 }, (_, row) => <div key={row} className="grid min-h-0" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{days.slice(row * 7, row * 7 + 7).filter((day) => !hideWeekends || (day.getDay() !== 0 && day.getDay() !== 6)).map((day) => {
      const key = calendarDateKey(day);
      const dayItems = items.filter((item) => itemOccursOn(item, day));
      return <DateContextMenu key={key} date={key} onAdd={onAdd}><div role="button" tabIndex={0} aria-label={new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(day)} onClick={() => onSelect(key)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(key); } }} className={cn('min-h-0 overflow-hidden border-b border-r border-border/50 p-1 text-left hover:bg-accent/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary', day.getMonth() !== anchor.getMonth() && 'bg-muted/10 text-muted-foreground/60', key === selectedDate && 'bg-primary/5 ring-1 ring-inset ring-primary/40')}>
        <span className={cn('ml-auto flex size-5 items-center justify-center rounded-full text-[11px]', key === calendarDateKey(new Date()) && 'bg-primary font-semibold text-primary-foreground')}>{day.getDate()}</span>
        <div className="mt-0.5 space-y-0.5">{dayItems.slice(0, 4).map((item) => <ItemChip key={item.id} item={item} color={calendarById.get(item.calendarId)?.color} onEdit={onEdit} onDelete={onDelete} />)}{dayItems.length > 4 && <div className="px-1 text-[9px] text-muted-foreground">+{dayItems.length - 4}</div>}</div>
      </div></DateContextMenu>;
    })}</div>)}
  </section>;
}

function WeekView({ days, items, calendarById, selectedDate, onSelect, onAdd, onEdit, onDelete, onReschedule, onAllDayReschedule, onResize }: ViewProps & {
  days: Date[];
  selectedDate: string;
  onSelect: (date: string) => void;
  onReschedule: (item: CalendarItem, dateKey: string, startMinute: number) => void;
  onAllDayReschedule: (item: CalendarItem, dateKey: string, sourceDateKey: string) => void;
  onResize: (item: CalendarItem, dateKey: string, endMinute: number) => void;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const todayKey = calendarDateKey(new Date());
  const now = new Date();
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  const timeFormat = useUiStore((state) => state.timeFormat);
  const hourLabel = (hour: number) => formatTime(new Date(2026, 0, 1, hour), timeFormat);
  const allDayItems = days.map((day) => {
    const key = calendarDateKey(day);
    return items.filter((item) => itemOccursOn(item, day) && !layoutCalendarTimedItems([item], key).length);
  });
  const allDayRows = Math.max(1, ...allDayItems.map((entries) => Math.min(entries.length, 3)));
  const allDayHeight = 30 + allDayRows * 24;
  useInitialTimedScroll(rootRef, days, allDayHeight);

  const gridTemplateColumns = `52px repeat(${days.length}, minmax(96px, 1fr))`;
  return <section ref={rootRef} className={cn(days.length === 7 ? 'min-w-[760px]' : 'min-w-[560px]')}>
    <div className="sticky top-0 z-20 grid border-b border-border bg-background" style={{ gridTemplateColumns }}>
      <div className="border-r border-border/60" />
      {days.map((day) => {
        const key = calendarDateKey(day);
        return <button key={key} type="button" onClick={() => onSelect(key)} className={cn('border-r border-border/60 py-1.5 text-center hover:bg-accent/40', selectedDate === key && 'bg-primary/5')}>
          <span className="block text-[10px] uppercase text-muted-foreground">{new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day)}</span>
          <span className={cn('mx-auto mt-0.5 flex size-7 items-center justify-center rounded-full text-sm', key === todayKey && 'bg-primary text-primary-foreground')}>{day.getDate()}</span>
        </button>;
      })}
      <div className="flex items-start justify-end border-r border-t border-border/60 px-2 pt-2 text-[9px] uppercase text-muted-foreground" style={{ height: allDayHeight }}>All day</div>
      {days.map((day, dayIndex) => {
        const key = calendarDateKey(day);
        const dayItems = allDayItems[dayIndex];
        return <AllDayDropLane
          key={key}
          dateKey={key}
          dayItems={dayItems}
          availableItems={items}
          calendarById={calendarById}
          selected={selectedDate === key}
          height={allDayHeight}
          onAdd={onAdd}
          onEdit={onEdit}
          onDelete={onDelete}
          onReschedule={onAllDayReschedule}
        />;
      })}
    </div>

    <div className="grid" style={{ gridTemplateColumns }}>
      <TimeGutter hourLabel={hourLabel} />
      {days.map((day) => {
        const key = calendarDateKey(day);
        return <TimedDayColumn
          key={key}
          dateKey={key}
          items={items}
          calendarById={calendarById}
          selected={selectedDate === key}
          hourLabel={hourLabel}
          todayKey={todayKey}
          nowMinute={nowMinute}
          onSelect={onSelect}
          onAdd={onAdd}
          onEdit={onEdit}
          onDelete={onDelete}
          onReschedule={onReschedule}
          onResize={onResize}
        />;
      })}
    </div>
  </section>;
}

function DayView({ day, items, calendarById, onAdd, onEdit, onDelete, onReschedule, onAllDayReschedule, onResize }: ViewProps & {
  day: Date;
  onReschedule: (item: CalendarItem, dateKey: string, startMinute: number) => void;
  onAllDayReschedule: (item: CalendarItem, dateKey: string, sourceDateKey: string) => void;
  onResize: (item: CalendarItem, dateKey: string, endMinute: number) => void;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const key = calendarDateKey(day);
  const todayKey = calendarDateKey(new Date());
  const now = new Date();
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  const timeFormat = useUiStore((state) => state.timeFormat);
  const hourLabel = (hour: number) => formatTime(new Date(2026, 0, 1, hour), timeFormat);
  const dayItems = items.filter((item) => itemOccursOn(item, day));
  const allDayItems = dayItems.filter((item) => !layoutCalendarTimedItems([item], key).length);
  const allDayRows = Math.max(1, Math.min(allDayItems.length, 3));
  const allDayHeight = 30 + allDayRows * 24;
  useInitialTimedScroll(rootRef, [day], allDayHeight);

  return <section ref={rootRef} className="mx-auto min-w-[520px] max-w-5xl">
    <div className="sticky top-0 z-20 grid grid-cols-[52px_minmax(0,1fr)] border-b border-border bg-background">
      <div className="border-r border-border/60" />
      <div className="border-r border-border/60 py-1.5 text-center">
        <span className="block text-[10px] uppercase text-muted-foreground">{new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(day)}</span>
        <span className={cn('mx-auto mt-0.5 flex size-7 items-center justify-center rounded-full text-sm', key === todayKey && 'bg-primary text-primary-foreground')}>{day.getDate()}</span>
      </div>
      <div className="flex items-start justify-end border-r border-t border-border/60 px-2 pt-2 text-[9px] uppercase text-muted-foreground" style={{ height: allDayHeight }}>All day</div>
      <AllDayDropLane
        dateKey={key}
        dayItems={allDayItems}
        availableItems={items}
        calendarById={calendarById}
        selected
        height={allDayHeight}
        onAdd={onAdd}
        onEdit={onEdit}
        onDelete={onDelete}
        onReschedule={onAllDayReschedule}
      />
    </div>
    <div className="grid grid-cols-[52px_minmax(0,1fr)]">
      <TimeGutter hourLabel={hourLabel} />
      <TimedDayColumn
        dateKey={key}
        items={items}
        calendarById={calendarById}
        selected
        hourLabel={hourLabel}
        todayKey={todayKey}
        nowMinute={nowMinute}
        onSelect={() => {}}
        onAdd={onAdd}
        onEdit={onEdit}
        onDelete={onDelete}
        onReschedule={onReschedule}
        onResize={onResize}
      />
    </div>
  </section>;
}

function useInitialTimedScroll(
  rootRef: React.RefObject<HTMLElement | null>,
  days: Date[],
  allDayHeight: number,
) {
  const workingHoursStart = useUiStore((state) => state.calendarWorkingHoursStart);
  const dateKeys = days.map(calendarDateKey).join('|');
  useEffect(() => {
    const scroller = rootRef.current?.closest<HTMLElement>('[data-calendar-scroll]');
    if (!scroller || scroller.scrollTop > 80) return;
    const includesToday = dateKeys.split('|').includes(calendarDateKey(new Date()));
    const workingHour = Number(workingHoursStart.slice(0, 2));
    const focusHour = includesToday ? Math.max(0, new Date().getHours() - 1) : Math.max(0, workingHour - 1);
    scroller.scrollTop = allDayHeight + focusHour * WEEK_HOUR_HEIGHT;
  }, [allDayHeight, dateKeys, rootRef, workingHoursStart]);
}

function TimeGutter({ hourLabel }: { hourLabel: (hour: number) => string }) {
  return <div className="relative border-r border-border/60" style={{ height: WEEK_HOUR_HEIGHT * 24 }}>
    {Array.from({ length: 24 }, (_, hour) => <span key={hour} className="absolute right-2 -translate-y-1/2 text-[9px] text-muted-foreground" style={{ top: hour * WEEK_HOUR_HEIGHT }}>{hourLabel(hour)}</span>)}
  </div>;
}

function AllDayDropLane({ dateKey, dayItems, availableItems, calendarById, selected, height, onAdd, onEdit, onDelete, onReschedule }: {
  dateKey: string;
  dayItems: CalendarItem[];
  availableItems: CalendarItem[];
  calendarById: Map<string, CalendarDefinition>;
  selected: boolean;
  height: number;
  onAdd: (request: EditorRequest) => void;
  onEdit: (item: CalendarItem) => void;
  onDelete: (item: CalendarItem) => void;
  onReschedule: (item: CalendarItem, dateKey: string, sourceDateKey: string) => void;
}) {
  const [dropActive, setDropActive] = useState(false);
  return <DateContextMenu date={dateKey} onAdd={onAdd}><div
    className={cn(
      'overflow-hidden border-r border-t border-border/60 p-1',
      selected && 'bg-primary/5',
      dropActive && 'bg-primary/10 ring-1 ring-inset ring-primary/50',
    )}
    style={{ height }}
    onDragOver={(event) => {
      if (!Array.from(event.dataTransfer.types).includes(CALENDAR_ALL_DAY_ITEM_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDropActive(true);
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
    }}
    onDragEnd={() => setDropActive(false)}
    onDrop={(event) => {
      const payload = event.dataTransfer.getData(CALENDAR_ALL_DAY_ITEM_DRAG_TYPE);
      if (!payload) return;
      event.preventDefault();
      setDropActive(false);
      try {
        const { itemId, sourceDateKey } = JSON.parse(payload) as { itemId: string; sourceDateKey: string };
        const item = availableItems.find((entry) => entry.id === itemId);
        if (item) onReschedule(item, dateKey, sourceDateKey);
      } catch {
        // Ignore malformed internal drag payloads.
      }
    }}
  >
    <div className="space-y-0.5">{dayItems.slice(0, 3).map((item) => <ItemChip
      key={item.id}
      item={item}
      color={calendarById.get(item.calendarId)?.color}
      onEdit={onEdit}
      onDelete={onDelete}
      draggable
      dragDateKey={dateKey}
    />)}{dayItems.length > 3 && <div className="px-1 text-[9px] text-muted-foreground">+{dayItems.length - 3} more</div>}</div>
  </div></DateContextMenu>;
}

function TimedDayColumn({ dateKey, items, calendarById, selected, hourLabel, todayKey, nowMinute, onSelect, onAdd, onEdit, onDelete, onReschedule, onResize }: ViewProps & {
  dateKey: string;
  selected: boolean;
  hourLabel: (hour: number) => string;
  todayKey: string;
  nowMinute: number;
  onSelect: (date: string) => void;
  onReschedule: (item: CalendarItem, dateKey: string, startMinute: number) => void;
  onResize: (item: CalendarItem, dateKey: string, endMinute: number) => void;
}) {
  const columnRef = useRef<HTMLDivElement | null>(null);
  const resizingItem = useRef<{ item: CalendarItem; startMinute: number } | null>(null);
  const [dropMinute, setDropMinute] = useState<number | null>(null);
  const [resizeActive, setResizeActive] = useState(false);
  const [resizePreview, setResizePreview] = useState<{ itemId: string; endMinute: number } | null>(null);
  const timedItems = layoutCalendarTimedItems(items, dateKey);
  const minuteAtPointer = (clientY: number, top: number) => snapCalendarMinute(
    (clientY - top) / WEEK_HOUR_HEIGHT * 60,
  );
  useEffect(() => {
    if (!resizeActive) return;
    const endMinuteAtPointer = (clientY: number) => {
      const current = resizingItem.current;
      const column = columnRef.current;
      if (!current || !column) return null;
      const rawMinute = (clientY - column.getBoundingClientRect().top) / WEEK_HOUR_HEIGHT * 60;
      return snapCalendarEndMinute(rawMinute, current.startMinute + 15);
    };
    const move = (event: PointerEvent) => {
      const current = resizingItem.current;
      const endMinute = endMinuteAtPointer(event.clientY);
      if (current && endMinute != null) {
        setResizePreview({ itemId: current.item.id, endMinute });
      }
    };
    const finish = (event: PointerEvent) => {
      const current = resizingItem.current;
      const endMinute = endMinuteAtPointer(event.clientY);
      resizingItem.current = null;
      setResizeActive(false);
      if (current && endMinute != null) {
        setResizePreview({ itemId: current.item.id, endMinute });
        onResize(current.item, dateKey, endMinute);
      } else {
        setResizePreview(null);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
    };
  }, [dateKey, onResize, resizeActive]);
  useEffect(() => {
    if (!resizePreview || resizeActive) return;
    const stored = timedItems.find((entry) => entry.item.id === resizePreview.itemId);
    if (stored && Math.abs(stored.endMinute - resizePreview.endMinute) < 0.01) {
      setResizePreview(null);
      return;
    }
    const timeout = window.setTimeout(() => setResizePreview(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [resizeActive, resizePreview, timedItems]);
  return <DateContextMenu date={dateKey} onAdd={onAdd}><div
    ref={columnRef}
    className={cn('relative border-r border-border/60', selected && 'bg-primary/[0.025]')}
    style={{ height: WEEK_HOUR_HEIGHT * 24 }}
    onDragOver={(event) => {
      if (!Array.from(event.dataTransfer.types).includes(CALENDAR_TIMED_ITEM_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDropMinute(minuteAtPointer(event.clientY, event.currentTarget.getBoundingClientRect().top));
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropMinute(null);
    }}
    onDragEnd={() => setDropMinute(null)}
    onDrop={(event) => {
      const itemId = event.dataTransfer.getData(CALENDAR_TIMED_ITEM_DRAG_TYPE);
      if (!itemId) return;
      event.preventDefault();
      const item = items.find((entry) => entry.id === itemId);
      const minute = minuteAtPointer(event.clientY, event.currentTarget.getBoundingClientRect().top);
      setDropMinute(null);
      if (item) onReschedule(item, dateKey, minute);
    }}
  >
    {Array.from({ length: 24 }, (_, hour) => <button
      key={hour}
      type="button"
      aria-label={`Create event on ${dateKey} at ${hourLabel(hour)}`}
      className="absolute left-0 right-0 border-t border-border/45 hover:bg-accent/20 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      style={{ top: hour * WEEK_HOUR_HEIGHT, height: WEEK_HOUR_HEIGHT }}
      onClick={() => onSelect(dateKey)}
      onDoubleClick={() => onAdd({ date: dateKey, kind: 'event', initialTime: `${String(hour).padStart(2, '0')}:00` })}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onAdd({ date: dateKey, kind: 'event', initialTime: `${String(hour).padStart(2, '0')}:00` });
      }}
    />)}
    {dropMinute != null && <div className="pointer-events-none absolute left-0 right-0 z-[5] border-t-2 border-primary" style={{ top: dropMinute / 60 * WEEK_HOUR_HEIGHT }} />}
    {dateKey === todayKey && <div className="pointer-events-none absolute left-0 right-0 z-10 border-t border-primary" style={{ top: nowMinute / CALENDAR_MINUTES_PER_DAY * WEEK_HOUR_HEIGHT * 24 }}><span className="absolute -left-1 -top-1 size-2 rounded-full bg-primary" /></div>}
    {timedItems.map((entry) => {
      const color = calendarById.get(entry.item.calendarId)?.color;
      const width = 100 / entry.columnCount;
      const previewEndMinute = resizePreview?.itemId === entry.item.id ? resizePreview.endMinute : entry.endMinute;
      const canResize = entry.item.kind === 'event'
        || (entry.item.kind === 'task' && entry.item.start?.kind === 'dateTime');
      return <ItemContextMenu key={entry.item.id} item={entry.item} onEdit={onEdit} onDelete={onDelete}><div
        className="group absolute z-[2] overflow-hidden rounded border-l-2 bg-background/95 shadow-sm hover:z-[3] hover:bg-accent focus-within:z-[4]"
        style={{
          top: entry.startMinute / 60 * WEEK_HOUR_HEIGHT,
          height: Math.max(22, (previewEndMinute - entry.startMinute) / 60 * WEEK_HOUR_HEIGHT),
          left: `calc(${entry.column * width}% + 2px)`,
          width: `calc(${width}% - 4px)`,
          borderLeftColor: color,
        }}
      >
        <button
          type="button"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(CALENDAR_TIMED_ITEM_DRAG_TYPE, entry.item.id);
            event.dataTransfer.setData('text/plain', entry.item.title);
            setCompactCalendarDragImage(event.dataTransfer, event.currentTarget);
          }}
          onClick={(event) => { event.stopPropagation(); onSelect(dateKey); onEdit(entry.item); }}
          className="h-full w-full cursor-grab overflow-hidden px-1 py-0.5 text-left active:cursor-grabbing"
        >
          <span className="flex min-w-0 items-center gap-1 text-[10px] font-medium"><ItemTypeIcon item={entry.item} className="size-2.5 shrink-0" /><span className="truncate">{entry.item.title}</span></span>
          <span className="block truncate text-[9px] text-muted-foreground">{itemTime(entry.item)}</span>
        </button>
        {canResize && <button
          type="button"
          draggable={false}
          aria-label={`Resize ${entry.item.title}`}
          title="Drag or use arrow keys to resize"
          className="absolute bottom-0 left-0 right-0 z-10 h-2 cursor-ns-resize opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            resizingItem.current = { item: entry.item, startMinute: entry.startMinute };
            setResizePreview({ itemId: entry.item.id, endMinute: entry.endMinute });
            setResizeActive(true);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            event.stopPropagation();
            const delta = event.key === 'ArrowUp' ? -15 : 15;
            const endMinute = snapCalendarEndMinute(
              entry.endMinute + delta,
              entry.startMinute + 15,
            );
            setResizePreview({ itemId: entry.item.id, endMinute });
            onResize(entry.item, dateKey, endMinute);
          }}
        ><span className="mx-auto block h-0.5 w-7 rounded-full bg-muted-foreground/60" /></button>}
      </div></ItemContextMenu>;
    })}
  </div></DateContextMenu>;
}

function AgendaView({ day, items, calendarById, onAdd, onEdit, onDelete }: ViewProps & { day: Date }) {
  const key = calendarDateKey(day);
  return <DateContextMenu date={key} onAdd={onAdd}><section className="mx-auto min-h-full w-full max-w-3xl px-5 py-4"><div className="mb-5 border-b border-border/60 pb-3"><div className="text-xs uppercase text-muted-foreground">{new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(day)}</div><div className="text-xl font-semibold">{new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(day)}</div></div><div className="space-y-2">{items.map((item) => <AgendaItem key={item.id} item={item} color={calendarById.get(item.calendarId)?.color} onEdit={onEdit} onDelete={onDelete} />)}{items.length === 0 && <div className="py-12 text-center text-sm text-muted-foreground">No entries</div>}</div></section></DateContextMenu>;
}

function TasksView({ anchor, items, calendarById, onAdd, onEdit, onDelete }: ViewProps & { anchor: Date }) {
  const tasks = items
    .filter((item): item is Extract<CalendarItem, { kind: 'task' }> => item.kind === 'task')
    .sort((left, right) => itemDate(left).localeCompare(itemDate(right)) || left.title.localeCompare(right.title));
  const open = tasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled');
  const closed = tasks.filter((task) => task.status === 'completed' || task.status === 'cancelled');
  const renderGroup = (title: string, group: typeof tasks) => <section aria-labelledby={`calendar-tasks-${title.toLowerCase().replace(/ /g, '-')}`}>
    <h2 id={`calendar-tasks-${title.toLowerCase().replace(/ /g, '-')}`} className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">{title} <span className="ml-1 font-normal">{group.length}</span></h2>
    <div className="divide-y divide-border/50 border-y border-border/50">{group.map((task) => {
      const calendar = calendarById.get(task.calendarId);
      return <ItemContextMenu key={task.id} item={task} onEdit={onEdit} onDelete={onDelete}><button type="button" onClick={() => onEdit(task)} className="flex w-full items-center gap-3 px-2 py-2.5 text-left hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <CheckCircle2 className={cn('size-4 shrink-0', task.status === 'completed' ? 'text-primary' : 'text-muted-foreground/50')} />
        <span className="min-w-0 flex-1"><span className={cn('block truncate text-sm font-medium', task.status === 'completed' && 'text-muted-foreground line-through')}>{task.title}</span><span className="block truncate text-[10px] text-muted-foreground">{itemDate(task)}{task.priority ? ` · ${task.priority} priority` : ''}</span></span>
        {calendar && <span className="flex max-w-40 items-center gap-1.5 truncate text-[10px] text-muted-foreground"><span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: calendar.color }} />{calendar.name}</span>}
      </button></ItemContextMenu>;
    })}{group.length === 0 && <div className="px-3 py-8 text-center text-xs text-muted-foreground">No tasks in this period</div>}</div>
  </section>;
  return <div className="mx-auto w-full max-w-4xl space-y-6 px-5 py-4">
    <div className="flex items-center justify-between"><div><h1 className="text-base font-semibold">Tasks</h1><p className="text-xs text-muted-foreground">{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(anchor)}</p></div><Button type="button" size="sm" onClick={() => onAdd({ date: calendarDateKey(anchor), kind: 'task' })}><Plus />New task</Button></div>
    {renderGroup('Open', open)}
    {closed.length > 0 && renderGroup('Completed and cancelled', closed)}
  </div>;
}

function YearView({ year, weekStart, hideWeekends, items, calendarById, onOpenMonth, onAdd }: { year: number; weekStart: 0 | 1; hideWeekends: boolean; items: CalendarItem[]; calendarById: Map<string, CalendarDefinition>; onOpenMonth: (date: Date) => void; onAdd: (request: EditorRequest) => void }) {
  return <section className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-px bg-border/50 p-px">{Array.from({ length: 12 }, (_, month) => {
    const anchor = new Date(year, month, 1);
    const days = calendarMonthGrid(anchor, weekStart).filter((day) => !hideWeekends || (day.getDay() !== 0 && day.getDay() !== 6));
    return <div key={month} className="bg-background p-3"><button type="button" className="mb-2 text-xs font-semibold hover:text-primary" onClick={() => onOpenMonth(anchor)}>{new Intl.DateTimeFormat(undefined, { month: 'long' }).format(anchor)}</button><div className="grid gap-y-1" style={{ gridTemplateColumns: `repeat(${hideWeekends ? 5 : 7}, minmax(0, 1fr))` }}>{days.map((day) => {
      const key = calendarDateKey(day);
      const colors = Array.from(new Set(items.filter((item) => itemOccursOn(item, day)).map((item) => calendarById.get(item.calendarId)?.color).filter(Boolean))).slice(0, 3);
      return <DateContextMenu key={key} date={key} onAdd={onAdd}><button type="button" onDoubleClick={() => onOpenMonth(day)} className={cn('relative h-7 text-[10px] hover:bg-accent', day.getMonth() !== month && 'text-muted-foreground/35', key === calendarDateKey(new Date()) && 'rounded-full bg-primary text-primary-foreground')}><span>{day.getDate()}</span>{colors.length > 0 && <span className="absolute bottom-0.5 left-1/2 flex -translate-x-1/2 gap-0.5">{colors.map((color) => <span key={color} className="size-1 rounded-full" style={{ backgroundColor: color }} />)}</span>}</button></DateContextMenu>;
    })}</div></div>;
  })}</section>;
}

function ItemChip({ item, color, onEdit, onDelete, showTime = false, draggable = false, dragDateKey }: { item: CalendarItem; color?: string; onEdit: (item: CalendarItem) => void; onDelete: (item: CalendarItem) => void; showTime?: boolean; draggable?: boolean; dragDateKey?: string }) {
  return <ItemContextMenu item={item} onEdit={onEdit} onDelete={onDelete}><button
    type="button"
    draggable={draggable}
    onDragStart={draggable ? (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(CALENDAR_ALL_DAY_ITEM_DRAG_TYPE, JSON.stringify({
        itemId: item.id,
        sourceDateKey: dragDateKey ?? itemDate(item),
      }));
      event.dataTransfer.setData('text/plain', item.title);
      setCompactCalendarDragImage(event.dataTransfer, event.currentTarget);
    } : undefined}
    onClick={(event) => { event.stopPropagation(); onEdit(item); }}
    className={cn('flex w-full min-w-0 items-center gap-1 truncate rounded-sm bg-muted/75 px-1 py-0.5 text-left text-[10px] hover:bg-accent', draggable && 'cursor-grab active:cursor-grabbing')}
  ><span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} /><ItemTypeIcon item={item} className="size-2.5 shrink-0" /><span className="truncate">{showTime && `${itemTime(item)} `}{item.title}</span></button></ItemContextMenu>;
}

function AgendaItem({ item, color, onEdit, onDelete }: { item: CalendarItem; color?: string; onEdit: (item: CalendarItem) => void; onDelete: (item: CalendarItem) => void }) {
  return <ItemContextMenu item={item} onEdit={onEdit} onDelete={onDelete}><button type="button" onClick={() => onEdit(item)} className="flex w-full items-center gap-3 border-l-2 px-3 py-2 text-left hover:bg-accent/40" style={{ borderColor: color }}><span className="w-16 shrink-0 text-xs text-muted-foreground">{itemTime(item)}</span><ItemTypeIcon item={item} className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span><span className="text-[10px] uppercase text-muted-foreground">{item.kind}</span></button></ItemContextMenu>;
}

function AgendaPanel({ day, items, calendarById, onEdit, onDelete }: { day: Date; items: CalendarItem[]; calendarById: Map<string, CalendarDefinition>; onEdit: (item: CalendarItem) => void; onDelete: (item: CalendarItem) => void }) {
  return <aside className="min-h-0 overflow-y-auto border-l border-border/60 p-3"><div className="mb-3 text-xs font-semibold">{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(day)}</div><div className="space-y-1">{items.map((item) => <AgendaItem key={item.id} item={item} color={calendarById.get(item.calendarId)?.color} onEdit={onEdit} onDelete={onDelete} />)}{items.length === 0 && <div className="py-6 text-center text-xs text-muted-foreground">No entries</div>}</div></aside>;
}

function calendarOrigin(calendar: CalendarDefinition): string {
  if (calendar.location.kind === 'local') return 'Local';
  if (calendar.location.kind === 'hosted') return new URL(calendar.location.serverUrl).host;
  if (calendar.location.kind === 'subscription') return 'Subscription';
  return 'Kanban';
}

function CalendarPicker({ calendars, value, onValueChange }: { calendars: CalendarDefinition[]; value: string; onValueChange: (value: string) => void }) {
  const selected = calendars.find((calendar) => calendar.id === value);
  return <Select value={value} onValueChange={onValueChange}><SelectTrigger className="w-full">{selected ? <span className="flex min-w-0 items-center gap-2"><span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: selected.color }} /><span className="truncate">{selected.name}</span><span className="ml-auto text-[10px] text-muted-foreground">{calendarOrigin(selected)}</span></span> : <SelectValue placeholder="Choose calendar" />}</SelectTrigger><SelectContent position="popper" className="min-w-[var(--radix-select-trigger-width)]">{calendars.map((calendar) => <SelectItem key={calendar.id} value={calendar.id}><span className="size-2.5 rounded-full" style={{ backgroundColor: calendar.color }} /><span>{calendar.name}</span><span className="ml-auto text-[10px] text-muted-foreground">{calendarOrigin(calendar)}</span></SelectItem>)}</SelectContent></Select>;
}

const REMINDER_OPTIONS = [
  { value: 0, label: 'At start time' },
  { value: 10, label: '10 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
  { value: 1_440, label: '1 day before' },
  { value: 10_080, label: '1 week before' },
];

function ReminderEditor({ values, onChange }: { values: number[]; onChange: (values: number[]) => void }) {
  const [draft, setDraft] = useState('10');
  const [customAmount, setCustomAmount] = useState('2');
  const [customUnit, setCustomUnit] = useState<'minutes' | 'hours' | 'days' | 'weeks'>('hours');
  const multiplier = customUnit === 'minutes' ? 1 : customUnit === 'hours' ? 60 : customUnit === 'days' ? 1_440 : 10_080;
  const selectedMinutes = draft === 'custom' ? Math.max(1, Number(customAmount) || 1) * multiplier : Number(draft);
  return <div className="space-y-1.5"><span className="text-xs font-medium">Reminders</span>{values.map((minutes) => <div key={minutes} className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1 text-xs"><Bell className="size-3 text-muted-foreground" /><span className="flex-1">{REMINDER_OPTIONS.find((option) => option.value === minutes)?.label ?? `${minutes} minutes before`}</span><Button type="button" variant="ghost" size="icon-xs" aria-label="Remove reminder" onClick={() => onChange(values.filter((value) => value !== minutes))}><Trash2 /></Button></div>)}<div className="flex gap-2"><Select value={draft} onValueChange={setDraft}><SelectTrigger className="flex-1"><SelectValue /></SelectTrigger><SelectContent>{REMINDER_OPTIONS.map((option) => <SelectItem key={option.value} value={String(option.value)}>{option.label}</SelectItem>)}<SelectItem value="custom">Custom...</SelectItem></SelectContent></Select><Button type="button" variant="outline" size="sm" disabled={values.includes(selectedMinutes)} onClick={() => onChange([...values, selectedMinutes].sort((left, right) => left - right))}>Add</Button></div>{draft === 'custom' && <div className="grid grid-cols-[1fr_1.4fr] gap-2"><Input type="number" min={1} max={10_000} value={customAmount} onChange={(event) => setCustomAmount(event.target.value)} aria-label="Custom reminder amount" /><Select value={customUnit} onValueChange={(value) => setCustomUnit(value as typeof customUnit)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="minutes">Minutes before</SelectItem><SelectItem value="hours">Hours before</SelectItem><SelectItem value="days">Days before</SelectItem><SelectItem value="weeks">Weeks before</SelectItem></SelectContent></Select></div>}</div>;
}

export function ItemEditorDialog({ request, onOpenChange, calendars, saving, onSave }: { request: EditorRequest | null; onOpenChange: (open: boolean) => void; calendars: CalendarDefinition[]; saving: boolean; onSave: (item: CalendarItem, scope?: CalendarRecurrenceEditScope) => Promise<CalendarItem> }) {
  const timeFormat = useUiStore((state) => state.timeFormat);
  const defaultDurationMinutes = useUiStore((state) => state.calendarDefaultDurationMinutes);
  const defaultReminderMinutes = useUiStore((state) => state.calendarDefaultReminderMinutes);
  const defaultCalendarId = calendars[0]?.id ?? '';
  const [title, setTitle] = useState('');
  const [calendarId, setCalendarId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [attendees, setAttendees] = useState<CalendarAttendee[]>([]);
  const [attachments, setAttachments] = useState<CalendarAttachment[]>([]);
  const [relativeReminders, setRelativeReminders] = useState<number[]>([]);
  const [repeat, setRepeat] = useState<RecurrencePreset>('none');
  const [customRecurrence, setCustomRecurrence] = useState('FREQ=WEEKLY;INTERVAL=2');
  const [editScope, setEditScope] = useState<CalendarRecurrenceEditScope>('occurrence');
  const [taskStatus, setTaskStatus] = useState<CalendarTaskStatus>('needs-action');
  const [taskPriority, setTaskPriority] = useState<CalendarTaskPriority | 'none'>('none');
  useEffect(() => {
    if (!request) return;
    const item = request.item;
    setTitle(item?.title ?? '');
    setCalendarId(item?.calendarId ?? defaultCalendarId);
    setDescription(item?.description ?? '');
    setAttendees(item?.attendees ?? []);
    setAttachments(item?.attachments ?? []);
    setRelativeReminders((item?.reminders ?? []).flatMap((reminder) => reminder.kind === 'relative' ? [reminder.minutesBefore] : []));
    const preset = recurrencePreset(item?.recurrence?.rrule);
    setRepeat(preset);
    if (preset === 'custom' && item?.recurrence?.rrule) setCustomRecurrence(item.recurrence.rrule);
    setEditScope(item?.recurrenceId ? 'occurrence' : 'series');
    if (item?.kind === 'event') {
      const eventAllDay = item.start.kind === 'date';
      setAllDay(eventAllDay);
      setStartDate(item.start.kind === 'date' ? item.start.date : calendarDateKey(new Date(item.start.dateTime)));
      setEndDate(eventAllDay ? calendarDateKey(addDays(dateFromKey(item.end.kind === 'date' ? item.end.date : request.date), -1)) : calendarDateKey(new Date(item.end.kind === 'dateTime' ? item.end.dateTime : request.date)));
      if (item.start.kind === 'dateTime') setStartTime(new Date(item.start.dateTime).toTimeString().slice(0, 5));
      if (item.end.kind === 'dateTime') setEndTime(new Date(item.end.dateTime).toTimeString().slice(0, 5));
      setLocation(item.location?.label ?? '');
    } else if (item?.kind === 'task') {
      const start = item.start ?? item.due;
      const due = item.due ?? item.start;
      const taskAllDay = (start?.kind ?? due?.kind) !== 'dateTime';
      setAllDay(taskAllDay);
      setStartDate(start?.kind === 'date' ? start.date : start?.kind === 'dateTime' ? calendarDateKey(new Date(start.dateTime)) : request.date);
      setEndDate(due?.kind === 'date' ? due.date : due?.kind === 'dateTime' ? calendarDateKey(new Date(due.dateTime)) : request.date);
      if (start?.kind === 'dateTime') setStartTime(new Date(start.dateTime).toTimeString().slice(0, 5));
      if (due?.kind === 'dateTime') setEndTime(new Date(due.dateTime).toTimeString().slice(0, 5));
      setTaskStatus(item.status);
      setTaskPriority(item.priority ?? 'none');
      setLocation('');
    } else {
      setAllDay(false);
      setStartDate(item?.kind === 'birthday' ? item.date : request.date);
      setEndDate(request.date);
      setLocation('');
    }
    if (!item) {
      setAllDay(false);
      setStartDate(request.date);
      setEndDate(request.date);
      const initialTime = request.initialTime ?? '09:00';
      const initialEnd = addMinutesToTime(initialTime, defaultDurationMinutes);
      setStartTime(initialTime);
      setEndTime(initialEnd.time);
      setEndDate(calendarDateKey(addDays(dateFromKey(request.date), initialEnd.dayOffset)));
      setDescription('');
      setLocation('');
      setAttendees([]);
      setAttachments([]);
      setRelativeReminders(defaultReminderMinutes === null ? [] : [defaultReminderMinutes]);
      setRepeat('none');
      setEditScope('series');
      setTaskStatus('needs-action');
      setTaskPriority('none');
    }
  }, [defaultCalendarId, defaultDurationMinutes, defaultReminderMinutes, request]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!request || !title.trim() || !calendarId) return;
    const now = new Date().toISOString();
    const id = request.item?.id ?? crypto.randomUUID();
    const preservedAbsoluteReminders = request.item?.reminders.filter((reminder) => reminder.kind === 'absolute') ?? [];
    const recurrenceRule = RECURRENCE_PRESETS.find((preset) => preset.value === repeat)?.rule;
    const recurrence = repeat === 'none'
      ? undefined
      : { rrule: repeat === 'custom' ? customRecurrence.trim() : recurrenceRule! };
    const base = { id, uid: request.item?.uid ?? `${id}@collab.local`, calendarId, title: title.trim(), description: description.trim() || undefined, url: request.item?.url, attendees, attachments, reminders: [...relativeReminders.map((minutesBefore) => ({ kind: 'relative' as const, minutesBefore })), ...preservedAbsoluteReminders], recurrence, recurrenceId: request.item?.recurrenceId, recurrenceSeriesId: request.item?.recurrenceSeriesId, sourceBinding: request.item?.sourceBinding, revision: request.item?.revision ?? 0, createdAt: request.item?.createdAt ?? now, updatedAt: now };
    const calendar = calendars.find((entry) => entry.id === calendarId);
    const timeZone = calendar?.defaultTimeZone ?? 'UTC';
    const startValue = allDay ? { kind: 'date' as const, date: startDate } : { kind: 'dateTime' as const, dateTime: new Date(`${startDate}T${startTime}`).toISOString(), timeZone };
    const endValue = allDay ? { kind: 'date' as const, date: request.kind === 'event' ? nextDateKey(endDate) : endDate } : { kind: 'dateTime' as const, dateTime: new Date(`${endDate}T${endTime}`).toISOString(), timeZone };
    const item = request.kind === 'event'
      ? normalizeCalendarItem({ ...base, kind: 'event', start: startValue, end: endValue, location: location.trim() ? { label: location.trim() } : undefined, availability: request.item?.kind === 'event' ? request.item.availability : 'busy' })
      : request.kind === 'task'
        ? normalizeCalendarItem({ ...base, kind: 'task', start: startValue, due: endValue, status: taskStatus, priority: taskPriority === 'none' ? undefined : taskPriority, completedAt: taskStatus === 'completed' ? (request.item?.kind === 'task' ? request.item.completedAt : undefined) ?? now : undefined })
        : normalizeCalendarItem({ ...base, kind: 'birthday', date: startDate, birthYear: request.item?.kind === 'birthday' ? request.item.birthYear : undefined });
    await onSave(item, request.item?.recurrenceId ? editScope : 'series');
    onOpenChange(false);
  };

  const updateStartTime = (value: string) => {
    setStartTime(value);
    const next = addMinutesToTime(value, defaultDurationMinutes);
    setEndTime(next.time);
    if (startDate) setEndDate(calendarDateKey(addDays(dateFromKey(startDate), next.dayOffset)));
  };

  const kindLabel = request?.kind === 'birthday' ? 'birthday' : request?.kind ?? 'event';
  const isScheduled = request?.kind === 'event' || request?.kind === 'task';
  const selectedCalendar = calendars.find((calendar) => calendar.id === calendarId);
  const updateCalendarId = (nextCalendarId: string) => {
    const nextCalendar = calendars.find((calendar) => calendar.id === nextCalendarId);
    const currentServer = selectedCalendar?.location.kind === 'hosted' ? selectedCalendar.location.serverUrl : null;
    const nextServer = nextCalendar?.location.kind === 'hosted' ? nextCalendar.location.serverUrl : null;
    if (currentServer !== nextServer) setAttendees([]);
    setCalendarId(nextCalendarId);
  };
  return <Dialog open={request != null} onOpenChange={onOpenChange}><DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{request?.item ? `Edit ${kindLabel}` : `New ${kindLabel}`}</DialogTitle></DialogHeader><form id="calendar-item-form" className="space-y-4" onSubmit={(event) => void submit(event)}><label className="block space-y-1"><span className="text-xs font-medium">Title</span><Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} required /></label><label className="block space-y-1"><span className="text-xs font-medium">Calendar</span><CalendarPicker calendars={calendars} value={calendarId} onValueChange={updateCalendarId} /></label>{request?.kind === 'task' && <div className="grid grid-cols-2 gap-2"><label className="block space-y-1"><span className="text-xs font-medium">Status</span><Select value={taskStatus} onValueChange={(value) => setTaskStatus(value as CalendarTaskStatus)}><SelectTrigger aria-label="Task status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="needs-action">Needs action</SelectItem><SelectItem value="in-progress">In progress</SelectItem><SelectItem value="completed">Completed</SelectItem><SelectItem value="cancelled">Cancelled</SelectItem></SelectContent></Select></label><label className="block space-y-1"><span className="text-xs font-medium">Priority</span><Select value={taskPriority} onValueChange={(value) => setTaskPriority(value as CalendarTaskPriority | 'none')}><SelectTrigger aria-label="Task priority"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No priority</SelectItem><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem></SelectContent></Select></label></div>}{isScheduled ? <><div className="flex items-center gap-2"><Checkbox id="calendar-item-all-day" checked={allDay} onCheckedChange={(checked) => setAllDay(checked === true)} /><label htmlFor="calendar-item-all-day" className="cursor-pointer text-xs font-medium">All day</label></div><div className="grid grid-cols-2 gap-2"><DatePicker label={request?.kind === 'task' ? 'Starts' : 'Start date'} value={startDate} onChange={setStartDate} /><DatePicker label={request?.kind === 'task' ? 'Deadline' : 'End date'} value={endDate} min={startDate} onChange={setEndDate} /></div>{!allDay && <div className="grid grid-cols-2 gap-2"><TimePicker label="Start time" value={startTime} onChange={updateStartTime} format={timeFormat} /><TimePicker label={request?.kind === 'task' ? 'Deadline time' : 'End time'} value={endTime} onChange={setEndTime} format={timeFormat} /></div>}<label className="block space-y-1"><span className="text-xs font-medium">Repeats</span><Select value={repeat} onValueChange={(value) => setRepeat(value as RecurrencePreset)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{RECURRENCE_PRESETS.map((preset) => <SelectItem key={preset.value} value={preset.value}>{preset.label}</SelectItem>)}</SelectContent></Select></label>{repeat === 'custom' && <label className="block space-y-1"><span className="text-xs font-medium">Recurrence rule</span><Input value={customRecurrence} onChange={(event) => setCustomRecurrence(event.target.value)} placeholder="FREQ=WEEKLY;INTERVAL=2" /></label>}{request?.item?.recurrenceId && <label className="block space-y-1"><span className="text-xs font-medium">Apply changes to</span><Select value={editScope} onValueChange={(value) => setEditScope(value as CalendarRecurrenceEditScope)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="occurrence">This occurrence</SelectItem><SelectItem value="following">This and following occurrences</SelectItem><SelectItem value="series">Entire series</SelectItem></SelectContent></Select></label>}</> : <DatePicker label="Birthday" value={startDate} onChange={setStartDate} />}{request?.kind === 'event' && <label className="block space-y-1"><span className="text-xs font-medium">Location</span><div className="relative"><MapPin className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input className="pl-8" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Add a place or address" /></div></label>}{request?.kind !== 'birthday' && <label className="block space-y-1"><span className="text-xs font-medium">Description</span><Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add details" rows={4} /></label>}{request?.kind === 'event' && <CalendarAttendeeEditor calendar={selectedCalendar} attendees={attendees} onChange={setAttendees} />}{request?.kind !== 'birthday' && <CalendarAttachmentEditor calendar={selectedCalendar} attachments={attachments} onChange={setAttachments} />}<ReminderEditor values={relativeReminders} onChange={setRelativeReminders} /></form><DialogFooter><Button type="submit" form="calendar-item-form" disabled={saving || !title.trim() || !calendarId || !startDate || (isScheduled && (!endDate || (repeat === 'custom' && !customRecurrence.trim())))}>{saving ? 'Saving...' : request?.item ? 'Save' : 'Create'}</Button></DialogFooter></DialogContent></Dialog>;
}

export function CalendarSettingsDialog({ calendar, saving, onOpenChange, onSave }: {
  calendar: CalendarDefinition | null;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (
    calendarId: string,
    changes: Pick<CalendarDefinition, 'name' | 'color'>,
  ) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(CALENDAR_COLORS[1]);
  useEffect(() => {
    if (!calendar) return;
    setName(calendar.name);
    setColor(calendar.color);
  }, [calendar]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!calendar || !name.trim()) return;
    try {
      await onSave(calendar.id, {
        name: name.trim(),
        color,
      });
    } catch {
      // The calendar store exposes the actionable persistence error in the page banner.
    }
  };
  return <Dialog open={calendar != null} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-sm"><DialogHeader><DialogTitle>Calendar settings</DialogTitle></DialogHeader>
    <form id="calendar-settings-form" className="space-y-4" onSubmit={(event) => void submit(event)}>
      <div className="rounded-md bg-muted/45 px-2.5 py-2 text-xs text-muted-foreground"><span className="font-medium text-foreground">{calendar ? calendarOrigin(calendar) : ''}</span>{calendar?.location.kind === 'hosted' ? ' calendar settings sync through its server.' : ' calendar stored in this profile.'}</div>
      <label className="block space-y-1"><span className="text-xs font-medium">Name</span><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>
      <fieldset className="space-y-2"><legend className="text-xs font-medium">Accent color</legend><div className="flex flex-wrap gap-2">{CALENDAR_COLORS.map((value) => <button key={value} type="button" aria-label={`Use color ${value}`} aria-pressed={color === value} onClick={() => setColor(value)} className={cn('size-7 rounded-full', color === value && 'ring-2 ring-foreground ring-offset-2 ring-offset-background')} style={{ backgroundColor: value }} />)}</div></fieldset>
    </form>
    <DialogFooter><Button type="submit" form="calendar-settings-form" disabled={saving || !calendar || !name.trim()}>{saving ? 'Saving...' : 'Save changes'}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function CalendarDialog({ open, onOpenChange, saving, locations, onCreate }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saving: boolean;
  locations: Array<{ value: string; label: string; location: CalendarLocation }>;
  onCreate: (name: string, color: string, location?: CalendarLocation) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(CALENDAR_COLORS[1]);
  const [locationKey, setLocationKey] = useState('local');
  const submit = async (event: React.FormEvent) => { event.preventDefault(); if (!name.trim()) return; const target = locations.find((entry) => entry.value === locationKey) ?? locations[0]; await onCreate(name.trim(), color, target?.location); setName(''); onOpenChange(false); };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-sm"><DialogHeader><DialogTitle>New calendar</DialogTitle></DialogHeader><form id="new-calendar-form" className="space-y-3" onSubmit={(event) => void submit(event)}><label className="block space-y-1"><span className="text-xs font-medium">Name</span><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} required /></label><label className="block space-y-1"><span className="text-xs font-medium">Location</span><Select value={locationKey} onValueChange={setLocationKey}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{locations.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}</SelectContent></Select></label><div className="flex gap-2">{CALENDAR_COLORS.map((value) => <button key={value} type="button" aria-label={`Use color ${value}`} onClick={() => setColor(value)} className={cn('size-6 rounded-full', color === value && 'ring-2 ring-foreground ring-offset-2 ring-offset-background')} style={{ backgroundColor: value }} />)}</div></form><DialogFooter><Button type="submit" form="new-calendar-form" disabled={saving || !name.trim()}>{saving ? 'Saving...' : 'Create'}</Button></DialogFooter></DialogContent></Dialog>;
}
