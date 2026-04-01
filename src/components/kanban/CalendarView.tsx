import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useKanbanContext } from '../../views/KanbanPage';
import { useUiStore, formatDate } from '../../store/uiStore';
import type { KanbanCard, KanbanColumn } from '../../types/kanban';
import CardDialog from './CardDialog';

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

/** Weeks covering the whole month, aligned to weekStartDay (0=Sun, 1=Mon). */
function buildWeeks(year: number, month: number, weekStartDay: 0 | 1): Date[][] {
  const firstOfMonth = new Date(year, month, 1);
  const lastOfMonth  = new Date(year, month + 1, 0);

  // find the week-start day on or before the 1st
  const dow = firstOfMonth.getDay(); // 0=Sun
  const startOffset = weekStartDay === 1
    ? (dow === 0 ? -6 : 1 - dow)   // back to Monday
    : -dow;                          // back to Sunday
  const gridStart = addDays(firstOfMonth, startOffset);

  // find the week-end day (6 days after weekStartDay) on or after the last day
  const lastDow = lastOfMonth.getDay();
  const weekEndDay = weekStartDay === 1 ? 0 : 6; // Monday-start → ends Sunday(0); Sunday-start → ends Saturday(6)
  const endOffset = weekStartDay === 1
    ? (lastDow === 0 ? 0 : 7 - lastDow)
    : (lastDow === 6 ? 0 : 6 - lastDow);
  void weekEndDay; // used implicitly via endOffset logic
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

// ── Layout ────────────────────────────────────────────────────────────────────

const DAY_NUM_H  = 22; // px — space for the day number
const CARD_H     = 22; // px — card bar height
const CARD_GAP   = 3;  // px — gap between lanes
const ROW_PAD    = 6;  // px — bottom padding per week row

interface WeekCard {
  card: KanbanCard;
  columnId: string;
  colColor: string;
  startCol: number;   // 0–6 within this week
  endCol: number;     // 0–6 within this week
  lane: number;
  clippedLeft: boolean;   // bar continues from previous week
  clippedRight: boolean;  // bar continues into next week
}

function layoutWeek(
  week: Date[],
  cards: Array<{ card: KanbanCard; columnId: string; colColor: string }>,
  getStart: (c: KanbanCard) => Date,
  getEnd:   (c: KanbanCard) => Date,
): WeekCard[] {
  const weekStart = week[0];
  const weekEnd   = week[6];

  const candidates = cards
    .map(({ card, columnId, colColor }) => {
      const s = getStart(card);
      const e = getEnd(card);
      if (s > weekEnd || e < weekStart) return null;
      const startCol = Math.max(0, diffDays(weekStart, s));
      const endCol   = Math.min(6, diffDays(weekStart, e));
      return {
        card, columnId, colColor,
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

// ── Component ─────────────────────────────────────────────────────────────────

const DAY_NAMES_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES_SUN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export default function CalendarView() {
  const { board, knownUsers } = useKanbanContext();
  const { dateFormat, weekStart } = useUiStore();

  const today = new Date();
  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());

  const dayNames = weekStart === 1 ? DAY_NAMES_MON : DAY_NAMES_SUN;
  const [filterUser, setFilterUser] = useState<string | null>(null);
  const [openCard,   setOpenCard]   = useState<{ card: KanbanCard; columnId: string } | null>(null);

  function prevMonth() {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  }

  // Build flat card list with column metadata
  const flatCards = useMemo(() =>
    board.columns.flatMap((col: KanbanColumn) =>
      col.cards.map(card => ({
        card,
        columnId: col.id,
        colColor: col.color ?? '#64748b',
      })),
    ),
  [board]);

  const visibleCards = useMemo(() =>
    filterUser ? flatCards.filter(({ card }) => card.assignees.includes(filterUser)) : flatCards,
  [flatCards, filterUser]);

  const weeks = useMemo(() => buildWeeks(year, month, weekStart), [year, month, weekStart]);

  // Effective start/end for each card
  function effectiveStart(card: KanbanCard): Date {
    if (card.startDate) return parseLocal(card.startDate);
    if (card.createdAt) return toDateOnly(card.createdAt);
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

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border/30 shrink-0 flex-wrap">
        {/* Month navigation */}
        <div className="flex items-center gap-1">
          <button
            onClick={prevMonth}
            className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="text-sm font-semibold text-foreground w-36 text-center">
            {MONTH_NAMES[month]} {year}
          </span>
          <button
            onClick={nextMonth}
            className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <ChevronRight size={14} />
          </button>
          {!(year === today.getFullYear() && month === today.getMonth()) && (
            <button
              onClick={() => { setYear(today.getFullYear()); setMonth(today.getMonth()); }}
              className="ml-1 text-xs px-2 py-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded transition-colors"
            >
              Today
            </button>
          )}
        </div>

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

      {/* ── Day-of-week header ──────────────────────────────────────────── */}
      <div className="grid grid-cols-7 border-b border-border/30 shrink-0">
        {dayNames.map(name => (
          <div key={name} className="text-center text-[11px] font-medium text-muted-foreground/60 py-1.5">
            {name}
          </div>
        ))}
      </div>

      {/* ── Calendar grid ───────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {weeks.map((week, wi) => {
          const weekCards = layoutWeek(week, visibleCards, effectiveStart, effectiveEnd);
          const numLanes  = weekCards.length > 0 ? Math.max(...weekCards.map(w => w.lane)) + 1 : 0;
          const rowHeight = DAY_NUM_H + numLanes * (CARD_H + CARD_GAP) + ROW_PAD;

          return (
            <div
              key={wi}
              className="relative grid grid-cols-7 border-b border-border/20"
              style={{ minHeight: rowHeight }}
            >
              {/* Day cell backgrounds + numbers */}
              {week.map((day, di) => {
                const isToday     = isSameDay(day, today);
                const isThisMonth = day.getMonth() === month;
                return (
                  <div
                    key={di}
                    className={cn(
                      'border-r border-border/15 last:border-r-0',
                      !isThisMonth && 'bg-muted/10',
                    )}
                  >
                    <div className={cn(
                      'flex items-center justify-center w-6 h-6 rounded-full text-[11px] m-1 font-medium',
                      isToday    ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
                      !isThisMonth && 'opacity-30',
                    )}>
                      {day.getDate()}
                    </div>
                  </div>
                );
              })}

              {/* Card bars — absolutely positioned */}
              {weekCards.map((wc, i) => {
                const colSpan = wc.endCol - wc.startCol + 1;
                const leftPct  = (wc.startCol / 7) * 100;
                const widthPct = (colSpan / 7) * 100;
                const top = DAY_NUM_H + wc.lane * (CARD_H + CARD_GAP);

                // Pick bar color: first assignee's color or column color
                const firstAssignee = knownUsers.find(u => wc.card.assignees.includes(u.userId));
                const barColor = firstAssignee?.userColor ?? wc.colColor;

                const startLabel = formatDate(effectiveStart(wc.card), dateFormat);
                const endLabel   = formatDate(effectiveEnd(wc.card), dateFormat);
                const tooltip = endLabel === startLabel
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
                      wc.card.isDone && 'opacity-50',
                      !wc.clippedLeft  && 'rounded-l-md',
                      !wc.clippedRight && 'rounded-r-md',
                    )}
                    style={{
                      left:   `calc(${leftPct}% + 3px)`,
                      width:  `calc(${widthPct}% - ${wc.clippedLeft || wc.clippedRight ? 3 : 6}px)`,
                      top,
                      height: CARD_H,
                      backgroundColor: barColor,
                      opacity: wc.card.isDone ? 0.45 : 0.85,
                    }}
                  >
                    {/* Show assignee avatars if bar is wide enough */}
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
                    <span className={cn('truncate leading-none', wc.card.isDone && 'line-through')}>
                      {wc.card.title}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {visibleCards.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-muted-foreground/40 gap-2 mt-20">
          <CalendarDays size={32} />
          <p className="text-sm">No cards to display</p>
        </div>
      )}

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
