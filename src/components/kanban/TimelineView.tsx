import { useState, useRef, useMemo, useEffect } from 'react';
import { ChevronLeft, ChevronRight, GanttChart } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useKanbanContext } from '../../views/KanbanPage';
import { useUiStore, formatDate } from '../../store/uiStore';
import type { KanbanCard } from '../../types/kanban';
import CardDialog from './CardDialog';

// ── Constants ─────────────────────────────────────────────────────────────────

const DAY_W       = 38;  // px per day column
const ROW_H       = 32;  // px per card row
const GROUP_H     = 28;  // px per column-group header
const HDR_MONTH_H = 20;  // px — month label row
const HDR_DAY_H   = 26;  // px — day number row
const SIDEBAR_W   = 210; // px
const HANDLE_W    = 6;   // px — resize grip width
const NUM_DAYS    = 90;  // days to render

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const PRIORITY_COLORS = {
  high:   'bg-red-300',
  medium: 'bg-yellow-300',
  low:    'bg-green-300',
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseLocal(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function toDateOnly(ts: number): Date {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function diffDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}
function dateToStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface DragRef {
  type: 'move' | 'left' | 'right';
  cardId: string;
  columnId: string;
  startX: number;
  origEffStart: Date;
  origEffEnd: Date;
  origStartDate: string | undefined;
  origDueDate: string | undefined;
}

interface DragPreview {
  cardId: string;
  startDate: string;
  dueDate: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TimelineView() {
  const { board, updateBoard, knownUsers } = useKanbanContext();
  const { dateFormat, weekStart } = useUiStore();

  const today = useMemo(() => toDateOnly(Date.now()), []);

  const [rangeStart,      setRangeStart]      = useState(() => addDays(today, -7));
  const [filterUser,      setFilterUser]      = useState<string | null>(null);
  const [openCard,        setOpenCard]        = useState<{ card: KanbanCard; columnId: string } | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Drag state: ref for mutation, state for re-renders
  const dragRef     = useRef<DragRef | null>(null);
  const previewRef  = useRef<DragPreview | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);

  // Scroll sync refs
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const sidebarRef      = useRef<HTMLDivElement>(null);
  const bodyRef         = useRef<HTMLDivElement>(null);

  // Scroll to show today on first render
  useEffect(() => {
    const todayCol = diffDays(rangeStart, today);
    if (bodyRef.current) {
      bodyRef.current.scrollLeft = Math.max(0, (todayCol - 5) * DAY_W);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function onBodyScroll() {
    if (headerScrollRef.current && bodyRef.current)
      headerScrollRef.current.scrollLeft = bodyRef.current.scrollLeft;
    if (sidebarRef.current && bodyRef.current)
      sidebarRef.current.scrollTop = bodyRef.current.scrollTop;
  }

  function toggleGroup(colId: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId); else next.add(colId);
      return next;
    });
  }

  // Active users
  const flatCards = useMemo(() =>
    board.columns
      .filter(col => !col.hideFromTimeline)
      .flatMap(col =>
        col.cards
          .filter(card => card.startDate || card.dueDate)
          .map(card => ({ card, columnId: col.id })),
      ),
  [board]);

  const activeUsers = useMemo(() => {
    const ids = new Set(flatCards.flatMap(({ card }) => card.assignees));
    return knownUsers.filter(u => ids.has(u.userId));
  }, [flatCards, knownUsers]);

  // Days array and derived info
  const days = useMemo(() => {
    const arr: Date[] = [];
    for (let i = 0; i < NUM_DAYS; i++) arr.push(addDays(rangeStart, i));
    return arr;
  }, [rangeStart]);

  const todayCol = useMemo(() => diffDays(rangeStart, today), [rangeStart, today]);

  const monthSpans = useMemo(() => {
    type Span = { label: string; start: number; count: number };
    const spans: Span[] = [];
    let cur: Span | null = null;
    days.forEach((day, i) => {
      const key = `${MONTH_SHORT[day.getMonth()]} ${day.getFullYear()}`;
      if (!cur || cur.label !== key) {
        if (cur) spans.push(cur);
        cur = { label: key, start: i, count: 1 };
      } else {
        cur.count++;
      }
    });
    if (cur) spans.push(cur);
    return spans;
  }, [days]);

  const totalWidth = NUM_DAYS * DAY_W;
  const hdrH = HDR_MONTH_H + HDR_DAY_H;

  // ── Effective dates ──────────────────────────────────────────────────────────

  function effStart(card: KanbanCard): Date {
    if (card.startDate) return parseLocal(card.startDate);
    if (card.dueDate)   return parseLocal(card.dueDate);
    return today;
  }
  function effEnd(card: KanbanCard): Date {
    if (card.dueDate) return parseLocal(card.dueDate);
    return effStart(card);
  }

  function barDates(card: KanbanCard): { start: Date; end: Date } {
    if (dragPreview?.cardId === card.id) {
      return {
        start: parseLocal(dragPreview.startDate),
        end:   parseLocal(dragPreview.dueDate),
      };
    }
    return { start: effStart(card), end: effEnd(card) };
  }

  // ── Drag handlers ────────────────────────────────────────────────────────────

  function initDrag(
    e: React.PointerEvent,
    card: KanbanCard,
    columnId: string,
    type: DragRef['type'],
  ) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const es = effStart(card);
    const ee = effEnd(card);
    dragRef.current = {
      type, cardId: card.id, columnId,
      startX: e.clientX,
      origEffStart: es, origEffEnd: ee,
      origStartDate: card.startDate, origDueDate: card.dueDate,
    };
    const preview = { cardId: card.id, startDate: dateToStr(es), dueDate: dateToStr(ee) };
    previewRef.current = preview;
    setDragPreview(preview);
  }

  function moveDrag(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const delta = Math.round((e.clientX - d.startX) / DAY_W);

    let s  = d.origEffStart;
    let en = d.origEffEnd;

    if (d.type === 'move') {
      s  = addDays(d.origEffStart, delta);
      en = addDays(d.origEffEnd,   delta);
    } else if (d.type === 'left') {
      s = addDays(d.origEffStart, delta);
      if (s > en) s = en;
    } else {
      en = addDays(d.origEffEnd, delta);
      if (en < s) en = s;
    }

    const preview = { cardId: d.cardId, startDate: dateToStr(s), dueDate: dateToStr(en) };
    previewRef.current = preview;
    setDragPreview(preview);
  }

  function endDrag(card: KanbanCard, columnId: string) {
    const d = dragRef.current;
    const p = previewRef.current;
    dragRef.current    = null;
    previewRef.current = null;
    setDragPreview(null);
    if (!d || !p) return;

    // Only write if actually changed
    const origStart = d.origStartDate ?? dateToStr(d.origEffStart);
    const origEnd   = d.origDueDate   ?? dateToStr(d.origEffEnd);
    if (p.startDate === origStart && p.dueDate === origEnd) return;

    updateBoard(prev => ({
      ...prev,
      columns: prev.columns.map(col =>
        col.id !== columnId ? col : {
          ...col,
          cards: col.cards.map(c => c.id !== card.id ? c : {
            ...c,
            startDate: p.startDate,
            dueDate:   p.dueDate,
          }),
        }
      ),
    }));
  }

  function cancelDrag() {
    dragRef.current    = null;
    previewRef.current = null;
    setDragPreview(null);
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const visibleGroups = board.columns
    .filter(col => !col.hideFromTimeline)
    .map(col => {
      const datedCards = col.cards.filter(c => c.startDate || c.dueDate);
      return {
        col,
        cards: filterUser
          ? datedCards.filter(c => c.assignees.includes(filterUser))
          : datedCards,
      };
    })
    .filter(g => g.cards.length > 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Nav header ────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border/30 shrink-0 flex-wrap">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setRangeStart(s => addDays(s, -30))}
            className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            onClick={() => setRangeStart(s => addDays(s, 30))}
            className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <ChevronRight size={14} />
          </button>
          <button
            onClick={() => setRangeStart(addDays(today, -7))}
            className="ml-1 text-xs px-2 py-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 rounded transition-colors"
          >
            Today
          </button>
        </div>

        <span className="text-xs text-muted-foreground">
          {formatDate(rangeStart, dateFormat)} – {formatDate(addDays(rangeStart, NUM_DAYS - 1), dateFormat)}
        </span>

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

      {/* ── Main layout ───────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Left sidebar ──────────────────────────────────────────────── */}
        <div className="flex flex-col shrink-0 border-r border-border/30" style={{ width: SIDEBAR_W }}>
          {/* Corner spacer aligned with header */}
          <div className="shrink-0 border-b border-border/30 bg-muted/10" style={{ height: hdrH }} />

          {/* Card labels — scroll synced with body */}
          <div ref={sidebarRef} className="flex-1 overflow-hidden">
            {visibleGroups.map(({ col, cards }) => {
              const isCollapsed = collapsedGroups.has(col.id);
              return (
                <div key={col.id}>
                  {/* Group header — click to collapse */}
                  <div
                    className="flex items-center gap-1.5 px-2 border-b border-border/20 bg-muted/15 text-xs font-semibold text-foreground cursor-pointer hover:bg-muted/25 transition-colors select-none"
                    style={{ height: GROUP_H }}
                    onClick={() => toggleGroup(col.id)}
                  >
                    <ChevronRight
                      size={11}
                      className={cn('shrink-0 text-muted-foreground/50 transition-transform', !isCollapsed && 'rotate-90')}
                    />
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: col.color ?? '#64748b' }} />
                    <span className="truncate flex-1">{col.title}</span>
                    <span className="text-muted-foreground/50 text-[10px] shrink-0">{cards.length}</span>
                  </div>
                  {/* Card labels — hidden when collapsed */}
                  {!isCollapsed && cards.map(card => {
                    const firstAssignee = knownUsers.find(u => card.assignees.includes(u.userId));
                    return (
                      <div
                        key={card.id}
                        className="flex items-center gap-1.5 px-2 border-b border-border/10 cursor-pointer hover:bg-accent/20 transition-colors"
                        style={{ height: ROW_H }}
                        onClick={() => setOpenCard({ card, columnId: col.id })}
                      >
                        {/* Priority dot */}
                        {card.priority && (
                          <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', PRIORITY_COLORS[card.priority])} />
                        )}
                        <span className={cn(
                          'text-xs truncate flex-1',
                          card.isDone ? 'line-through text-muted-foreground/40' : 'text-foreground/80',
                        )}>
                          {card.title}
                        </span>
                        {/* Assignee initial */}
                        {firstAssignee && (
                          <div
                            className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white shrink-0"
                            style={{ backgroundColor: firstAssignee.userColor }}
                            title={firstAssignee.userName}
                          >
                            {firstAssignee.userName[0]?.toUpperCase()}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right: header + bar grid ───────────────────────────────────── */}
        <div className="flex flex-col flex-1 overflow-hidden">

          {/* Day header — scrolls X only, synced with body */}
          <div
            ref={headerScrollRef}
            className="shrink-0 overflow-hidden border-b border-border/30 bg-muted/10"
            style={{ height: hdrH }}
          >
            <div style={{ width: totalWidth }}>
              {/* Month row */}
              <div className="flex border-b border-border/20" style={{ height: HDR_MONTH_H }}>
                {monthSpans.map(span => (
                  <div
                    key={span.label}
                    className="shrink-0 flex items-center px-2 text-[11px] font-semibold text-muted-foreground border-r border-border/20"
                    style={{ width: span.count * DAY_W }}
                  >
                    {span.label}
                  </div>
                ))}
              </div>
              {/* Day numbers row */}
              <div className="flex" style={{ height: HDR_DAY_H }}>
                {days.map((day, i) => {
                  const isToday   = i === todayCol;
                  const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                  const isWeekStart = weekStart === 1 ? day.getDay() === 1 : day.getDay() === 0;
                  return (
                    <div
                      key={i}
                      className={cn(
                        'shrink-0 flex items-center justify-center text-[11px] border-r border-border/10',
                        isToday    ? 'bg-primary/15 text-primary font-bold' :
                        isWeekend  ? 'text-muted-foreground/30' :
                        isWeekStart? 'text-muted-foreground/70' :
                                     'text-muted-foreground/40',
                      )}
                      style={{ width: DAY_W }}
                    >
                      {day.getDate()}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Bar grid — scrolls both axes */}
          <div
            ref={bodyRef}
            className="flex-1 overflow-auto"
            onScroll={onBodyScroll}
          >
            <div style={{ width: totalWidth }}>
              {visibleGroups.map(({ col, cards }) => {
                const colColor    = col.color ?? '#64748b';
                const isCollapsed = collapsedGroups.has(col.id);
                return (
                  <div key={col.id}>
                    {/* Group header stripe — always visible, click to collapse */}
                    <div
                      className="relative border-b border-border/20 bg-muted/15 cursor-pointer hover:bg-muted/25 transition-colors"
                      style={{ height: GROUP_H, width: totalWidth }}
                      onClick={() => toggleGroup(col.id)}
                    >
                      {todayCol >= 0 && todayCol < NUM_DAYS && (
                        <div
                          className="absolute inset-y-0 bg-primary/8 pointer-events-none"
                          style={{ left: todayCol * DAY_W, width: DAY_W }}
                        />
                      )}
                    </div>

                    {/* Card rows — hidden when collapsed */}
                    {!isCollapsed && cards.map(card => {
                      const { start, end } = barDates(card);
                      const startCol = diffDays(rangeStart, start);
                      const endCol   = diffDays(rangeStart, end);
                      const cStart   = Math.max(0, startCol);
                      const cEnd     = Math.min(NUM_DAYS - 1, endCol);
                      const visible  = cEnd >= 0 && cStart < NUM_DAYS && cEnd >= cStart;

                      const firstAssignee = knownUsers.find(u => card.assignees.includes(u.userId));
                      const barColor      = firstAssignee?.userColor ?? colColor;
                      const isDragging    = dragPreview?.cardId === card.id;

                      const barLeft  = cStart * DAY_W + 2;
                      const barWidth = Math.max(HANDLE_W * 2 + 6, (cEnd - cStart + 1) * DAY_W - 4);
                      const barTop   = Math.round((ROW_H - 20) / 2);

                      const showPriority = card.priority && barWidth > HANDLE_W * 2 + 16;
                      const innerPadLeft = HANDLE_W + 3 + (showPriority ? 10 : 0);

                      return (
                        <div
                          key={card.id}
                          className="relative border-b border-border/10 hover:bg-muted/5"
                          style={{ height: ROW_H, width: totalWidth }}
                        >
                          {/* Today column highlight */}
                          {todayCol >= 0 && todayCol < NUM_DAYS && (
                            <div
                              className="absolute inset-y-0 bg-primary/8 pointer-events-none"
                              style={{ left: todayCol * DAY_W, width: DAY_W }}
                            />
                          )}

                          {/* Today line */}
                          {todayCol >= 0 && todayCol < NUM_DAYS && (
                            <div
                              className="absolute inset-y-0 w-px bg-primary/30 pointer-events-none"
                              style={{ left: todayCol * DAY_W + Math.round(DAY_W / 2) }}
                            />
                          )}

                          {/* Card bar */}
                          {visible && (
                            <div
                              className={cn(
                                'absolute flex items-center rounded overflow-hidden select-none transition-shadow',
                                isDragging ? 'shadow-lg' : '',
                                card.isDone && 'opacity-40',
                              )}
                              style={{
                                left:   barLeft,
                                width:  barWidth,
                                top:    barTop,
                                height: 20,
                                backgroundColor: barColor,
                                opacity: card.isDone ? 0.4 : (isDragging ? 0.95 : 0.85),
                              }}
                            >
                              {/* Left resize handle */}
                              <div
                                className="absolute left-0 top-0 h-full flex items-center justify-center hover:bg-black/20 rounded-l z-10"
                                style={{ width: HANDLE_W, cursor: 'ew-resize' }}
                                onPointerDown={e => initDrag(e, card, col.id, 'left')}
                                onPointerMove={moveDrag}
                                onPointerUp={() => endDrag(card, col.id)}
                                onPointerCancel={cancelDrag}
                              >
                                <div className="w-0.5 h-3 rounded-full bg-white/40" />
                              </div>

                              {/* Priority dot */}
                              {showPriority && (
                                <div
                                  className={cn('absolute w-1.5 h-1.5 rounded-full pointer-events-none', PRIORITY_COLORS[card.priority!])}
                                  style={{ left: HANDLE_W + 3, top: '50%', transform: 'translateY(-50%)' }}
                                />
                              )}

                              {/* Center — move + title */}
                              <div
                                className="absolute inset-0 flex items-center overflow-hidden"
                                style={{ paddingLeft: innerPadLeft, paddingRight: HANDLE_W + (barWidth > 60 && firstAssignee ? 22 : 3), cursor: isDragging ? 'grabbing' : 'grab' }}
                                onPointerDown={e => initDrag(e, card, col.id, 'move')}
                                onPointerMove={moveDrag}
                                onPointerUp={() => endDrag(card, col.id)}
                                onPointerCancel={cancelDrag}
                              >
                                {barWidth > HANDLE_W * 2 + 30 && (
                                  <span className="text-[10px] font-medium text-white/90 truncate leading-none">
                                    {card.title}
                                  </span>
                                )}
                              </div>

                              {/* Assignee avatar */}
                              {barWidth > 60 && firstAssignee && (
                                <div
                                  className="absolute w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white border border-white/30 pointer-events-none"
                                  style={{
                                    right: HANDLE_W + 4,
                                    top: '50%',
                                    transform: 'translateY(-50%)',
                                    backgroundColor: firstAssignee.userColor,
                                  }}
                                  title={firstAssignee.userName}
                                >
                                  {firstAssignee.userName[0]?.toUpperCase()}
                                </div>
                              )}

                              {/* Right resize handle */}
                              <div
                                className="absolute right-0 top-0 h-full flex items-center justify-center hover:bg-black/20 rounded-r z-10"
                                style={{ width: HANDLE_W, cursor: 'ew-resize' }}
                                onPointerDown={e => initDrag(e, card, col.id, 'right')}
                                onPointerMove={moveDrag}
                                onPointerUp={() => endDrag(card, col.id)}
                                onPointerCancel={cancelDrag}
                              >
                                <div className="w-0.5 h-3 rounded-full bg-white/40" />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              {/* Empty state */}
              {flatCards.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground/40 py-20">
                  <GanttChart size={32} />
                  <p className="text-sm">No cards to display</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Card dialog */}
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
