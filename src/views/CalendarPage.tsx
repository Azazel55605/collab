import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  ClipboardCheck,
  Gift,
  Bell,
  LoaderCircle,
  MapPin,
  Pencil,
  Plus,
  SquareKanban,
  Trash2,
} from 'lucide-react';
import { Button } from '../components/ui/button';
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
import { cn } from '../lib/utils';
import { useCalendarStore } from '../store/calendarStore';
import { useCollabStore } from '../store/collabStore';
import { useServerStore } from '../store/serverStore';
import { formatTime, useUiStore } from '../store/uiStore';
import {
  calendarItemRange,
  normalizeCalendarItem,
  type CalendarDefinition,
  type CalendarItem,
  type CalendarItemKind,
  type CalendarLocation,
} from '../types/calendar';

type CalendarViewMode = 'month' | 'week' | 'agenda' | 'year';
type EditorRequest = { date: string; kind: CalendarItemKind; item?: CalendarItem };

const DAY_MS = 86_400_000;
const HORIZONTAL_GESTURE_THRESHOLD = 90;
const HORIZONTAL_GESTURE_SETTLE_MS = 180;
const CALENDAR_COLORS = ['#a78bfa', '#60a5fa', '#34d399', '#fb7185', '#fb923c', '#22d3ee'];
const VIEW_MODES: Array<{ value: CalendarViewMode; label: string }> = [
  { value: 'month', label: 'Month' },
  { value: 'week', label: 'Week' },
  { value: 'agenda', label: 'Agenda' },
  { value: 'year', label: 'Year' },
];

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
  const serverConnections = useServerStore((state) => state.connections);
  const store = useCalendarStore();
  const [rootRef, rootWidth] = useElementWidth<HTMLDivElement>();
  const [viewMode, setViewMode] = useState<CalendarViewMode>('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => calendarDateKey(new Date()));
  const [editorRequest, setEditorRequest] = useState<EditorRequest | null>(null);
  const [calendarDialogOpen, setCalendarDialogOpen] = useState(false);
  const [periodTransition, setPeriodTransition] = useState<{ direction: -1 | 1; sequence: number }>({ direction: 1, sequence: 0 });
  const horizontalGestureDelta = useRef(0);
  const horizontalGestureLocked = useRef(false);
  const horizontalGestureReset = useRef<number | null>(null);

  const monthDays = useMemo(() => calendarMonthGrid(anchor, weekStart), [anchor, weekStart]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(startOfWeek(anchor, weekStart), index)), [anchor, weekStart]);
  const range = useMemo(() => {
    if (viewMode === 'year') return { from: `${anchor.getFullYear()}-01-01`, to: `${anchor.getFullYear() + 1}-01-01` };
    if (viewMode === 'week') return { from: calendarDateKey(weekDays[0]), to: calendarDateKey(addDays(weekDays[6], 1)) };
    if (viewMode === 'agenda') return { from: selectedDate, to: nextDateKey(selectedDate) };
    return { from: calendarDateKey(monthDays[0]), to: calendarDateKey(addDays(monthDays[41], 1)) };
  }, [anchor, monthDays, selectedDate, viewMode, weekDays]);

  useEffect(() => { void store.initialize(profileId); }, [profileId, store.initialize]);
  useEffect(() => {
    if (store.profileId === profileId && store.calendars.length > 0) {
      void store.loadRange(range.from, range.to);
    }
  }, [profileId, range.from, range.to, store.calendars.length, store.loadRange, store.profileId]);
  useEffect(() => () => {
    if (horizontalGestureReset.current != null) window.clearTimeout(horizontalGestureReset.current);
  }, []);

  const visibleItems = useMemo(
    () => store.items.filter((item) => store.visibleCalendarIds.includes(item.calendarId)),
    [store.items, store.visibleCalendarIds],
  );
  const calendarById = useMemo(() => new Map(store.calendars.map((calendar) => [calendar.id, calendar])), [store.calendars]);
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
    if (viewMode === 'month') setAnchor((current) => new Date(current.getFullYear(), current.getMonth() + direction, 1));
    else if (viewMode === 'year') setAnchor((current) => new Date(current.getFullYear() + direction, current.getMonth(), 1));
    else {
      const amount = viewMode === 'week' ? 7 : 1;
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
        <div className="flex rounded-md border border-border bg-muted/30 p-0.5">
          {VIEW_MODES.map((mode) => (
            <button key={mode.value} type="button" onClick={() => setViewMode(mode.value)} className={cn('h-6 rounded px-2 text-[11px] text-muted-foreground', viewMode === mode.value && 'bg-background text-foreground shadow-sm')}>
              {mode.label}
            </button>
          ))}
        </div>
        {store.loading && <LoaderCircle className="size-4 animate-spin text-muted-foreground" />}
        <Button size="sm" onClick={() => openEditor({ date: selectedDate, kind: 'event' })} disabled={store.calendars.length === 0}><Plus /> New</Button>
      </header>

      {store.error && <button type="button" className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-left text-xs text-destructive" onClick={store.clearError}>{store.error}</button>}

      <div className="flex min-h-0 flex-1">
        {showCalendarRail && <CalendarRail calendars={store.calendars} visibleIds={store.visibleCalendarIds} onVisible={store.setCalendarVisible} onAdd={() => setCalendarDialogOpen(true)} />}
        <main className={cn('grid min-h-0 min-w-0 flex-1', showMonthAgenda && 'grid-cols-[minmax(0,1fr)_240px]')}>
          <div className="h-full min-h-0 min-w-0 overflow-auto overscroll-contain" onWheel={handleWheel}>
            <div key={periodTransition.sequence} className={cn('h-full min-h-0', periodTransition.sequence > 0 && 'calendar-period-transition', periodTransition.direction > 0 ? 'calendar-period-transition-next' : 'calendar-period-transition-previous')}>
              {viewMode === 'month' && <MonthView anchor={anchor} days={monthDays} weekStart={weekStart} items={visibleItems} calendarById={calendarById} selectedDate={selectedDate} onSelect={setSelectedDate} onAdd={openEditor} onEdit={editItem} onDelete={(item) => void store.deleteItem(item)} />}
              {viewMode === 'week' && <WeekView days={weekDays} items={visibleItems} calendarById={calendarById} selectedDate={selectedDate} onSelect={setSelectedDate} onAdd={openEditor} onEdit={editItem} onDelete={(item) => void store.deleteItem(item)} />}
              {viewMode === 'agenda' && <AgendaView day={selectedDay} items={selectedItems} calendarById={calendarById} onAdd={openEditor} onEdit={editItem} onDelete={(item) => void store.deleteItem(item)} />}
              {viewMode === 'year' && <YearView year={anchor.getFullYear()} weekStart={weekStart} items={visibleItems} calendarById={calendarById} onOpenMonth={(date) => { setAnchor(date); setSelectedDate(calendarDateKey(date)); setViewMode('month'); }} onAdd={openEditor} />}
            </div>
          </div>
          {showMonthAgenda && <AgendaPanel day={selectedDay} items={selectedItems} calendarById={calendarById} onEdit={editItem} onDelete={(item) => void store.deleteItem(item)} />}
        </main>
      </div>

      <ItemEditorDialog request={editorRequest} onOpenChange={(open) => !open && setEditorRequest(null)} calendars={store.calendars.filter((calendar) => !calendar.archived && !calendar.readOnly)} saving={store.saving} onSave={store.saveItem} />
      <CalendarDialog open={calendarDialogOpen} onOpenChange={setCalendarDialogOpen} saving={store.saving} locations={calendarLocations} onCreate={store.createCalendar} />
    </div>
  );
}

function viewTitle(mode: CalendarViewMode, anchor: Date, selected: Date, weekDays: Date[]): string {
  if (mode === 'year') return String(anchor.getFullYear());
  if (mode === 'agenda') return new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(selected);
  if (mode === 'week') {
    const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    return `${format.format(weekDays[0])} - ${format.format(weekDays[6])}`;
  }
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(anchor);
}

function CalendarRail({ calendars, visibleIds, onVisible, onAdd }: {
  calendars: CalendarDefinition[];
  visibleIds: string[];
  onVisible: (id: string, visible: boolean) => void;
  onAdd: () => void;
}) {
  return <aside className="flex w-44 shrink-0 flex-col border-r border-border/60 bg-sidebar/40 p-3">
    <div className="mb-2 flex items-center justify-between"><span className="text-[10px] font-semibold uppercase text-muted-foreground">Calendars</span><Button variant="ghost" size="icon-xs" aria-label="Add calendar" onClick={onAdd}><CirclePlus /></Button></div>
    <div className="space-y-1 overflow-y-auto">{calendars.filter((calendar) => !calendar.archived).map((calendar) => {
      const checkboxId = `calendar-visible-${calendar.id}`;
      return <div key={calendar.id} className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-xs hover:bg-accent/60"><Checkbox id={checkboxId} checked={visibleIds.includes(calendar.id)} onCheckedChange={(checked) => onVisible(calendar.id, checked === true)} /><label htmlFor={checkboxId} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"><span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: calendar.color }} /><span className="truncate">{calendar.name}</span></label></div>;
    })}</div>
  </aside>;
}

interface ViewProps {
  items: CalendarItem[];
  calendarById: Map<string, CalendarDefinition>;
  onAdd: (request: EditorRequest) => void;
  onEdit: (item: CalendarItem) => void;
  onDelete: (item: CalendarItem) => void;
}

function MonthView({ anchor, days, weekStart, items, calendarById, selectedDate, onSelect, onAdd, onEdit, onDelete }: ViewProps & { anchor: Date; days: Date[]; weekStart: 0 | 1; selectedDate: string; onSelect: (date: string) => void }) {
  const labels = Array.from({ length: 7 }, (_, index) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2026, 6, 5 + ((weekStart + index) % 7))));
  return <section className="grid h-full min-h-[570px] grid-rows-[28px_repeat(6,minmax(90px,1fr))] overflow-hidden">
    <div className="grid grid-cols-7 border-b border-border/60">{labels.map((label) => <div key={label} className="px-2 py-1 text-right text-[10px] font-medium uppercase text-muted-foreground">{label}</div>)}</div>
    {Array.from({ length: 6 }, (_, row) => <div key={row} className="grid min-h-0 grid-cols-7">{days.slice(row * 7, row * 7 + 7).map((day) => {
      const key = calendarDateKey(day);
      const dayItems = items.filter((item) => itemOccursOn(item, day));
      return <DateContextMenu key={key} date={key} onAdd={onAdd}><div role="button" tabIndex={0} onClick={() => onSelect(key)} onKeyDown={(event) => event.key === 'Enter' && onSelect(key)} className={cn('min-h-0 overflow-hidden border-b border-r border-border/50 p-1 text-left hover:bg-accent/30', day.getMonth() !== anchor.getMonth() && 'bg-muted/10 text-muted-foreground/60', key === selectedDate && 'bg-primary/5 ring-1 ring-inset ring-primary/40')}>
        <span className={cn('ml-auto flex size-5 items-center justify-center rounded-full text-[11px]', key === calendarDateKey(new Date()) && 'bg-primary font-semibold text-primary-foreground')}>{day.getDate()}</span>
        <div className="mt-0.5 space-y-0.5">{dayItems.slice(0, 4).map((item) => <ItemChip key={item.id} item={item} color={calendarById.get(item.calendarId)?.color} onEdit={onEdit} onDelete={onDelete} />)}{dayItems.length > 4 && <div className="px-1 text-[9px] text-muted-foreground">+{dayItems.length - 4}</div>}</div>
      </div></DateContextMenu>;
    })}</div>)}
  </section>;
}

function WeekView({ days, items, calendarById, selectedDate, onSelect, onAdd, onEdit, onDelete }: ViewProps & { days: Date[]; selectedDate: string; onSelect: (date: string) => void }) {
  return <section className="grid min-h-full min-w-[700px] grid-cols-7">{days.map((day) => {
    const key = calendarDateKey(day);
    const dayItems = items.filter((item) => itemOccursOn(item, day));
    return <DateContextMenu key={key} date={key} onAdd={onAdd}><div role="button" tabIndex={0} onClick={() => onSelect(key)} className={cn('min-h-full border-r border-border/60 p-2', selectedDate === key && 'bg-primary/5')}>
      <div className="mb-3 text-center"><div className="text-[10px] uppercase text-muted-foreground">{new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(day)}</div><div className={cn('mx-auto mt-1 flex size-7 items-center justify-center rounded-full text-sm', key === calendarDateKey(new Date()) && 'bg-primary text-primary-foreground')}>{day.getDate()}</div></div>
      <div className="space-y-1">{dayItems.map((item) => <ItemChip key={item.id} item={item} color={calendarById.get(item.calendarId)?.color} onEdit={onEdit} onDelete={onDelete} showTime />)}</div>
    </div></DateContextMenu>;
  })}</section>;
}

function AgendaView({ day, items, calendarById, onAdd, onEdit, onDelete }: ViewProps & { day: Date }) {
  const key = calendarDateKey(day);
  return <DateContextMenu date={key} onAdd={onAdd}><section className="mx-auto min-h-full w-full max-w-3xl px-5 py-4"><div className="mb-5 border-b border-border/60 pb-3"><div className="text-xs uppercase text-muted-foreground">{new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(day)}</div><div className="text-xl font-semibold">{new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(day)}</div></div><div className="space-y-2">{items.map((item) => <AgendaItem key={item.id} item={item} color={calendarById.get(item.calendarId)?.color} onEdit={onEdit} onDelete={onDelete} />)}{items.length === 0 && <div className="py-12 text-center text-sm text-muted-foreground">No entries</div>}</div></section></DateContextMenu>;
}

function YearView({ year, weekStart, items, calendarById, onOpenMonth, onAdd }: { year: number; weekStart: 0 | 1; items: CalendarItem[]; calendarById: Map<string, CalendarDefinition>; onOpenMonth: (date: Date) => void; onAdd: (request: EditorRequest) => void }) {
  return <section className="grid grid-cols-[repeat(auto-fit,minmax(210px,1fr))] gap-px bg-border/50 p-px">{Array.from({ length: 12 }, (_, month) => {
    const anchor = new Date(year, month, 1);
    const days = calendarMonthGrid(anchor, weekStart);
    return <div key={month} className="bg-background p-3"><button type="button" className="mb-2 text-xs font-semibold hover:text-primary" onClick={() => onOpenMonth(anchor)}>{new Intl.DateTimeFormat(undefined, { month: 'long' }).format(anchor)}</button><div className="grid grid-cols-7 gap-y-1">{days.map((day) => {
      const key = calendarDateKey(day);
      const colors = Array.from(new Set(items.filter((item) => itemOccursOn(item, day)).map((item) => calendarById.get(item.calendarId)?.color).filter(Boolean))).slice(0, 3);
      return <DateContextMenu key={key} date={key} onAdd={onAdd}><button type="button" onDoubleClick={() => onOpenMonth(day)} className={cn('relative h-7 text-[10px] hover:bg-accent', day.getMonth() !== month && 'text-muted-foreground/35', key === calendarDateKey(new Date()) && 'rounded-full bg-primary text-primary-foreground')}><span>{day.getDate()}</span>{colors.length > 0 && <span className="absolute bottom-0.5 left-1/2 flex -translate-x-1/2 gap-0.5">{colors.map((color) => <span key={color} className="size-1 rounded-full" style={{ backgroundColor: color }} />)}</span>}</button></DateContextMenu>;
    })}</div></div>;
  })}</section>;
}

function ItemChip({ item, color, onEdit, onDelete, showTime = false }: { item: CalendarItem; color?: string; onEdit: (item: CalendarItem) => void; onDelete: (item: CalendarItem) => void; showTime?: boolean }) {
  return <ItemContextMenu item={item} onEdit={onEdit} onDelete={onDelete}><button type="button" onClick={(event) => { event.stopPropagation(); onEdit(item); }} className="flex w-full min-w-0 items-center gap-1 truncate rounded-sm bg-muted/75 px-1 py-0.5 text-left text-[10px] hover:bg-accent"><span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} /><ItemTypeIcon item={item} className="size-2.5 shrink-0" /><span className="truncate">{showTime && `${itemTime(item)} `}{item.title}</span></button></ItemContextMenu>;
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

function ItemEditorDialog({ request, onOpenChange, calendars, saving, onSave }: { request: EditorRequest | null; onOpenChange: (open: boolean) => void; calendars: CalendarDefinition[]; saving: boolean; onSave: (item: CalendarItem) => Promise<CalendarItem> }) {
  const timeFormat = useUiStore((state) => state.timeFormat);
  const [title, setTitle] = useState('');
  const [calendarId, setCalendarId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [allDay, setAllDay] = useState(false);
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [relativeReminders, setRelativeReminders] = useState<number[]>([]);
  useEffect(() => {
    if (!request) return;
    const item = request.item;
    setTitle(item?.title ?? '');
    setCalendarId(item?.calendarId ?? calendars[0]?.id ?? '');
    setDescription(item?.description ?? '');
    setRelativeReminders((item?.reminders ?? []).flatMap((reminder) => reminder.kind === 'relative' ? [reminder.minutesBefore] : []));
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
      setStartTime('09:00');
      setEndTime('10:00');
      setDescription('');
      setLocation('');
      setRelativeReminders([]);
    }
  }, [calendars, request]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!request || !title.trim() || !calendarId) return;
    const now = new Date().toISOString();
    const id = request.item?.id ?? crypto.randomUUID();
    const preservedAbsoluteReminders = request.item?.reminders.filter((reminder) => reminder.kind === 'absolute') ?? [];
    const base = { id, uid: request.item?.uid ?? `${id}@collab.local`, calendarId, title: title.trim(), description: description.trim() || undefined, reminders: [...relativeReminders.map((minutesBefore) => ({ kind: 'relative' as const, minutesBefore })), ...preservedAbsoluteReminders], recurrence: request.item?.recurrence, sourceBinding: request.item?.sourceBinding, revision: request.item?.revision ?? 0, createdAt: request.item?.createdAt ?? now, updatedAt: now };
    const calendar = calendars.find((entry) => entry.id === calendarId);
    const timeZone = calendar?.defaultTimeZone ?? 'UTC';
    const startValue = allDay ? { kind: 'date' as const, date: startDate } : { kind: 'dateTime' as const, dateTime: new Date(`${startDate}T${startTime}`).toISOString(), timeZone };
    const endValue = allDay ? { kind: 'date' as const, date: request.kind === 'event' ? nextDateKey(endDate) : endDate } : { kind: 'dateTime' as const, dateTime: new Date(`${endDate}T${endTime}`).toISOString(), timeZone };
    const item = request.kind === 'event'
      ? normalizeCalendarItem({ ...base, kind: 'event', start: startValue, end: endValue, location: location.trim() ? { label: location.trim() } : undefined, availability: request.item?.kind === 'event' ? request.item.availability : 'busy' })
      : request.kind === 'task'
        ? normalizeCalendarItem({ ...base, kind: 'task', start: startValue, due: endValue, status: request.item?.kind === 'task' ? request.item.status : 'needs-action', priority: request.item?.kind === 'task' ? request.item.priority : undefined })
        : normalizeCalendarItem({ ...base, kind: 'birthday', date: startDate, birthYear: request.item?.kind === 'birthday' ? request.item.birthYear : undefined });
    await onSave(item);
    onOpenChange(false);
  };

  const updateStartTime = (value: string) => {
    setStartTime(value);
    const next = addMinutesToTime(value, 60);
    setEndTime(next.time);
    if (startDate) setEndDate(calendarDateKey(addDays(dateFromKey(startDate), next.dayOffset)));
  };

  const kindLabel = request?.kind === 'birthday' ? 'birthday' : request?.kind ?? 'event';
  const isScheduled = request?.kind === 'event' || request?.kind === 'task';
  return <Dialog open={request != null} onOpenChange={onOpenChange}><DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>{request?.item ? `Edit ${kindLabel}` : `New ${kindLabel}`}</DialogTitle></DialogHeader><form id="calendar-item-form" className="space-y-4" onSubmit={(event) => void submit(event)}><label className="block space-y-1"><span className="text-xs font-medium">Title</span><Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} required /></label><label className="block space-y-1"><span className="text-xs font-medium">Calendar</span><CalendarPicker calendars={calendars} value={calendarId} onValueChange={setCalendarId} /></label>{isScheduled ? <><div className="flex items-center gap-2"><Checkbox id="calendar-item-all-day" checked={allDay} onCheckedChange={(checked) => setAllDay(checked === true)} /><label htmlFor="calendar-item-all-day" className="cursor-pointer text-xs font-medium">All day</label></div><div className="grid grid-cols-2 gap-2"><DatePicker label={request?.kind === 'task' ? 'Starts' : 'Start date'} value={startDate} onChange={setStartDate} /><DatePicker label={request?.kind === 'task' ? 'Deadline' : 'End date'} value={endDate} min={startDate} onChange={setEndDate} /></div>{!allDay && <div className="grid grid-cols-2 gap-2"><TimePicker label="Start time" value={startTime} onChange={updateStartTime} format={timeFormat} /><TimePicker label={request?.kind === 'task' ? 'Deadline time' : 'End time'} value={endTime} onChange={setEndTime} format={timeFormat} /></div>}</> : <DatePicker label="Birthday" value={startDate} onChange={setStartDate} />}{request?.kind === 'event' && <label className="block space-y-1"><span className="text-xs font-medium">Location</span><div className="relative"><MapPin className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input className="pl-8" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Add a place or address" /></div></label>}{request?.kind !== 'birthday' && <label className="block space-y-1"><span className="text-xs font-medium">Description</span><Textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add details" rows={4} /></label>}<ReminderEditor values={relativeReminders} onChange={setRelativeReminders} /></form><DialogFooter><Button type="submit" form="calendar-item-form" disabled={saving || !title.trim() || !calendarId || !startDate || (isScheduled && !endDate)}>{saving ? 'Saving...' : request?.item ? 'Save' : 'Create'}</Button></DialogFooter></DialogContent></Dialog>;
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
