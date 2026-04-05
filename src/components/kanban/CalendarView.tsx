import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays, CalendarIcon, ChevronsUpDown, Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useKanbanContext } from '../../views/KanbanPage';
import { useUiStore, formatDate } from '../../store/uiStore';
import type { KanbanCard, KanbanColumn } from '../../types/kanban';
import CardDialog from './CardDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Calendar } from '../ui/calendar';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '../ui/dropdown-menu';

// ── Types ─────────────────────────────────────────────────────────────────────

type CalendarViewMode = '3day' | 'workweek' | 'week' | 'month' | 'year';
type CalendarSort     = 'default' | 'priority' | 'column' | 'startDate';

// ── Date helpers ──────────────────────────────────────────────────────────────

function parseLocal(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toDateOnly(ts: number): Date {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function diffDays(base: Date, target: Date): number {
  const ms = target.getTime() - base.getTime();
  return Math.round(ms / 86_400_000);
}

/** Returns the Monday (or Sunday) on or before `d`, depending on weekStartDay. */
function weekStartDate(d: Date, weekStartDay: 0 | 1): Date {
  const dow = d.getDay();
  const offset = weekStartDay === 1
    ? (dow === 0 ? -6 : 1 - dow)
    : -dow;
  return addDays(d, offset);
}

/** Weeks covering the whole month, aligned to weekStartDay (0=Sun, 1=Mon). */
function buildWeeks(year: number, month: number, weekStartDay: 0 | 1): Date[][] {
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth  = new Date(year, month + 1, 0);

  const dow = firstOfMonth.getDay();
  const startOffset = weekStartDay === 1
    ? (dow === 0 ? -6 : 1 - dow)
    : -dow;
  const gridStart = addDays(firstOfMonth, startOffset);

  const lastDow = lastOfMonth.getDay();
  const endOffset = weekStartDay === 1
    ? (lastDow === 0 ? 0 : 7 - lastDow)
    : (lastDow === 6 ? 0 : 6 - lastDow);
  const gridEnd = addDays(lastOfMonth, endOffset);

  const weeks: Date[][] = [];
  let cur = new Date(gridStart);
  while (cur <= gridEnd) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(new Date(cur));
      cur = addDays(cur, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** Build the array of day-arrays for a given view mode. */
function buildViewPeriods(
  mode: CalendarViewMode,
  anchor: Date,
  weekStartDay: 0 | 1,
): { periods: Date[][]; columnCount: number } {
  switch (mode) {
    case 'month':
      return {
        periods: buildWeeks(anchor.getFullYear(), anchor.getMonth(), weekStartDay),
        columnCount: 7,
      };
    case 'week': {
      const ws = weekStartDate(anchor, weekStartDay);
      const week: Date[] = [];
      for (let i = 0; i < 7; i++) week.push(addDays(ws, i));
      return { periods: [week], columnCount: 7 };
    }
    case 'workweek': {
      // Mon–Fri of anchor's week
      const mon = weekStartDate(anchor, 1); // always Monday
      const week: Date[] = [];
      for (let i = 0; i < 5; i++) week.push(addDays(mon, i));
      return { periods: [week], columnCount: 5 };
    }
    case '3day': {
      return { periods: [[anchor, addDays(anchor, 1), addDays(anchor, 2)]], columnCount: 3 };
    }
    case 'year':
      // Signals the year renderer; periods unused
      return { periods: [], columnCount: 0 };
  }
}

// ── Layout ────────────────────────────────────────────────────────────────────

const DAY_NUM_H         = 22;
const CARD_H            = 22;
const CARD_GAP          = 3;
const ROW_PAD           = 8;
const MAX_VISIBLE_LANES = 3;
const SHOW_MORE_H       = 20;
const ROW_H = DAY_NUM_H + MAX_VISIBLE_LANES * (CARD_H + CARD_GAP) + SHOW_MORE_H + ROW_PAD;

const PRIORITY_COLORS = {
  high:   'bg-red-300',
  medium: 'bg-yellow-300',
  low:    'bg-green-300',
} as const;

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

interface WeekCard {
  card: KanbanCard;
  columnId: string;
  colColor: string;
  colTitle: string;
  startCol: number;
  endCol: number;
  lane: number;
  clippedLeft: boolean;
  clippedRight: boolean;
}

function layoutWeek(
  week: Date[],
  cards: Array<{ card: KanbanCard; columnId: string; colColor: string; colTitle: string }>,
  getStart: (c: KanbanCard) => Date,
  getEnd:   (c: KanbanCard) => Date,
): WeekCard[] {
  const weekStart = week[0];
  const weekEnd   = week[week.length - 1]; // works for any week length (3, 5, or 7)

  const candidates = cards
    .map(({ card, columnId, colColor, colTitle }) => {
      const s = getStart(card);
      const e = getEnd(card);
      if (s > weekEnd || e < weekStart) return null;
      const startCol = Math.max(0, diffDays(weekStart, s));
      const endCol   = Math.min(week.length - 1, diffDays(weekStart, e));
      return {
        card, columnId, colColor, colTitle,
        startCol, endCol,
        clippedLeft:  s < weekStart,
        clippedRight: e > weekEnd,
        lane: 0,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.startCol - b.startCol || b.endCol - a.endCol);

  // Greedy lane assignment
  const laneEnds: number[] = [];
  for (const wc of candidates) {
    let lane = laneEnds.findIndex(end => end < wc.startCol);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(wc.endCol); }
    else { laneEnds[lane] = wc.endCol; }
    wc.lane = lane;
  }

  return candidates;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DAY_NAMES_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES_SUN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const VIEW_LABELS: Record<CalendarViewMode, string> = {
  '3day': '3D', workweek: 'W5', week: 'Wk', month: 'Mo', year: 'Yr',
};

const SORT_LABELS: Record<CalendarSort, string> = {
  default: 'Sort: Default',
  priority: 'Sort: Priority',
  column: 'Sort: Column',
  startDate: 'Sort: Start date',
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function CalendarView() {
  const { board, knownUsers } = useKanbanContext();
  const { dateFormat, weekStart } = useUiStore();

  const today = useMemo(() => toDateOnly(Date.now()), []);

  const [viewMode,   setViewMode]   = useState<CalendarViewMode>('month');
  const [anchorDate, setAnchorDate] = useState<Date>(() => toDateOnly(Date.now()));
  const [sortOrder,  setSortOrder]  = useState<CalendarSort>('default');
  const [filterUser, setFilterUser] = useState<string | null>(null);
  const [openCard,   setOpenCard]   = useState<{ card: KanbanCard; columnId: string } | null>(null);
  const [dayModal,   setDayModal]   = useState<Date | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Derived anchor parts (used for month view and header)
  const anchorYear  = anchorDate.getFullYear();
  const anchorMonth = anchorDate.getMonth();

  function navigate(delta: 1 | -1) {
    setAnchorDate(d => {
      switch (viewMode) {
        case '3day':     return addDays(d, delta * 3);
        case 'workweek': return addDays(d, delta * 7);
        case 'week':     return addDays(d, delta * 7);
        case 'month': {
          const next = new Date(d);
          next.setMonth(next.getMonth() + delta);
          return toDateOnly(next.getTime());
        }
        case 'year': {
          const next = new Date(d);
          next.setFullYear(next.getFullYear() + delta);
          return toDateOnly(next.getTime());
        }
      }
    });
  }

  function goToday() { setAnchorDate(toDateOnly(Date.now())); }

  function isTodayInView(): boolean {
    switch (viewMode) {
      case '3day':     return today >= anchorDate && today <= addDays(anchorDate, 2);
      case 'workweek': {
        const mon = weekStartDate(anchorDate, 1);
        return today >= mon && today <= addDays(mon, 4);
      }
      case 'week': {
        const ws = weekStartDate(anchorDate, weekStart);
        return today >= ws && today <= addDays(ws, 6);
      }
      case 'month':    return today.getFullYear() === anchorYear && today.getMonth() === anchorMonth;
      case 'year':     return today.getFullYear() === anchorYear;
    }
  }

  function headerTitle(): string {
    switch (viewMode) {
      case '3day':     return `${formatDate(anchorDate, dateFormat)} – ${formatDate(addDays(anchorDate, 2), dateFormat)}`;
      case 'workweek': {
        const mon = weekStartDate(anchorDate, 1);
        return `${formatDate(mon, dateFormat)} – ${formatDate(addDays(mon, 4), dateFormat)}`;
      }
      case 'week': {
        const ws = weekStartDate(anchorDate, weekStart);
        return `${formatDate(ws, dateFormat)} – ${formatDate(addDays(ws, 6), dateFormat)}`;
      }
      case 'month': return `${MONTH_NAMES[anchorMonth]} ${anchorYear}`;
      case 'year':  return `${anchorYear}`;
    }
  }

  // Build flat card list — exclude hidden columns and cards without any explicit date
  const flatCards = useMemo(() =>
    board.columns
      .filter((col: KanbanColumn) => !col.hideFromTimeline)
      .flatMap((col: KanbanColumn) =>
        col.cards
          .filter(card => !card.archived && (card.startDate || card.dueDate))
          .map(card => ({
            card,
            columnId: col.id,
            colColor: col.color ?? '#64748b',
            colTitle: col.title,
          })),
      ),
  [board]);

  const filteredCards = useMemo(() =>
    filterUser ? flatCards.filter(({ card }) => card.assignees.includes(filterUser)) : flatCards,
  [flatCards, filterUser]);

  const sortedCards = useMemo(() => {
    const cards = [...filteredCards];
    switch (sortOrder) {
      case 'priority':
        return cards.sort((a, b) =>
          (PRIORITY_ORDER[a.card.priority ?? ''] ?? 3) -
          (PRIORITY_ORDER[b.card.priority ?? ''] ?? 3));
      case 'column':
        return cards.sort((a, b) =>
          board.columns.findIndex(c => c.id === a.columnId) -
          board.columns.findIndex(c => c.id === b.columnId));
      case 'startDate':
        return cards.sort((a, b) =>
          effectiveStart(a.card).getTime() - effectiveStart(b.card).getTime());
      default:
        return cards;
    }
  }, [filteredCards, sortOrder, board.columns]);

  // Effective start/end
  function effectiveStart(card: KanbanCard): Date {
    if (card.startDate) return parseLocal(card.startDate);
    if (card.dueDate)   return parseLocal(card.dueDate);
    return toDateOnly(Date.now());
  }
  function effectiveEnd(card: KanbanCard): Date {
    if (card.dueDate) return parseLocal(card.dueDate);
    return effectiveStart(card);
  }

  // All known users who appear on at least one card
  const activeUsers = useMemo(() => {
    const ids = new Set(flatCards.flatMap(({ card }) => card.assignees));
    return knownUsers.filter(u => ids.has(u.userId));
  }, [flatCards, knownUsers]);

  // Cards active on a specific day
  function cardsForDay(day: Date) {
    return sortedCards
      .filter(({ card }) => {
        const s = effectiveStart(card);
        const e = effectiveEnd(card);
        return s <= day && e >= day;
      })
      .sort((a, b) => {
        const ai = board.columns.findIndex(c => c.id === a.columnId);
        const bi = board.columns.findIndex(c => c.id === b.columnId);
        if (ai !== bi) return ai - bi;
        return effectiveStart(a.card).getTime() - effectiveStart(b.card).getTime();
      });
  }

  // ── View-specific renders ─────────────────────────────────────────────────

  const { periods, columnCount } = useMemo(
    () => buildViewPeriods(viewMode, anchorDate, weekStart),
    [viewMode, anchorDate, weekStart],
  );

  // For month view use static day names; for other views use actual dates from periods[0]
  const dayHeaders = useMemo(() => {
    if (viewMode === 'month') {
      const names = weekStart === 1 ? DAY_NAMES_MON : DAY_NAMES_SUN;
      return names.map(n => ({ label: n, date: null as Date | null }));
    }
    const week = periods[0];
    if (!week || week.length === 0) return [];
    const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return week.map(d => ({ label: `${DAY_SHORT[d.getDay()]} ${d.getDate()}`, date: d }));
  }, [viewMode, weekStart, periods]);

  // ── Week row renderer (shared for month/week/workweek/3day) ──────────────

  function renderWeekRow(week: Date[], wi: number, expand = false) {
    const weekCards = layoutWeek(week, sortedCards, effectiveStart, effectiveEnd);
    const maxLane   = expand
      ? (weekCards.length > 0 ? Math.max(...weekCards.map(wc => wc.lane)) + 1 : 0)
      : MAX_VISIBLE_LANES;
    const visibleWC    = expand ? weekCards : weekCards.filter(wc => wc.lane < MAX_VISIBLE_LANES);
    const overflowByDay = expand ? [] : week.map((_, di) =>
      weekCards.filter(wc => di >= wc.startCol && di <= wc.endCol && wc.lane >= MAX_VISIBLE_LANES).length
    );
    const hasAnyOverflow = !expand && overflowByDay.some(n => n > 0);

    const rowHeight = expand
      ? DAY_NUM_H + maxLane * (CARD_H + CARD_GAP) + ROW_PAD
      : ROW_H;

    // In month view, dim days outside the current month
    const isMonthView = viewMode === 'month';

    return (
      <div
        key={wi}
        className={cn('relative border-b border-border/20', expand && 'flex-1')}
        style={{
          ...(expand ? { minHeight: rowHeight } : { height: ROW_H }),
          display: 'grid',
          gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
        }}
      >
        {/* Day cell backgrounds + numbers */}
        {week.map((day, di) => {
          const isToday     = isSameDay(day, today);
          const isThisMonth = day.getMonth() === anchorMonth;
          const dimmed      = isMonthView && !isThisMonth;
          return (
            <div
              key={di}
              className={cn(
                'border-r border-border/15 last:border-r-0',
                dimmed && 'bg-muted/10',
              )}
            >
              <div className={cn(
                'flex items-center justify-center w-6 h-6 rounded-full text-[11px] m-1 font-medium',
                isToday ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
                dimmed && 'opacity-30',
              )}>
                {day.getDate()}
              </div>
            </div>
          );
        })}

        {/* Visible card bars */}
        {visibleWC.map((wc, i) => {
          const colSpan  = wc.endCol - wc.startCol + 1;
          const leftPct  = (wc.startCol / columnCount) * 100;
          const widthPct = (colSpan / columnCount) * 100;
          const top      = DAY_NUM_H + wc.lane * (CARD_H + CARD_GAP);

          const firstAssignee = knownUsers.find(u => wc.card.assignees.includes(u.userId));
          const barColor      = firstAssignee?.userColor ?? wc.colColor;

          const startLabel = formatDate(effectiveStart(wc.card), dateFormat);
          const endLabel   = formatDate(effectiveEnd(wc.card), dateFormat);
          const tooltip    = endLabel === startLabel
            ? `${wc.card.title} · ${startLabel}`
            : `${wc.card.title} · ${startLabel} – ${endLabel}`;

          return (
            <button
              key={i}
              onClick={() => setOpenCard({ card: wc.card, columnId: wc.columnId })}
              title={tooltip}
              className={cn(
                'absolute flex items-center px-1.5 text-[10px] font-medium text-white overflow-hidden',
                'hover:brightness-110 hover:z-10 transition-all',
                !wc.clippedLeft  && 'rounded-l-md',
                !wc.clippedRight && 'rounded-r-md',
              )}
              style={{
                left:            `calc(${leftPct}% + 3px)`,
                width:           `calc(${widthPct}% - ${wc.clippedLeft || wc.clippedRight ? 3 : 6}px)`,
                top,
                height:          CARD_H,
                backgroundColor: barColor,
                opacity:         wc.card.isDone ? 0.45 : 0.85,
              }}
            >
              {/* Assignee avatars (multi-day bars) */}
              {colSpan >= 2 && wc.card.assignees.slice(0, 2).map(uid => {
                const u = knownUsers.find(k => k.userId === uid);
                if (!u) return null;
                return (
                  <div
                    key={uid}
                    className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold border border-white/30 shrink-0 mr-1"
                    style={{ backgroundColor: u.userColor }}
                  >
                    {u.userName[0]?.toUpperCase()}
                  </div>
                );
              })}
              {/* Priority dot */}
              {wc.card.priority && (
                <div className={cn('w-1.5 h-1.5 rounded-full shrink-0 mr-1', PRIORITY_COLORS[wc.card.priority])} />
              )}
              {/* Title */}
              <span className={cn('truncate leading-none flex-1', wc.card.isDone && 'line-through')}>
                {wc.card.title}
              </span>
              {/* Category label (wide bars) */}
              {colSpan >= 3 && (
                <span className="text-[9px] opacity-60 ml-1 shrink-0 truncate max-w-[40px]">
                  {wc.colTitle}
                </span>
              )}
            </button>
          );
        })}

        {/* Per-day "+N more" overflow */}
        {hasAnyOverflow && week.map((day, di) => {
          const count = overflowByDay[di];
          if (count === 0) return null;
          const leftPct = (di / columnCount) * 100;
          return (
            <button
              key={`more-${di}`}
              onClick={() => setDayModal(day)}
              className="absolute text-[10px] font-medium text-primary/70 hover:text-primary transition-colors text-left px-1.5 truncate"
              style={{
                left:   `calc(${leftPct}% + 3px)`,
                width:  `calc(${(1 / columnCount) * 100}% - 6px)`,
                top:    DAY_NUM_H + MAX_VISIBLE_LANES * (CARD_H + CARD_GAP),
                height: SHOW_MORE_H,
                lineHeight: `${SHOW_MORE_H}px`,
              }}
            >
              +{count} more
            </button>
          );
        })}
      </div>
    );
  }

  // ── Year view ─────────────────────────────────────────────────────────────

  function renderYearView() {
    return (
      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 12 }, (_, mi) => {
            const monthAnchor = new Date(anchorYear, mi, 1);
            const monthEnd    = new Date(anchorYear, mi + 1, 0);
            const monthCards  = sortedCards.filter(({ card }) => {
              const s = effectiveStart(card);
              const e = effectiveEnd(card);
              return s <= monthEnd && e >= monthAnchor;
            });
            const isCurrentMonth = mi === today.getMonth() && anchorYear === today.getFullYear();
            const density = Math.min(100, monthCards.length * 8);
            return (
              <button
                key={mi}
                onClick={() => { setAnchorDate(monthAnchor); setViewMode('month'); }}
                className={cn(
                  'rounded-lg border border-border/20 p-3 text-left hover:bg-accent/30 transition-colors',
                  isCurrentMonth && 'border-primary/40 bg-primary/5',
                )}
              >
                <div className={cn('text-sm font-semibold mb-1', isCurrentMonth ? 'text-primary' : 'text-foreground')}>
                  {MONTH_SHORT[mi]}
                </div>
                <div className="text-[11px] text-muted-foreground mb-2">
                  {monthCards.length} {monthCards.length === 1 ? 'task' : 'tasks'}
                </div>
                <div className="h-1 rounded-full bg-muted/40 overflow-hidden">
                  <div className="h-full bg-primary/60 rounded-full" style={{ width: `${density}%` }} />
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/30 shrink-0 flex-wrap">
        {/* View mode pills */}
        <div className="flex items-center bg-muted/30 rounded-md p-0.5 gap-0.5">
          {(Object.keys(VIEW_LABELS) as CalendarViewMode[]).map(m => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={cn(
                'text-[11px] px-2 py-1 rounded transition-colors',
                viewMode === m
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {VIEW_LABELS[m]}
            </button>
          ))}
        </div>

        {/* Navigation */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigate(-1)}
            className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-sm font-semibold text-foreground min-w-[160px] text-center">
            {headerTitle()}
          </span>
          <button
            onClick={() => navigate(1)}
            className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        {/* Today button + date picker */}
        <div className="flex items-center gap-1">
          {!isTodayInView() && (
            <button
              onClick={goToday}
              className="text-xs px-2 py-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded transition-colors"
            >
              Today
            </button>
          )}
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
                <CalendarIcon size={13} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={anchorDate}
                onSelect={(d) => { if (d) { setAnchorDate(d); setPickerOpen(false); } }}
                weekStartsOn={weekStart}
              />
            </PopoverContent>
          </Popover>
        </div>

        {/* Sort */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border/40 bg-background text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors">
              {SORT_LABELS[sortOrder]}
              <ChevronsUpDown size={10} className="opacity-50" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[140px]">
            {(Object.keys(SORT_LABELS) as CalendarSort[]).map(s => (
              <DropdownMenuItem
                key={s}
                onClick={() => setSortOrder(s)}
                className="flex items-center justify-between text-[12px]"
              >
                {SORT_LABELS[s]}
                {sortOrder === s && <Check size={12} className="text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Assignee filter */}
        {activeUsers.length > 0 && (
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-[11px] text-muted-foreground/60 mr-1">Filter:</span>
            {activeUsers.map(u => (
              <button
                key={u.userId}
                onClick={() => setFilterUser(f => f === u.userId ? null : u.userId)}
                title={u.userName}
                className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white transition-all',
                  filterUser === u.userId
                    ? 'ring-2 ring-white/60 ring-offset-1 ring-offset-background scale-110'
                    : 'opacity-60 hover:opacity-100',
                )}
                style={{ backgroundColor: u.userColor }}
              >
                {u.userName[0]?.toUpperCase()}
              </button>
            ))}
            {filterUser && (
              <button
                onClick={() => setFilterUser(null)}
                className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground ml-1 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Year view ───────────────────────────────────────────────────── */}
      {viewMode === 'year' && renderYearView()}

      {viewMode !== 'year' && (
        <>
          {/* ── Day-of-week header ─────────────────────────────────────── */}
          <div
            className="border-b border-border/30 shrink-0"
            style={{ display: 'grid', gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
          >
            {dayHeaders.map(({ label, date }) => {
              const isToday = date ? isSameDay(date, today) : false;
              return (
                <div
                  key={label}
                  className={cn(
                    'text-center text-[11px] font-medium py-1.5',
                    isToday ? 'text-primary' : 'text-muted-foreground/60',
                  )}
                >
                  {label}
                </div>
              );
            })}
          </div>

          {/* ── Calendar grid ─────────────────────────────────────────── */}
          <div className={cn('flex-1', viewMode === 'month' ? 'overflow-y-auto' : 'overflow-y-auto flex flex-col')}>
            {viewMode === 'month'
              ? periods.map((week, wi) => renderWeekRow(week, wi))
              : periods.map((week, wi) => renderWeekRow(week, wi, true))
            }
          </div>
        </>
      )}

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {sortedCards.length === 0 && viewMode !== 'year' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-muted-foreground/40 gap-2 mt-20">
          <CalendarDays size={32} />
          <p className="text-sm">No cards to display</p>
        </div>
      )}

      {/* ── Day modal ───────────────────────────────────────────────────── */}
      {dayModal && (() => {
        const dayCards = cardsForDay(dayModal);
        return (
          <Dialog open onOpenChange={() => setDayModal(null)}>
            <DialogContent className="sm:max-w-sm w-full max-h-[70vh] overflow-hidden flex flex-col p-0 gap-0">
              <DialogHeader className="px-4 py-3 border-b border-border/30 shrink-0">
                <DialogTitle className="text-sm font-semibold">
                  {formatDate(dayModal, dateFormat)}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {dayCards.length} {dayCards.length === 1 ? 'task' : 'tasks'}
                  </span>
                </DialogTitle>
              </DialogHeader>
              <div className="flex-1 overflow-y-auto py-1">
                {board.columns.filter(col => !col.hideFromTimeline).map(col => {
                  const colCards = dayCards.filter(c => c.columnId === col.id);
                  if (colCards.length === 0) return null;
                  return (
                    <div key={col.id}>
                      <div className="flex items-center gap-1.5 px-3 py-1.5">
                        <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.color ?? '#64748b' }} />
                        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
                          {col.title}
                        </span>
                      </div>
                      {colCards.map(({ card, columnId }) => (
                        <button
                          key={card.id}
                          onClick={() => { setOpenCard({ card, columnId }); setDayModal(null); }}
                          className="w-full flex items-center gap-2 px-4 py-1.5 text-left hover:bg-accent/40 transition-colors"
                        >
                          {card.priority && (
                            <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', PRIORITY_COLORS[card.priority])} />
                          )}
                          <span className={cn(
                            'text-sm truncate flex-1',
                            card.isDone ? 'line-through text-muted-foreground/50' : 'text-foreground',
                          )}>
                            {card.title}
                          </span>
                          {/* Assignee avatars */}
                          <div className="flex items-center -space-x-1 shrink-0">
                            {card.assignees.slice(0, 2).map(uid => {
                              const u = knownUsers.find(k => k.userId === uid);
                              if (!u) return null;
                              return (
                                <div
                                  key={uid}
                                  className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white border border-background"
                                  style={{ backgroundColor: u.userColor }}
                                  title={u.userName}
                                >
                                  {u.userName[0]?.toUpperCase()}
                                </div>
                              );
                            })}
                          </div>
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            </DialogContent>
          </Dialog>
        );
      })()}

      {/* ── Card dialog ─────────────────────────────────────────────────── */}
      {openCard && (
        <CardDialog
          card={openCard.card}
          columnId={openCard.columnId}
          onClose={() => setOpenCard(null)}
        />
      )}
    </div>
  );
}
