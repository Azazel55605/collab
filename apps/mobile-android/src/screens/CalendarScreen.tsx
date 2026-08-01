import {
  Archive,
  ArchiveRestore,
  Bell,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  ClipboardCheck,
  CloudOff,
  FileDown,
  FileUp,
  Gift,
  Link,
  Link2,
  MapPin,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  SquareKanban,
  Settings2,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type TouchEvent as ReactTouchEvent,
} from 'react';

import {
  acknowledgeProfileCalendarOperations,
  deleteProfileCalendarItem,
  discardProfileCalendarOperation,
  hostedCalendarRequest,
  hostedRequest,
  hostedUserDirectory,
  listProfileCalendarItems,
  listProfileCalendarItemsForCalendar,
  listProfileCalendarMirrorGroups,
  listProfileCalendars,
  openExternalUrl,
  readFileForUpload,
  readHostedDocument,
  retryProfileCalendarOperation,
  saveProfileCalendarMirrorGroup,
  saveProfileCalendar,
  saveProfileCalendarWithOperation,
  showMobileOpenFiles,
  showMobileSaveDialog,
  upsertProfileCalendarItem,
  upsertProfileCalendarItems,
  writeMobileDownloadedFile,
  deleteProfileCalendarMirrorGroup,
  type ServerConnectionStatus,
  type UserDirectoryEntry,
} from '../mobileTauri';
import { useBackDismiss } from '../lib/backStack';
import { DateField } from '../components/DateField';
import { TimeField } from '../components/TimeField';
import { Banner, EmptyState, Spinner } from '../components/ui';
import {
  mobileCalendarProfileId,
  resolveMobileCalendarMirrorConflict,
} from '../lib/calendarSync';
import {
  calendarMirrorLocationKey,
  validateCalendarMirrorGroup,
} from '../../../../src/lib/calendarMirroring';
import type { ThemePrefs } from '../lib/theme';
import { useMobileStore } from '../state/store';
import { layoutCalendarTimedItems } from '../../../../src/lib/calendarTimedLayout';
import {
  base64ToUtf8,
  exportCalendarIcs,
  previewCalendarIcsImport,
  utf8ToBase64,
} from '../../../../src/lib/calendarIcs';
import { expandRecurringItem } from '../../../../src/lib/calendarRecurrence';
import {
  planRecurringEdit,
  splitRecurrence,
  type CalendarRecurrenceEditScope,
} from '../../../../src/lib/calendarRecurringEdit';
import {
  reconcileProfileCalendarReminders,
} from '../../../../src/lib/calendarReminderScheduler';
import { normalizeKanbanBoard } from '../../../../src/types/kanban';
import { calendarTaskToKanbanPatch } from '../../../../src/lib/kanbanCalendarProjection';
import {
  calendarItemRange,
  calendarTimeValueKey,
  createCalendarDefinition,
  normalizeCalendarDefinition,
  normalizeCalendarItem,
  queryCalendarItems,
  type CalendarAttachment,
  type CalendarAttendanceResponse,
  type CalendarAttendee,
  type CalendarDefinition,
  type CalendarItem,
  type CalendarItemKind,
  type CalendarLocation,
  type CalendarMirrorGroup,
  type CalendarMirrorConflict,
  type CalendarMirrorGroupStatus,
  type CalendarOperation,
  type CalendarTaskStatus,
} from '../../../../src/types/calendar';

type MobileCalendarView = 'agenda' | 'month' | 'three-day' | 'day' | 'tasks';

const VIEW_OPTIONS: Array<{ value: MobileCalendarView; label: string }> = [
  { value: 'agenda', label: 'Agenda' },
  { value: 'month', label: 'Month' },
  { value: 'three-day', label: '3 Day' },
  { value: 'day', label: 'Day' },
  { value: 'tasks', label: 'Tasks' },
];
const DEVICE_KEY = 'collab-mobile-calendar-device-id';
const INTERNAL_SWIPE_THRESHOLD = 48;
const MOBILE_DAY_HOUR_HEIGHT = 52;
const CALENDAR_COLORS = ['#a78bfa', '#60a5fa', '#34d399', '#fb7185', '#fb923c', '#22d3ee'];
const RECURRENCE_OPTIONS = [
  { value: '', label: 'Does not repeat' },
  { value: 'FREQ=DAILY', label: 'Daily' },
  { value: 'FREQ=WEEKLY', label: 'Weekly' },
  { value: 'FREQ=MONTHLY', label: 'Monthly' },
  { value: 'FREQ=YEARLY', label: 'Yearly' },
  { value: 'CUSTOM', label: 'Custom' },
] as const;
const REMINDER_OPTIONS = [
  { value: -1, label: 'None' },
  { value: 0, label: 'At start' },
  { value: 10, label: '10 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' },
  { value: 1_440, label: '1 day' },
] as const;

function deviceId(): string {
  const existing = localStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(DEVICE_KEY, created);
  return created;
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

function addDays(value: string, amount: number): string {
  const date = parseDate(value);
  date.setDate(date.getDate() + amount);
  return dateKey(date);
}

function addMinutes(value: string, amount: number): string {
  const [hour, minute] = value.split(':').map(Number);
  const total = ((hour * 60 + minute + amount) % 1_440 + 1_440) % 1_440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function monthRange(anchor: Date): { from: string; to: string } {
  return {
    from: dateKey(new Date(anchor.getFullYear(), anchor.getMonth(), 1)),
    to: dateKey(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 8)),
  };
}

function itemDate(item: CalendarItem): string {
  if (item.kind === 'birthday') return item.date;
  const value = item.kind === 'event' ? item.start : item.due ?? item.start;
  if (!value) return dateKey(new Date());
  return value.kind === 'date' ? value.date : dateKey(new Date(value.dateTime));
}

function itemOccursOn(item: CalendarItem, day: string): boolean {
  if (item.kind === 'birthday') return item.date.slice(5) === day.slice(5);
  if (item.kind === 'event') {
    if (item.start.kind === 'date' && item.end.kind === 'date') {
      return item.start.date <= day && day < item.end.date;
    }
    const start = item.start.kind === 'dateTime' ? new Date(item.start.dateTime).getTime() : parseDate(item.start.date).getTime();
    const end = item.end.kind === 'dateTime' ? new Date(item.end.dateTime).getTime() : parseDate(item.end.date).getTime();
    const dayStart = new Date(`${day}T00:00:00`).getTime();
    const dayEnd = new Date(`${addDays(day, 1)}T00:00:00`).getTime();
    return start < dayEnd && end > dayStart;
  }
  return itemDate(item) === day;
}

function itemIcon(item: CalendarItem) {
  if (item.kind === 'birthday') return <Gift size={14} aria-label="Birthday" />;
  if (item.kind === 'task') return <ClipboardCheck size={14} aria-label="Task" />;
  return <CalendarDays size={14} aria-label="Event" />;
}

function itemTimeLabel(item: CalendarItem, format: ThemePrefs['calendarTimeFormat']): string {
  if (item.kind === 'birthday') return 'Birthday';
  const value = item.kind === 'event' ? item.start : item.due ?? item.start;
  if (!value || value.kind === 'date') return item.kind === 'task' ? 'All-day task' : 'All day';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: format === 'system' ? undefined : format === '12-hour',
  }).format(new Date(value.dateTime));
}

function recurrenceInstant(item: CalendarItem): number {
  if (!item.recurrenceId) return Number.NaN;
  return item.recurrenceId.kind === 'date'
    ? Date.parse(`${item.recurrenceId.date}T00:00:00.000Z`)
    : Date.parse(item.recurrenceId.dateTime);
}

function priorOccurrenceCount(master: CalendarItem, occurrence: CalendarItem): number {
  const range = calendarItemRange(master);
  const selected = recurrenceInstant(occurrence);
  if (!range || !Number.isFinite(selected)) return 0;
  return Math.max(0, expandRecurringItem(master, range.start - 1, selected + 1, 20_000).length - 1);
}

function formatCalendarDate(date: Date, format: ThemePrefs['calendarDateFormat']): string {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const mm = String(month + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const monthLabel = date.toLocaleDateString(undefined, { month: 'short' });
  switch (format) {
    case 'MMM_D_YYYY': return `${monthLabel} ${day}, ${year}`;
    case 'D_MMM_YYYY': return `${day} ${monthLabel} ${year}`;
    case 'YYYY_MM_DD': return `${year}-${mm}-${dd}`;
    case 'MM_DD_YYYY': return `${mm}/${dd}/${year}`;
    case 'DD_MM_YYYY': return `${dd}/${mm}/${year}`;
  }
}

function calendarOrigin(calendar: CalendarDefinition): string {
  if (calendar.location.kind === 'local') return 'On this device';
  if (calendar.location.kind === 'hosted') {
    try { return new URL(calendar.location.serverUrl).host; } catch { return calendar.location.serverUrl; }
  }
  return calendar.location.kind === 'subscription' ? 'Subscription' : 'Kanban';
}

export function CalendarScreen({ prefs }: { prefs: ThemePrefs }) {
  const syncCalendars = useMobileStore((state) => state.syncCalendars);
  const syncing = useMobileStore((state) => state.calendarSyncing);
  const conflicts = useMobileStore((state) => state.calendarConflicts);
  const mirrorConflicts = useMobileStore((state) => state.calendarMirrorConflicts);
  const mirrorStatuses = useMobileStore((state) => state.calendarMirrorStatuses);
  const mirrorProgress = useMobileStore((state) => state.calendarMirrorProgress);
  const statuses = useMobileStore((state) => state.statuses);
  const [calendars, setCalendars] = useState<CalendarDefinition[]>([]);
  const [sourceItems, setSourceItems] = useState<CalendarItem[]>([]);
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const [view, setView] = useState<MobileCalendarView>('agenda');
  const [selectedDate, setSelectedDate] = useState(() => dateKey(new Date()));
  const [anchor, setAnchor] = useState(() => new Date());
  const [editor, setEditor] = useState<{ kind: CalendarItemKind; item?: CalendarItem; initialTime?: string } | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [invitationsOpen, setInvitationsOpen] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [pendingNotificationItemId, setPendingNotificationItemId] = useState<string | null>(null);
  const [transition, setTransition] = useState<{ direction: -1 | 1; sequence: number }>({ direction: 1, sequence: 0 });
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const loadedOnce = useRef(false);
  const visibilityInitialized = useRef(false);
  const profileId = mobileCalendarProfileId();

  const load = useCallback(async () => {
    if (!loadedOnce.current) setBusy(true);
    setError('');
    try {
      let definitions = (await listProfileCalendars(profileId)).filter((calendar) => !calendar.deletedAt);
      if (definitions.length === 0) {
        const local = createCalendarDefinition({
          location: { kind: 'local', profileId },
          name: 'Personal',
          color: '#a78bfa',
          defaultTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        });
        await saveProfileCalendar(profileId, local);
        definitions = [local];
      }
      const range = monthRange(anchor);
      const loadedItems = await listProfileCalendarItems(profileId, range.from, range.to, 2_000, false);
      setCalendars(definitions);
      const activeIds = new Set(definitions.filter((calendar) => !calendar.archived).map((calendar) => calendar.id));
      setVisibleIds((current) => {
        if (!visibilityInitialized.current) {
          visibilityInitialized.current = true;
          return activeIds;
        }
        return new Set([...current].filter(id => activeIds.has(id)));
      });
      setSourceItems(loadedItems);
      await reconcileProfileCalendarReminders(profileId).catch(() => {
        // Calendar data remains usable if the native scheduler is unavailable.
      });
      loadedOnce.current = true;
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }, [anchor, profileId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>('.app-main');
    if (scroller) scroller.scrollTop = 0;
  }, [view]);

  const currentUserIds = useMemo(() => new Set(Object.values(statuses).flatMap(status => status.user ? [status.user.id] : [])), [statuses]);
  const projectedItems = useMemo(() => {
    const range = monthRange(anchor);
    return queryCalendarItems(sourceItems, {
      ...range,
      limit: 5_000,
      includeUnscheduledTasks: view === 'tasks',
    });
  }, [anchor, sourceItems, view]);
  const visibleItems = useMemo(
    () => projectedItems.filter((item) => visibleIds.has(item.calendarId) && (
      prefs.calendarShowDeclined
      || !item.attendees.some(attendee => attendee.kind === 'collabUser' && currentUserIds.has(attendee.userId) && attendee.response === 'declined')
    )),
    [currentUserIds, prefs.calendarShowDeclined, projectedItems, visibleIds],
  );
  const calendarById = useMemo(() => new Map(calendars.map((calendar) => [calendar.id, calendar])), [calendars]);
  const selectedItems = visibleItems.filter((item) => itemOccursOn(item, selectedDate));
  const taskItems = visibleItems.filter((item) => item.kind === 'task');

  const refresh = async () => {
    await syncCalendars().catch(() => {});
    await load();
  };
  const openAttachment = async (attachment: CalendarAttachment) => {
    if (attachment.kind === 'externalUrl') {
      await openExternalUrl(attachment.url);
      return;
    }
    if (attachment.kind === 'uploaded') return;
    const state = useMobileStore.getState();
    const serverUrl = attachment.serverUrl ?? state.selected?.serverUrl;
    const vaultId = attachment.vaultId ?? state.selected?.vault.id;
    if (!serverUrl || !vaultId) throw new Error('Open the referenced vault to view this attachment.');
    if (state.selected?.serverUrl !== serverUrl || state.selected.vault.id !== vaultId) {
      const vault = (state.vaults[serverUrl] ?? []).find((entry) => entry.id === vaultId);
      if (!vault) throw new Error('The referenced vault is not available on this device.');
      await state.selectVault(serverUrl, vault);
    }
    const current = useMobileStore.getState();
    const file = current.files.find((entry) => entry.id === attachment.fileId || entry.relativePath === attachment.fileId);
    if (!file) throw new Error('The attached file is not available in the referenced vault.');
    current.setTab('files');
    if (attachment.kind === 'kanbanTask') {
      current.openSheet({ kind: 'kanban', fileId: file.id, cardId: attachment.cardId });
    } else if (file.documentType === 'note') {
      current.openSheet({ kind: 'note', fileId: file.id });
    } else if (file.documentType === 'kanban') {
      current.openSheet({ kind: 'kanban', fileId: file.id });
    } else {
      current.openSheet({ kind: file.kind === 'asset' ? 'viewer' : 'fileDetail', fileId: file.id });
    }
    setEditor(null);
  };
  const animate = (direction: -1 | 1) => {
    setTransition((current) => ({ direction, sequence: current.sequence + 1 }));
  };
  const changeView = (next: MobileCalendarView) => {
    if (next === view) return;
    animate(VIEW_OPTIONS.findIndex(option => option.value === next) > VIEW_OPTIONS.findIndex(option => option.value === view) ? 1 : -1);
    setView(next);
  };
  const moveMonth = (direction: -1 | 1) => {
    animate(direction);
    setAnchor((current) => new Date(current.getFullYear(), current.getMonth() + direction, 1));
  };
  const moveDay = (direction: -1 | 1) => {
    animate(direction);
    setSelectedDate((current) => {
      const next = addDays(current, direction);
      setAnchor(parseDate(next));
      return next;
    });
  };
  const moveThreeDay = (direction: -1 | 1) => {
    animate(direction);
    setSelectedDate((current) => {
      const next = addDays(current, direction * 3);
      setAnchor(parseDate(next));
      return next;
    });
  };
  const goToday = () => {
    const today = new Date();
    animate(dateKey(today) >= selectedDate ? 1 : -1);
    setAnchor(today);
    setSelectedDate(dateKey(today));
  };
  const openDay = (date: string) => {
    setSelectedDate(date);
    setAnchor(parseDate(date));
    animate(1);
    setView('day');
  };
  useEffect(() => {
    const openDestination = (event: Event) => {
      const destination = (event as CustomEvent<{ kind?: string; date?: string }>).detail;
      if (!destination) return;
      const targetDate = destination.kind === 'calendar-today'
        ? dateKey(new Date())
        : destination.date;
      if (targetDate && /^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
        setSelectedDate(targetDate);
        setAnchor(parseDate(targetDate));
      }
      if (destination.kind === 'calendar-create') setEditor({ kind: 'event' });
    };
    window.addEventListener('collab-calendar-open-destination', openDestination);
    return () => window.removeEventListener('collab-calendar-open-destination', openDestination);
  }, []);

  useEffect(() => {
    const openNotification = (event: Event) => {
      const destination = (event as CustomEvent<{
        kind?: string;
        itemId?: string;
        occurrenceKey?: string;
      }>).detail;
      if (destination?.kind === 'calendar-invitations') {
        setInvitationsOpen(true);
        return;
      }
      if (destination?.kind !== 'calendar-item' || !destination.itemId) return;
      const occurrence = destination.occurrenceKey;
      const date = occurrence?.startsWith('date:')
        ? occurrence.slice(5, 15)
        : occurrence?.startsWith('dateTime:')
          ? occurrence.slice(9, 19)
          : null;
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) openDay(date);
      setPendingNotificationItemId(destination.itemId);
    };
    window.addEventListener('collab-calendar-open-notification', openNotification);
    return () => window.removeEventListener('collab-calendar-open-notification', openNotification);
  }, []);
  useEffect(() => {
    if (!pendingNotificationItemId) return;
    const item = sourceItems.find((candidate) => candidate.id === pendingNotificationItemId);
    if (!item) return;
    const date = itemDate(item);
    openDay(date);
    setEditor({ kind: item.kind, item });
    setPendingNotificationItemId(null);
  }, [pendingNotificationItemId, sourceItems]);
  const handleInternalTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (view !== 'month' && view !== 'three-day' && view !== 'day') return;
    event.stopPropagation();
    if (event.touches.length !== 1) return;
    swipeStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  };
  const handleInternalTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (view !== 'month' && view !== 'three-day' && view !== 'day') return;
    event.stopPropagation();
    const start = swipeStart.current;
    swipeStart.current = null;
    if (!start || event.changedTouches.length === 0) return;
    const dx = event.changedTouches[0].clientX - start.x;
    const dy = event.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) < INTERNAL_SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.35) return;
    const direction = dx < 0 ? 1 : -1;
    if (view === 'month') moveMonth(direction);
    else if (view === 'three-day') moveThreeDay(direction);
    else moveDay(direction);
  };

  return <div className="screen mobile-calendar-screen">
    <header className="screen-header mobile-calendar-main-head">
      <div><h1>Calendar</h1><p>{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(anchor)}</p></div>
      <div className="screen-header-actions">
        <button type="button" className="calendar-today-button" onClick={goToday}>Today</button>
        <button type="button" className="icon-button calendar-invitation-button" aria-label="Calendar invitations" onClick={() => setInvitationsOpen(true)}><Bell size={17} /></button>
        <button type="button" className="icon-button" aria-label="Sync calendars" onClick={() => void refresh()} disabled={syncing}>{syncing ? <Spinner size={17} /> : <RefreshCw size={17} />}</button>
        <button type="button" className="primary-icon-button" aria-label="New calendar item" onClick={() => setEditor({ kind: 'event' })}><CirclePlus size={20} /></button>
      </div>
    </header>

    {error ? <Banner tone="error">{error}</Banner> : null}
    {Object.values(mirrorProgress).some((entry) => entry.phase === 'checking' || entry.phase === 'applying') ? <Banner tone="info"><span>{Object.values(mirrorProgress).find((entry) => entry.phase === 'applying' || entry.phase === 'checking')?.detail ?? 'Updating calendar mirrors'}</span></Banner> : null}
    {conflicts.length > 0 ? <button type="button" className="calendar-conflict-banner" onClick={() => setConflictsOpen(true)}><span>{conflicts.length} calendar change{conflicts.length === 1 ? '' : 's'} need attention.</span><span>Review</span></button> : null}
    {mirrorStatuses.some((status) => status.state === 'waiting' || status.state === 'conflict' || status.state === 'error') ? <button type="button" className="calendar-conflict-banner" onClick={() => setManagerOpen(true)}><span>{mirrorConflicts.length > 0 ? `${mirrorConflicts.length} mirrored item${mirrorConflicts.length === 1 ? '' : 's'} need attention.` : mirrorStatuses.some((status) => status.state === 'error') ? 'A calendar mirror could not be updated.' : 'A calendar mirror is waiting for a server connection.'}</span><span>Manage</span></button> : null}

    <div className="mobile-calendar-view-tabs" role="group" aria-label="Calendar view">
      {VIEW_OPTIONS.map((option) => <button key={option.value} type="button" className={view === option.value ? 'active' : ''} aria-pressed={view === option.value} onClick={() => changeView(option.value)}>{option.label}</button>)}
    </div>

    <div className="mobile-calendar-sources" aria-label="Visible calendars">
      {calendars.filter((calendar) => !calendar.archived).map((calendar) => <button
        key={calendar.id}
        type="button"
        className={visibleIds.has(calendar.id) ? 'active' : ''}
        aria-pressed={visibleIds.has(calendar.id)}
        onClick={() => setVisibleIds((current) => {
          const next = new Set(current);
          if (next.has(calendar.id)) next.delete(calendar.id); else next.add(calendar.id);
          return next;
        })}
      ><span style={{ background: calendar.color }} /><span>{calendar.name}</span><small>{calendarOrigin(calendar)}</small></button>)}
      <button type="button" className="calendar-manage-button" aria-label="Manage calendars" onClick={() => setManagerOpen(true)}>
        <Settings2 size={15} aria-hidden />
        <span>Manage</span>
      </button>
    </div>

    <div
      key={`${view}-${transition.sequence}`}
      className={`mobile-calendar-content view-${view} ${transition.direction > 0 ? 'calendar-subview-next' : 'calendar-subview-previous'}`}
      onTouchStart={handleInternalTouchStart}
      onTouchEnd={handleInternalTouchEnd}
    >
      {busy ? <div className="calendar-mobile-loading"><Spinner /><span>Loading calendar</span></div> : null}
      {!busy && view === 'month' ? <MonthView anchor={anchor} selectedDate={selectedDate} items={visibleItems} calendarById={calendarById} weekStart={prefs.calendarWeekStart} hideWeekends={prefs.calendarHideWeekends} onStep={moveMonth} onSelect={openDay} onOpen={item => setEditor({ kind: item.kind, item })} /> : null}
      {!busy && view === 'agenda' ? <AgendaView anchor={anchor} items={visibleItems} calendarById={calendarById} dateFormat={prefs.calendarDateFormat} timeFormat={prefs.calendarTimeFormat} onOpen={item => setEditor({ kind: item.kind, item })} /> : null}
      {!busy && view === 'three-day' ? <ThreeDayView startDate={selectedDate} items={visibleItems} calendarById={calendarById} timeFormat={prefs.calendarTimeFormat} workingHoursStart={prefs.calendarWorkingHoursStart} onStep={moveThreeDay} onOpenDay={openDay} onAddAt={(date, initialTime) => { setSelectedDate(date); setAnchor(parseDate(date)); setEditor({ kind: 'event', initialTime }); }} onOpen={item => setEditor({ kind: item.kind, item })} /> : null}
      {!busy && view === 'day' ? <DayView date={selectedDate} items={selectedItems} calendarById={calendarById} dateFormat={prefs.calendarDateFormat} timeFormat={prefs.calendarTimeFormat} workingHoursStart={prefs.calendarWorkingHoursStart} onStep={moveDay} onAddAt={initialTime => setEditor({ kind: 'event', initialTime })} onOpen={item => setEditor({ kind: item.kind, item })} /> : null}
      {!busy && view === 'tasks' ? <ItemList items={taskItems} calendarById={calendarById} timeFormat={prefs.calendarTimeFormat} empty="No tasks" onOpen={item => setEditor({ kind: item.kind, item })} /> : null}
      {!busy && visibleItems.length === 0 && calendars.length === 0 ? <EmptyState icon={<CalendarDays size={28} />} title="No calendars" message="Connect a server or create a local calendar." /> : null}
    </div>

    {editor ? <MobileItemEditor
      request={editor}
      date={selectedDate}
      calendars={calendars.filter((calendar) => (
        !calendar.archived
        && (!calendar.readOnly || calendar.id === editor.item?.calendarId)
      ))}
      sourceItems={sourceItems}
      profileId={profileId}
      prefs={prefs}
      onClose={() => setEditor(null)}
      onOpenAttachment={attachment => void openAttachment(attachment).catch(reason => setError(String(reason)))}
      onSaved={async () => { setEditor(null); await refresh(); }}
    /> : null}
    {managerOpen ? <CalendarManager
      calendars={calendars}
      statuses={statuses}
      mirrorStatuses={mirrorStatuses}
      mirrorConflicts={mirrorConflicts}
      profileId={profileId}
      onClose={() => setManagerOpen(false)}
      onChanged={async (calendarId, visible) => {
        if (calendarId && visible != null) {
          setVisibleIds(current => {
            const next = new Set(current);
            if (visible) next.add(calendarId); else next.delete(calendarId);
            return next;
          });
        }
        await load();
      }}
    /> : null}
    {invitationsOpen ? <MobileInvitations
      origins={Object.values(statuses).flatMap(status => status.connected && status.serverUrl && status.user ? [{ serverUrl: status.serverUrl, userId: status.user.id }] : [])}
      onClose={() => setInvitationsOpen(false)}
      onChanged={refresh}
    /> : null}
    {conflictsOpen ? <CalendarConflictRecovery
      conflicts={conflicts}
      profileId={profileId}
      onClose={() => setConflictsOpen(false)}
      onChanged={refresh}
    /> : null}
  </div>;
}

type HostedInvitation = {
  id: string;
  organizerUserId: string;
  attendeeUserId: string;
  attendeeId: string;
  response: CalendarAttendanceResponse;
  item: CalendarItem;
};

function MobileInvitations({ origins, onClose, onChanged }: {
  origins: Array<{ serverUrl: string; userId: string }>;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  // Back closes this sheet instead of prompting to quit the app.
  useBackDismiss(true, onClose);
  const [invitations, setInvitations] = useState<Array<HostedInvitation & { serverUrl: string }>>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setBusy(true);
    void Promise.all(origins.map(async ({ serverUrl }) => {
      const entries = await hostedCalendarRequest<HostedInvitation[]>(serverUrl, 'GET', '/api/v1/calendars/invitations');
      return entries.map(entry => ({ ...entry, serverUrl }));
    })).then(entries => {
      if (active) setInvitations(entries.flat());
    }).catch(reason => {
      if (active) setError(String(reason));
    }).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [origins]);
  const respond = async (invitation: HostedInvitation & { serverUrl: string }, response: CalendarAttendanceResponse) => {
    setBusy(true);
    setError('');
    try {
      await hostedCalendarRequest(
        invitation.serverUrl,
        'POST',
        `/api/v1/calendars/invitations/${encodeURIComponent(invitation.id)}/response`,
        { response },
      );
      setInvitations(current => current.map(entry => entry.id === invitation.id && entry.serverUrl === invitation.serverUrl ? { ...entry, response } : entry));
      await onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return <div className="sheet-backdrop" onClick={onClose}><div className="sheet calendar-relations-sheet" role="dialog" aria-label="Calendar invitations" onClick={event => event.stopPropagation()}>
    <div className="sheet-handle" />
    <div className="sheet-head"><strong>Invitations</strong><button type="button" className="icon-button" aria-label="Close invitations" onClick={onClose}><X size={18} /></button></div>
    {error ? <Banner tone="error">{error}</Banner> : null}
    {busy && invitations.length === 0 ? <div className="loading-block"><Spinner /><span>Loading invitations</span></div> : null}
    {!busy && invitations.length === 0 ? <EmptyState icon={<Users size={26} />} title="No invitations" message="Meeting invitations from your connected servers appear here." /> : null}
    <div className="calendar-relation-list">{invitations.map(invitation => <article key={`${invitation.serverUrl}:${invitation.id}`}>
      <CalendarDays size={17} />
      <div><strong>{invitation.item.title}</strong><small>{calendarServerLabel(invitation.serverUrl)} · {invitation.response.replace('-', ' ')}</small></div>
      <div>{(['accepted', 'tentative', 'declined'] as CalendarAttendanceResponse[]).map(response => <button key={response} type="button" className={invitation.response === response ? 'active' : ''} disabled={busy} onClick={() => void respond(invitation, response)}>{response === 'accepted' ? 'Accept' : response === 'tentative' ? 'Maybe' : 'Decline'}</button>)}</div>
    </article>)}</div>
  </div></div>;
}

function CalendarConflictRecovery({ conflicts, profileId, onClose, onChanged }: {
  conflicts: ReturnType<typeof useMobileStore.getState>['calendarConflicts'];
  profileId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  // Back closes this sheet instead of prompting to quit the app.
  useBackDismiss(true, onClose);
  const syncCalendars = useMobileStore(state => state.syncCalendars);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const act = async (clientOperationId: string, action: 'retry' | 'discard') => {
    setBusyId(clientOperationId);
    setError('');
    try {
      if (action === 'retry') {
        await retryProfileCalendarOperation(profileId, clientOperationId);
        await syncCalendars();
      } else {
        await discardProfileCalendarOperation(profileId, clientOperationId);
      }
      await onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusyId('');
    }
  };
  return <div className="sheet-backdrop" onClick={onClose}><div className="sheet calendar-relations-sheet" role="dialog" aria-label="Calendar sync issues" onClick={event => event.stopPropagation()}>
    <div className="sheet-handle" />
    <div className="sheet-head"><strong>Sync issues</strong><button type="button" className="icon-button" aria-label="Close sync issues" onClick={onClose}><X size={18} /></button></div>
    {error ? <Banner tone="error">{error}</Banner> : null}
    <div className="calendar-relation-list">{conflicts.map(conflict => {
      const id = conflict.operation.clientOperationId;
      const mutation = conflict.operation.mutation;
      const label = mutation.type === 'upsertItem' ? mutation.item.title : mutation.type === 'deleteItem' ? 'Deleted calendar item' : mutation.type === 'createCalendar' || mutation.type === 'updateCalendar' ? mutation.calendar.name : 'Calendar';
      return <article key={id}><RefreshCw size={17} /><div><strong>{label}</strong><small>{conflict.lastError}</small></div><div><button type="button" disabled={!!busyId} onClick={() => void act(id, 'retry')}>Retry</button><button type="button" className="destructive" disabled={!!busyId} onClick={() => void act(id, 'discard')}>Discard</button></div></article>;
    })}</div>
  </div></div>;
}

type CalendarDraft = {
  calendar?: CalendarDefinition;
  name: string;
  color: string;
  location: CalendarLocation;
};

function CalendarManager({ calendars, statuses, mirrorStatuses, mirrorConflicts, profileId, onClose, onChanged }: {
  calendars: CalendarDefinition[];
  statuses: Record<string, ServerConnectionStatus>;
  mirrorStatuses: CalendarMirrorGroupStatus[];
  mirrorConflicts: CalendarMirrorConflict[];
  profileId: string;
  onClose: () => void;
  onChanged: (calendarId?: string, visible?: boolean) => Promise<void>;
}) {
  // Back closes this sheet instead of prompting to quit the app.
  useBackDismiss(true, onClose);
  const syncCalendars = useMobileStore((state) => state.syncCalendars);
  const [draft, setDraft] = useState<CalendarDraft | null>(null);
  const [mirrorGroups, setMirrorGroups] = useState<CalendarMirrorGroup[]>([]);
  const [mirrorName, setMirrorName] = useState('');
  const [mirrorCalendarIds, setMirrorCalendarIds] = useState<string[]>([]);
  const [addingMirror, setAddingMirror] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const active = calendars.filter(calendar => !calendar.archived && !calendar.deletedAt);
  const archived = calendars.filter(calendar => calendar.archived && !calendar.deletedAt);
  const mirrorEligible = calendars.filter((calendar) => (
    !calendar.archived
    && !calendar.deletedAt
    && !calendar.readOnly
    && (calendar.location.kind === 'local' || calendar.location.kind === 'hosted')
  ));
  useEffect(() => {
    let active = true;
    void listProfileCalendarMirrorGroups(profileId)
      .then((groups) => { if (active) setMirrorGroups(groups); })
      .catch((reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [profileId]);
  const locations = useMemo(() => {
    const local = [{ key: `local:${profileId}`, label: 'On this device', location: { kind: 'local', profileId } as CalendarLocation }];
    const hosted = Object.entries(statuses).flatMap(([key, status]) => (
      status.connected && status.user
        ? [{
            key: `hosted:${key}:${status.user.id}`,
            label: status.serverUrl ? calendarServerLabel(status.serverUrl) : key,
            location: {
              kind: 'hosted',
              serverUrl: status.serverUrl ?? key,
              userId: status.user.id,
            } as CalendarLocation,
          }]
        : []
    ));
    return [...local, ...hosted];
  }, [profileId, statuses]);

  const startCreate = () => setDraft({
    name: '',
    color: CALENDAR_COLORS[0],
    location: locations[0].location,
  });
  const startEdit = (calendar: CalendarDefinition) => setDraft({
    calendar,
    name: calendar.name,
    color: calendar.color,
    location: calendar.location,
  });
  const persistUpdate = async (existing: CalendarDefinition, changes: Partial<CalendarDefinition>) => {
    const calendar = normalizeCalendarDefinition({
      ...existing,
      ...changes,
      revision: existing.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    if (calendar.location.kind === 'hosted') {
      const operation: CalendarOperation = {
        clientOperationId: crypto.randomUUID(),
        deviceId: deviceId(),
        expectedRevision: existing.revision,
        mutation: { type: 'updateCalendar', calendar },
      };
      await saveProfileCalendarWithOperation(profileId, calendar, operation);
      await syncCalendars().catch(() => {});
    } else {
      await saveProfileCalendar(profileId, calendar);
    }
  };
  const saveDraft = async () => {
    if (!draft?.name.trim()) return;
    setSaving(true);
    setError('');
    try {
      let changedCalendarId: string | undefined;
      let changedVisibility: boolean | undefined;
      if (draft.calendar) {
        await persistUpdate(draft.calendar, { name: draft.name.trim(), color: draft.color });
        changedCalendarId = draft.calendar.id;
      } else {
        let calendar = createCalendarDefinition({
          location: draft.location,
          name: draft.name.trim(),
          color: draft.color,
          defaultTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        });
        if (draft.location.kind === 'hosted') {
          calendar = await hostedCalendarRequest<CalendarDefinition>(
            draft.location.serverUrl,
            'POST',
            '/api/v1/calendars',
            calendar,
          );
        }
        await saveProfileCalendar(profileId, calendar);
        changedCalendarId = calendar.id;
        changedVisibility = true;
      }
      setDraft(null);
      await onChanged(changedCalendarId, changedVisibility);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  const setArchived = async (calendar: CalendarDefinition, archivedValue: boolean) => {
    setSaving(true);
    setError('');
    try {
      await persistUpdate(calendar, { archived: archivedValue });
      await onChanged(calendar.id, !archivedValue);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  const exportCalendar = async (calendar: CalendarDefinition) => {
    setSaving(true);
    setError('');
    try {
      const items = await listProfileCalendarItemsForCalendar(profileId, calendar.id);
      const safeName = calendar.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || 'calendar';
      const destination = await showMobileSaveDialog(`${safeName}.ics`);
      if (!destination) return;
      await writeMobileDownloadedFile(
        destination,
        utf8ToBase64(exportCalendarIcs(calendar, items)),
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  const importCalendar = async (calendar: CalendarDefinition) => {
    if (calendar.readOnly) return;
    setSaving(true);
    setError('');
    try {
      const [sourcePath] = await showMobileOpenFiles(['ics']);
      if (!sourcePath) return;
      const [payload, existing] = await Promise.all([
        readFileForUpload(sourcePath),
        listProfileCalendarItemsForCalendar(profileId, calendar.id),
      ]);
      const preview = previewCalendarIcsImport(
        base64ToUtf8(payload.contentBase64),
        calendar,
        existing,
      );
      if (preview.conflicts > 0) {
        throw new Error('The iCalendar file contains conflicting duplicate item identities.');
      }
      const accepted = window.confirm(
        `Import ${preview.creates} new and ${preview.updates} updated item${preview.creates + preview.updates === 1 ? '' : 's'} into ${calendar.name}?${preview.warnings.length > 0 ? `\n\n${preview.warnings.length} unsupported item${preview.warnings.length === 1 ? '' : 's'} will be skipped.` : ''}`,
      );
      if (!accepted) return;
      const items = preview.entries
        .filter((entry) => entry.action === 'create' || entry.action === 'update')
        .map((entry) => entry.item);
      const operations = items.map((item): CalendarOperation => ({
        clientOperationId: crypto.randomUUID(),
        deviceId: deviceId(),
        expectedRevision: Math.max(0, item.revision - 1),
        mutation: { type: 'upsertItem', item },
      }));
      await upsertProfileCalendarItems(
        profileId,
        items.map((item, index) => [item, operations[index]]),
      );
      if (calendar.location.kind === 'hosted') {
        for (let index = 0; index < operations.length; index += 500) {
          const batch = operations.slice(index, index + 500);
          await hostedCalendarRequest(
            calendar.location.serverUrl,
            'POST',
            '/api/v1/calendars/operations',
            { operations: batch },
          );
          await acknowledgeProfileCalendarOperations(
            profileId,
            batch.map((operation) => operation.clientOperationId),
          );
        }
      } else {
        await acknowledgeProfileCalendarOperations(
          profileId,
          operations.map((operation) => operation.clientOperationId),
        );
      }
      await syncCalendars().catch(() => {});
      await onChanged(calendar.id, true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  const saveMirror = async () => {
    if (!mirrorName.trim() || mirrorCalendarIds.length < 2) return;
    const now = new Date().toISOString();
    const group: CalendarMirrorGroup = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      name: mirrorName.trim(),
      enabled: true,
      members: mirrorCalendarIds.map((calendarId) => {
        const calendar = mirrorEligible.find((entry) => entry.id === calendarId);
        if (!calendar || (calendar.location.kind !== 'local' && calendar.location.kind !== 'hosted')) {
          throw new Error('A selected mirror calendar is no longer available.');
        }
        return {
          id: crypto.randomUUID(),
          calendarId,
          location: calendar.location,
          addedAt: now,
        };
      }),
      createdAt: now,
      updatedAt: now,
    };
    setSaving(true);
    setError('');
    try {
      validateCalendarMirrorGroup(group, calendars);
      await saveProfileCalendarMirrorGroup(profileId, group);
      setMirrorGroups((current) => [...current, group]);
      setMirrorName('');
      setMirrorCalendarIds([]);
      setAddingMirror(false);
      await syncCalendars().catch(() => {});
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  const toggleMirror = async (group: CalendarMirrorGroup, enabled: boolean) => {
    const updated = { ...group, enabled, updatedAt: new Date().toISOString() };
    setSaving(true);
    setError('');
    try {
      await saveProfileCalendarMirrorGroup(profileId, updated);
      setMirrorGroups((current) => current.map((entry) => entry.id === group.id ? updated : entry));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  const deleteMirror = async (groupId: string) => {
    setSaving(true);
    setError('');
    try {
      await deleteProfileCalendarMirrorGroup(profileId, groupId);
      setMirrorGroups((current) => current.filter((group) => group.id !== groupId));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  const resolveMirror = async (
    group: CalendarMirrorGroup,
    conflict: CalendarMirrorConflict,
    memberId: string,
  ) => {
    const origins = Object.values(statuses).flatMap((status) => (
      status.connected && status.serverUrl && status.user
        ? [{ serverUrl: status.serverUrl, userId: status.user.id }]
        : []
    ));
    setSaving(true);
    setError('');
    try {
      await resolveMobileCalendarMirrorConflict(group, conflict, memberId, origins);
      await syncCalendars();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  const selectedMirrorLocations = new Set(mirrorCalendarIds.flatMap((calendarId) => {
    const calendar = mirrorEligible.find((entry) => entry.id === calendarId);
    return calendar && (calendar.location.kind === 'local' || calendar.location.kind === 'hosted')
      ? [calendarMirrorLocationKey({ location: calendar.location })]
      : [];
  }));

  return <div className="sheet-backdrop" onClick={onClose}>
    <div className="sheet calendar-manager-sheet" role="dialog" aria-label="Manage calendars" onClick={event => event.stopPropagation()}>
      <div className="sheet-handle" />
      <div className="sheet-head">
        <strong>Calendars</strong>
        <button type="button" className="icon-button" aria-label="Close calendar manager" onClick={onClose}><X size={18} /></button>
      </div>
      {error ? <Banner tone="error">{error}</Banner> : null}
      <button type="button" className="calendar-manager-add" onClick={startCreate} disabled={saving}><Plus size={16} />Add calendar</button>
      <div className="calendar-manager-list">
        {active.map(calendar => <CalendarManagerRow key={calendar.id} calendar={calendar} saving={saving} onEdit={startEdit} onImport={() => void importCalendar(calendar)} onExport={() => void exportCalendar(calendar)} onArchive={() => void setArchived(calendar, true)} />)}
        {archived.length > 0 ? <h3>Archived</h3> : null}
        {archived.map(calendar => <CalendarManagerRow key={calendar.id} calendar={calendar} saving={saving} onEdit={startEdit} onImport={() => void importCalendar(calendar)} onExport={() => void exportCalendar(calendar)} onArchive={() => void setArchived(calendar, false)} />)}
      </div>
      <section className="calendar-mirror-manager" aria-labelledby="mobile-calendar-mirrors">
        <div className="calendar-mirror-manager-head"><h3 id="mobile-calendar-mirrors">Mirrors</h3><button type="button" className="icon-button" aria-label="Add calendar mirror" disabled={saving} onClick={() => setAddingMirror((current) => !current)}><Link2 size={16} /></button></div>
        {mirrorGroups.map((group) => {
          const status = mirrorStatuses.find((entry) => entry.groupId === group.id);
          const conflicts = mirrorConflicts.filter((entry) => entry.groupId === group.id);
          return <div key={group.id} className="calendar-mirror-manager-group"><div className="calendar-mirror-manager-row">
            <button type="button" className={group.enabled ? 'active' : ''} aria-pressed={group.enabled} disabled={saving} onClick={() => void toggleMirror(group, !group.enabled)}><Link2 size={15} /></button>
            <div><strong>{group.name}</strong><small>{status?.state === 'waiting' ? 'Waiting for connection' : status?.state === 'conflict' ? `${status.conflictCount} conflict${status.conflictCount === 1 ? '' : 's'}` : status?.state === 'error' ? status.error ?? 'Sync error' : group.enabled ? 'Ready to sync' : 'Paused'}</small></div>
            {status?.state === 'waiting' ? <CloudOff size={15} className="calendar-mirror-waiting" /> : <span />}
            <button type="button" className="icon-button" aria-label={`Delete ${group.name}`} disabled={saving} onClick={() => void deleteMirror(group.id)}><Trash2 size={15} /></button>
          </div>{conflicts.map((conflict) => <div key={conflict.id} className="calendar-mirror-conflict"><strong>Choose the version to keep</strong>{conflict.versions.map((version) => {
            const member = group.members.find((entry) => entry.id === version.memberId);
            const calendar = member && calendars.find((entry) => entry.id === member.calendarId);
            return <button key={version.memberId} type="button" disabled={saving || !member} onClick={() => void resolveMirror(group, conflict, version.memberId)}><span style={{ background: calendar?.color }} /><span><strong>{version.item?.deletedAt || !version.item ? 'Deleted' : version.item.title}</strong><small>{calendar?.name ?? 'Unavailable calendar'} · {calendar ? calendarOrigin(calendar) : 'Unknown location'}</small></span></button>;
          })}</div>)}</div>;
        })}
        {mirrorGroups.length === 0 && !addingMirror ? <p className="calendar-manager-origin">No mirror groups yet.</p> : null}
        {addingMirror ? <div className="calendar-manager-editor">
          <label className="form-field"><span>Name</span><input aria-label="Mirror name" value={mirrorName} onChange={(event) => setMirrorName(event.target.value)} autoFocus /></label>
          <fieldset className="calendar-mirror-calendar-list"><legend>Calendars</legend>{mirrorEligible.map((calendar) => {
            const checked = mirrorCalendarIds.includes(calendar.id);
            const locationKey = calendarMirrorLocationKey({ location: calendar.location as Extract<CalendarLocation, { kind: 'local' | 'hosted' }> });
            const unavailable = !checked && selectedMirrorLocations.has(locationKey);
            return <button key={calendar.id} type="button" className={checked ? 'active' : ''} disabled={unavailable || saving} onClick={() => setMirrorCalendarIds((current) => checked ? current.filter((id) => id !== calendar.id) : [...current, calendar.id])}><span style={{ background: calendar.color }} /><strong>{calendar.name}</strong><small>{calendarOrigin(calendar)}</small></button>;
          })}</fieldset>
          <div className="form-actions"><button type="button" className="ghost-button" onClick={() => setAddingMirror(false)}>Cancel</button><button type="button" className="primary-button" disabled={saving || !mirrorName.trim() || mirrorCalendarIds.length < 2} onClick={() => void saveMirror()}>{saving ? <Spinner /> : null}Create mirror</button></div>
        </div> : null}
      </section>
      {draft ? <div className="calendar-manager-editor">
        <h3>{draft.calendar ? 'Edit calendar' : 'New calendar'}</h3>
        <label className="form-field"><span>Name</span><input aria-label="Calendar name" value={draft.name} onChange={event => setDraft(current => current ? { ...current, name: event.target.value } : current)} autoFocus /></label>
        {!draft.calendar ? <fieldset className="calendar-manager-locations"><legend>Location</legend>{locations.map(option => {
          const selected = calendarLocationKey(draft.location) === calendarLocationKey(option.location);
          return <button key={option.key} type="button" className={selected ? 'active' : ''} onClick={() => setDraft(current => current ? { ...current, location: option.location } : current)}>{option.location.kind === 'local' ? 'Device' : 'Server'}<small>{option.label}</small></button>;
        })}</fieldset> : <p className="calendar-manager-origin">Stored in {calendarOrigin(draft.calendar)}</p>}
        <fieldset className="calendar-manager-colors"><legend>Accent color</legend>{CALENDAR_COLORS.map(color => <button key={color} type="button" className={draft.color === color ? 'active' : ''} aria-label={`Use color ${color}`} aria-pressed={draft.color === color} style={{ '--calendar-color': color } as CSSProperties} onClick={() => setDraft(current => current ? { ...current, color } : current)} />)}</fieldset>
        <div className="form-actions"><button type="button" className="ghost-button" onClick={() => setDraft(null)}>Cancel</button><button type="button" className="primary-button" disabled={saving || !draft.name.trim()} onClick={() => void saveDraft()}>{saving ? <Spinner /> : null}{draft.calendar ? 'Save' : 'Create'}</button></div>
      </div> : null}
    </div>
  </div>;
}

function CalendarManagerRow({ calendar, saving, onEdit, onImport, onExport, onArchive }: {
  calendar: CalendarDefinition;
  saving: boolean;
  onEdit: (calendar: CalendarDefinition) => void;
  onImport: () => void;
  onExport: () => void;
  onArchive: () => void;
}) {
  return <div className="calendar-manager-row">
    <span style={{ background: calendar.color }} />
    <div><strong>{calendar.name}</strong><small>{calendarOrigin(calendar)}{calendar.readOnly ? ' · Read only' : ''}</small></div>
    <button type="button" className="icon-button" aria-label={`Import into ${calendar.name}`} disabled={saving || calendar.readOnly} onClick={onImport}><FileUp size={15} /></button>
    <button type="button" className="icon-button" aria-label={`Export ${calendar.name}`} disabled={saving} onClick={onExport}><FileDown size={15} /></button>
    <button type="button" className="icon-button" aria-label={`Edit ${calendar.name}`} disabled={saving || calendar.readOnly} onClick={() => onEdit(calendar)}><Pencil size={15} /></button>
    <button type="button" className="icon-button" aria-label={`${calendar.archived ? 'Restore' : 'Archive'} ${calendar.name}`} disabled={saving || calendar.readOnly} onClick={onArchive}>{calendar.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}</button>
  </div>;
}

function calendarLocationKey(location: CalendarLocation): string {
  if (location.kind === 'local') return `local:${location.profileId}`;
  if (location.kind === 'hosted') return `hosted:${location.serverUrl}:${location.userId}`;
  if (location.kind === 'subscription') return `subscription:${location.subscriptionId}`;
  return `kanban:${location.originKey}`;
}

function calendarServerLabel(serverUrl: string): string {
  try { return new URL(serverUrl).host; } catch { return serverUrl; }
}

function MonthView({ anchor, selectedDate, items, calendarById, weekStart, hideWeekends, onStep, onSelect, onOpen }: {
  anchor: Date; selectedDate: string; items: CalendarItem[]; calendarById: Map<string, CalendarDefinition>;
  weekStart: 0 | 1; hideWeekends: boolean;
  onStep: (direction: -1 | 1) => void; onSelect: (date: string) => void; onOpen: (item: CalendarItem) => void;
}) {
  const todayKey = dateKey(new Date());
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1 - ((first.getDay() - weekStart + 7) % 7));
  const fullDays = Array.from({ length: 42 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
  const days = hideWeekends ? fullDays.filter(day => day.getDay() !== 0 && day.getDay() !== 6) : fullDays;
  const weekdayDates = Array.from({ length: 7 }, (_, index) => new Date(2026, 6, 5 + ((weekStart + index) % 7)))
    .filter(day => !hideWeekends || (day.getDay() !== 0 && day.getDay() !== 6));
  const columnStyle = { gridTemplateColumns: `repeat(${hideWeekends ? 5 : 7}, minmax(0, 1fr))` };
  return <section className="calendar-mobile-month">
    <div className="mobile-calendar-toolbar">
      <button type="button" className="icon-button" aria-label="Previous month" onClick={() => onStep(-1)}><ChevronLeft size={18} /></button>
      <strong>{new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(anchor)}</strong>
      <button type="button" className="icon-button" aria-label="Next month" onClick={() => onStep(1)}><ChevronRight size={18} /></button>
    </div>
    <div className="calendar-mobile-weekdays" style={columnStyle}>{weekdayDates.map(day => <span key={day.getDay()}>{day.toLocaleDateString(undefined, { weekday: 'narrow' })}</span>)}</div>
    <div className="calendar-mobile-grid" style={columnStyle}>{days.map(day => {
      const key = dateKey(day);
      const dayItems = items.filter(item => itemOccursOn(item, key));
      return <div
        key={key}
        className={`calendar-mobile-cell ${day.getMonth() === anchor.getMonth() ? '' : 'outside'} ${selectedDate === key ? 'selected' : ''} ${todayKey === key ? 'today' : ''}`}
        onClick={() => onSelect(key)}
      >
        <button
          type="button"
          className="calendar-mobile-date"
          aria-current={todayKey === key ? 'date' : undefined}
          aria-label={day.toLocaleDateString()}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(key);
          }}
        >{day.getDate()}</button>
        <div className="calendar-mobile-cell-items">
          {dayItems.slice(0, 3).map(item => {
            const color = calendarById.get(item.calendarId)?.color ?? '#a78bfa';
            return <button
              key={item.id}
              type="button"
              className="calendar-mobile-entry"
              style={{ '--calendar-entry-color': color } as CSSProperties}
              onClick={(event) => {
                event.stopPropagation();
                onOpen(item);
              }}
            >{item.title}</button>;
          })}
          {dayItems.length > 3 ? <span className="calendar-mobile-more">+{dayItems.length - 3}</span> : null}
        </div>
      </div>;
    })}</div>
  </section>;
}

function AgendaView({ anchor, items, calendarById, dateFormat, timeFormat, onOpen }: { anchor: Date; items: CalendarItem[]; calendarById: Map<string, CalendarDefinition>; dateFormat: ThemePrefs['calendarDateFormat']; timeFormat: ThemePrefs['calendarTimeFormat']; onOpen: (item: CalendarItem) => void }) {
  const dayCount = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  const days = Array.from({ length: dayCount }, (_, index) => dateKey(new Date(anchor.getFullYear(), anchor.getMonth(), index + 1)));
  const populated = days.map(day => ({ day, items: items.filter(item => itemOccursOn(item, day)) })).filter(group => group.items.length > 0);
  return <div className="calendar-mobile-agenda">{populated.length === 0 ? <EmptyState icon={<CalendarDays size={26} />} title="Nothing scheduled" message="This month has no visible calendar items." /> : populated.map(group => <section key={group.day}><h2>{parseDate(group.day).toLocaleDateString(undefined, { weekday: 'long' })}, {formatCalendarDate(parseDate(group.day), dateFormat)}</h2><ItemList items={group.items} calendarById={calendarById} timeFormat={timeFormat} onOpen={onOpen} /></section>)}</div>;
}

function calendarClockLabel(date: Date, format: ThemePrefs['calendarTimeFormat']): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: format === 'system' ? undefined : format === '12-hour',
  }).format(date);
}

function timelineItemRangeLabel(item: CalendarItem, format: ThemePrefs['calendarTimeFormat']): string {
  if (item.kind === 'birthday') return 'Birthday';
  const start = item.kind === 'event' ? item.start : item.start ?? item.due;
  const end = item.kind === 'event' ? item.end : item.due;
  if (start?.kind !== 'dateTime') return itemTimeLabel(item, format);
  const startLabel = calendarClockLabel(new Date(start.dateTime), format);
  return end?.kind === 'dateTime'
    ? `${startLabel} - ${calendarClockLabel(new Date(end.dateTime), format)}`
    : startLabel;
}

function TimelineColumn({ date, items, calendarById, timeFormat, onAddAt, onOpen }: {
  date: string;
  items: CalendarItem[];
  calendarById: Map<string, CalendarDefinition>;
  timeFormat: ThemePrefs['calendarTimeFormat'];
  onAddAt: (time: string) => void;
  onOpen: (item: CalendarItem) => void;
}) {
  const now = new Date();
  const today = date === dateKey(now);
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  const timedItems = layoutCalendarTimedItems(items, date);
  return <div className="calendar-mobile-time-column">
    {Array.from({ length: 48 }, (_, index) => {
      const minute = index * 30;
      const initialTime = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      return <button
        key={minute}
        type="button"
        className="calendar-mobile-time-slot"
        aria-label={`Create event on ${date} at ${calendarClockLabel(new Date(2026, 0, 1, Math.floor(minute / 60), minute % 60), timeFormat)}`}
        style={{ top: minute / 60 * MOBILE_DAY_HOUR_HEIGHT, height: MOBILE_DAY_HOUR_HEIGHT / 2 }}
        onClick={() => onAddAt(initialTime)}
      />;
    })}
    {Array.from({ length: 24 }, (_, hour) => <div key={hour} className="calendar-mobile-hour-line" style={{ top: hour * MOBILE_DAY_HOUR_HEIGHT }} />)}
    {today ? <div className="calendar-mobile-now" style={{ top: nowMinute / 60 * MOBILE_DAY_HOUR_HEIGHT }}><i /></div> : null}
    {timedItems.map(entry => {
      const color = calendarById.get(entry.item.calendarId)?.color ?? '#a78bfa';
      const width = 100 / entry.columnCount;
      return <button
        key={entry.item.id}
        type="button"
        className="calendar-mobile-timed-item"
        style={{
          '--calendar-entry-color': color,
          top: entry.startMinute / 60 * MOBILE_DAY_HOUR_HEIGHT,
          height: Math.max(28, (entry.endMinute - entry.startMinute) / 60 * MOBILE_DAY_HOUR_HEIGHT),
          left: `calc(${entry.column * width}% + 2px)`,
          width: `calc(${width}% - 4px)`,
        } as CSSProperties}
        onClick={() => onOpen(entry.item)}
      >
        <span>{itemIcon(entry.item)}<strong>{entry.item.title}</strong></span>
        <small>{timelineItemRangeLabel(entry.item, timeFormat)}</small>
      </button>;
    })}
  </div>;
}

function TimelineGutter({ timeFormat }: { timeFormat: ThemePrefs['calendarTimeFormat'] }) {
  return <div className="calendar-mobile-time-gutter">
    {Array.from({ length: 24 }, (_, hour) => <span key={hour} style={{ top: hour * MOBILE_DAY_HOUR_HEIGHT }}>{calendarClockLabel(new Date(2026, 0, 1, hour), timeFormat)}</span>)}
  </div>;
}

function ThreeDayView({ startDate, items, calendarById, timeFormat, workingHoursStart, onStep, onOpenDay, onAddAt, onOpen }: {
  startDate: string;
  items: CalendarItem[];
  calendarById: Map<string, CalendarDefinition>;
  timeFormat: ThemePrefs['calendarTimeFormat'];
  workingHoursStart: string;
  onStep: (direction: -1 | 1) => void;
  onOpenDay: (date: string) => void;
  onAddAt: (date: string, time: string) => void;
  onOpen: (item: CalendarItem) => void;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const days = Array.from({ length: 3 }, (_, index) => addDays(startDate, index));
  const dayGroups = days.map(date => {
    const dayItems = items.filter(item => itemOccursOn(item, date));
    const timedIds = new Set(layoutCalendarTimedItems(dayItems, date).map(entry => entry.item.id));
    return { date, items: dayItems, allDayItems: dayItems.filter(item => !timedIds.has(item.id)) };
  });
  const hasAllDayItems = dayGroups.some(group => group.allDayItems.length > 0);
  const rangeStart = parseDate(days[0]);
  const rangeEnd = parseDate(days[2]);
  const rangeLabel = rangeStart.getMonth() === rangeEnd.getMonth()
    ? `${rangeStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${rangeEnd.getDate()}`
    : `${rangeStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${rangeEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

  useEffect(() => {
    const scroller = rootRef.current?.closest<HTMLElement>('.mobile-calendar-content');
    if (!scroller) return;
    const includesToday = days.includes(dateKey(new Date()));
    const focusHour = includesToday
      ? Math.max(0, new Date().getHours() - 1)
      : Math.max(0, Number(workingHoursStart.slice(0, 2)) - 1);
    scroller.scrollTop = focusHour * MOBILE_DAY_HOUR_HEIGHT;
  }, [startDate, workingHoursStart]);

  return <section ref={rootRef} className="calendar-mobile-three-day">
    <div className="mobile-calendar-toolbar calendar-mobile-day-toolbar">
      <button type="button" className="icon-button" aria-label="Previous three days" onClick={() => onStep(-1)}><ChevronLeft size={18} /></button>
      <strong>{rangeLabel}</strong>
      <button type="button" className="icon-button" aria-label="Next three days" onClick={() => onStep(1)}><ChevronRight size={18} /></button>
    </div>
    <div className="calendar-mobile-three-day-head">
      <span />
      {days.map(date => {
        const parsed = parseDate(date);
        const today = date === dateKey(new Date());
        return <button key={date} type="button" aria-label={`Open ${parsed.toLocaleDateString()} day view`} onClick={() => onOpenDay(date)}>
          <small>{parsed.toLocaleDateString(undefined, { weekday: 'short' })}</small>
          <strong className={today ? 'today' : ''}>{parsed.getDate()}</strong>
        </button>;
      })}
    </div>
    {hasAllDayItems ? <div className="calendar-mobile-three-day-all-day">
      <span>All day</span>
      {dayGroups.map(group => <div key={group.date}>{group.allDayItems.slice(0, 2).map(item => {
        const color = calendarById.get(item.calendarId)?.color ?? '#a78bfa';
        return <button key={item.id} type="button" style={{ '--calendar-entry-color': color } as CSSProperties} onClick={() => onOpen(item)}>{item.title}</button>;
      })}{group.allDayItems.length > 2 ? <small>+{group.allDayItems.length - 2}</small> : null}</div>)}
    </div> : null}
    <div className="calendar-mobile-three-day-timeline" style={{ height: MOBILE_DAY_HOUR_HEIGHT * 24 }}>
      <TimelineGutter timeFormat={timeFormat} />
      {dayGroups.map(group => <TimelineColumn key={group.date} date={group.date} items={group.items} calendarById={calendarById} timeFormat={timeFormat} onAddAt={time => onAddAt(group.date, time)} onOpen={onOpen} />)}
    </div>
  </section>;
}

function DayView({ date, items, calendarById, dateFormat, timeFormat, workingHoursStart, onStep, onAddAt, onOpen }: {
  date: string;
  items: CalendarItem[];
  calendarById: Map<string, CalendarDefinition>;
  dateFormat: ThemePrefs['calendarDateFormat'];
  timeFormat: ThemePrefs['calendarTimeFormat'];
  workingHoursStart: string;
  onStep: (direction: -1 | 1) => void;
  onAddAt: (time: string) => void;
  onOpen: (item: CalendarItem) => void;
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const today = date === dateKey(new Date());
  const timedItems = layoutCalendarTimedItems(items, date);
  const timedIds = new Set(timedItems.map(entry => entry.item.id));
  const allDayItems = items.filter(item => !timedIds.has(item.id));
  const now = new Date();

  useEffect(() => {
    const scroller = rootRef.current?.closest<HTMLElement>('.mobile-calendar-content');
    if (!scroller) return;
    const workingHour = Number(workingHoursStart.slice(0, 2));
    const focusHour = today ? Math.max(0, now.getHours() - 1) : Math.max(0, workingHour - 1);
    scroller.scrollTop = focusHour * MOBILE_DAY_HOUR_HEIGHT;
  }, [date, today, workingHoursStart]);

  return <section ref={rootRef} className={`calendar-mobile-day ${today ? 'today' : ''}`}>
    <div className="mobile-calendar-toolbar calendar-mobile-day-toolbar">
      <button type="button" className="icon-button" aria-label="Previous day" onClick={() => onStep(-1)}><ChevronLeft size={18} /></button>
      <strong aria-current={today ? 'date' : undefined}>{formatCalendarDate(parseDate(date), dateFormat)}</strong>
      <button type="button" className="icon-button" aria-label="Next day" onClick={() => onStep(1)}><ChevronRight size={18} /></button>
    </div>
    {allDayItems.length > 0 ? <div className="calendar-mobile-all-day">
      <span>All day</span>
      <div>{allDayItems.map(item => {
        const color = calendarById.get(item.calendarId)?.color ?? '#a78bfa';
        return <button
          key={item.id}
          type="button"
          style={{ '--calendar-entry-color': color } as CSSProperties}
          onClick={() => onOpen(item)}
        >{itemIcon(item)}<span>{item.title}</span></button>;
      })}</div>
    </div> : null}
    <div className="calendar-mobile-timeline" style={{ height: MOBILE_DAY_HOUR_HEIGHT * 24 }}>
      <TimelineGutter timeFormat={timeFormat} />
      <TimelineColumn date={date} items={items} calendarById={calendarById} timeFormat={timeFormat} onAddAt={onAddAt} onOpen={onOpen} />
    </div>
  </section>;
}

function ItemList({ items, calendarById, timeFormat, empty, onOpen }: { items: CalendarItem[]; calendarById: Map<string, CalendarDefinition>; timeFormat: ThemePrefs['calendarTimeFormat']; empty?: string; onOpen: (item: CalendarItem) => void }) {
  if (items.length === 0 && empty) return <p className="calendar-mobile-empty">{empty}</p>;
  return <div className="calendar-mobile-items">{items.map(item => {
    const calendar = calendarById.get(item.calendarId);
    return <button key={item.id} type="button" onClick={() => onOpen(item)} style={{ borderLeftColor: calendar?.color }}>{itemIcon(item)}<span><strong>{item.title}</strong><small>{itemTimeLabel(item, timeFormat)} · {calendar?.name ?? 'Calendar'} · {item.kind}</small></span></button>;
  })}</div>;
}

function MobileItemEditor({ request, date, calendars, sourceItems, profileId, prefs, onClose, onSaved, onOpenAttachment }: {
  request: { kind: CalendarItemKind; item?: CalendarItem; initialTime?: string }; date: string; calendars: CalendarDefinition[]; sourceItems: CalendarItem[]; profileId: string;
  prefs: ThemePrefs;
  onClose: () => void; onSaved: () => Promise<void>; onOpenAttachment: (attachment: CalendarAttachment) => void;
}) {
  // Back closes this sheet instead of prompting to quit the app.
  useBackDismiss(true, onClose);
  const [kind, setKind] = useState<CalendarItemKind>(request.kind);
  const [title, setTitle] = useState(request.item?.title ?? '');
  const [calendarId, setCalendarId] = useState(request.item?.calendarId ?? calendars[0]?.id ?? '');
  const [startDate, setStartDate] = useState(request.item?.kind === 'task'
    ? request.item.start?.kind === 'date' ? request.item.start.date : request.item.start?.dateTime.slice(0, 10) ?? ''
    : request.item ? itemDate(request.item) : date);
  const [endDate, setEndDate] = useState(request.item?.kind === 'task'
    ? request.item.due?.kind === 'date' ? request.item.due.date : request.item.due?.dateTime.slice(0, 10) ?? ''
    : request.item?.kind === 'event' && request.item.end.kind === 'date' ? addDays(request.item.end.date, -1) : request.item ? itemDate(request.item) : date);
  const existingStart = request.item?.kind === 'event' ? request.item.start : request.item?.kind === 'task' ? request.item.start ?? request.item.due : undefined;
  const existingEnd = request.item?.kind === 'event' ? request.item.end : request.item?.kind === 'task' ? request.item.due ?? request.item.start : undefined;
  const [allDay, setAllDay] = useState(existingStart ? existingStart.kind !== 'dateTime' : false);
  const initialStartTime = request.initialTime ?? '09:00';
  const [startTime, setStartTime] = useState(existingStart?.kind === 'dateTime' ? new Date(existingStart.dateTime).toTimeString().slice(0, 5) : initialStartTime);
  const [endTime, setEndTime] = useState(existingEnd?.kind === 'dateTime' ? new Date(existingEnd.dateTime).toTimeString().slice(0, 5) : addMinutes(initialStartTime, prefs.calendarDefaultDurationMinutes));
  const [description, setDescription] = useState(request.item?.description ?? '');
  const initialRule = request.item?.recurrence?.rrule ?? '';
  const knownRule = RECURRENCE_OPTIONS.some(option => option.value === initialRule);
  const [recurrence, setRecurrence] = useState(knownRule ? initialRule : initialRule ? 'CUSTOM' : '');
  const [customRecurrence, setCustomRecurrence] = useState(knownRule ? '' : initialRule);
  const [reminders, setReminders] = useState<number[]>(() => {
    const relative = request.item?.reminders.flatMap(entry => entry.kind === 'relative' ? [entry.minutesBefore] : []) ?? [];
    return request.item ? relative : prefs.calendarDefaultReminderMinutes === null ? [] : [prefs.calendarDefaultReminderMinutes];
  });
  const [customReminder, setCustomReminder] = useState('120');
  const [taskStatus, setTaskStatus] = useState<CalendarTaskStatus>(request.item?.kind === 'task' ? request.item.status : 'needs-action');
  const [location, setLocation] = useState(request.item?.kind === 'event' ? request.item.location?.label ?? '' : '');
  const [attendees, setAttendees] = useState<CalendarAttendee[]>(request.item?.attendees ?? []);
  const [attachments, setAttachments] = useState<CalendarAttachment[]>(request.item?.attachments ?? []);
  const [editScope, setEditScope] = useState<CalendarRecurrenceEditScope>('occurrence');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const syncCalendars = useMobileStore((state) => state.syncCalendars);
  const selectedCalendar = calendars.find(entry => entry.id === calendarId);
  const kanbanBound = request.item?.sourceBinding?.kind === 'kanban';

  const persistItem = async (item: CalendarItem) => {
    const existing = sourceItems.find(entry => entry.id === item.id);
    if (item.kind === 'task' && existing?.kind === 'task'
      && existing.sourceBinding?.kind === 'kanban') {
      const binding = existing.sourceBinding;
      if (!binding.serverUrl || !binding.vaultId) {
        throw new Error('The source Kanban vault is not available on this device.');
      }
      await hostedRequest(
        binding.serverUrl,
        'POST',
        `/api/v1/vaults/${encodeURIComponent(binding.vaultId)}/files/${encodeURIComponent(binding.fileId)}/kanban-cards/${encodeURIComponent(binding.cardId)}/calendar`,
        {
          expectedSourceRevision: binding.sourceRevision ?? 0,
          ...calendarTaskToKanbanPatch(item),
        },
      );
      return;
    }
    const normalized = normalizeCalendarItem({
      ...item,
      revision: existing ? existing.revision + 1 : item.revision,
      createdAt: existing?.createdAt ?? item.createdAt,
      updatedAt: new Date().toISOString(),
    });
    const calendar = calendars.find(entry => entry.id === normalized.calendarId);
    if (!calendar) throw new Error('Calendar is not available.');
    const operation: CalendarOperation = {
      clientOperationId: crypto.randomUUID(),
      deviceId: deviceId(),
      expectedRevision: existing?.revision ?? 0,
      mutation: { type: 'upsertItem', item: normalized },
    };
    await upsertProfileCalendarItem(profileId, normalized, operation);
    if (calendar.location.kind === 'local') await acknowledgeProfileCalendarOperations(profileId, [operation.clientOperationId]);
  };

  const save = async () => {
    const calendar = calendars.find(entry => entry.id === calendarId);
    if (!calendar || !title.trim()) return;
    setSaving(true);
    setError('');
    try {
      const now = new Date().toISOString();
      const id = request.item?.id ?? crypto.randomUUID();
      const rule = recurrence === 'CUSTOM' ? customRecurrence.trim() : recurrence;
      const base = {
        id, uid: request.item?.uid ?? `${id}@collab.mobile`, calendarId, title: title.trim(),
        description: description.trim() || undefined,
        reminders: reminders.map(minutesBefore => ({ kind: 'relative' as const, minutesBefore })),
        attendees, attachments,
        recurrence: rule ? { rrule: rule } : undefined,
        recurrenceId: request.item?.recurrenceId,
        recurrenceSeriesId: request.item?.recurrenceSeriesId,
        sourceBinding: request.item?.sourceBinding,
        revision: request.item?.revision ?? 0,
        createdAt: request.item?.createdAt ?? now, updatedAt: now,
      };
      const timeZone = calendar.defaultTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const startValue = startDate
        ? allDay
          ? { kind: 'date' as const, date: startDate }
          : { kind: 'dateTime' as const, dateTime: new Date(`${startDate}T${startTime}`).toISOString(), timeZone }
        : undefined;
      const endValue = endDate
        ? allDay
          ? { kind: 'date' as const, date: endDate }
          : { kind: 'dateTime' as const, dateTime: new Date(`${endDate}T${endTime}`).toISOString(), timeZone }
        : undefined;
      const item = kind === 'event'
        ? normalizeCalendarItem({ ...base, kind, start: startValue!, end: allDay ? { kind: 'date', date: addDays(endDate, 1) } : endValue!, location: location.trim() ? { label: location.trim(), address: location.trim() } : undefined, availability: request.item?.kind === 'event' ? request.item.availability : 'busy' })
        : kind === 'task'
          ? normalizeCalendarItem({ ...base, kind, start: startValue, due: endValue, status: taskStatus, priority: request.item?.kind === 'task' ? request.item.priority : undefined, completedAt: taskStatus === 'completed' ? (request.item?.kind === 'task' ? request.item.completedAt : undefined) ?? now : undefined })
          : normalizeCalendarItem({ ...base, kind, date: startDate, birthYear: request.item?.kind === 'birthday' ? request.item.birthYear : undefined });
      let planned = [item];
      if (!kanbanBound && request.item?.recurrenceId && request.item.recurrenceSeriesId) {
        const master = sourceItems.find(entry => entry.id === request.item?.recurrenceSeriesId);
        if (!master?.recurrence) throw new Error('The recurring series is not available in the local cache.');
        const recurrenceKey = calendarTimeValueKey(request.item.recurrenceId);
        const existingException = sourceItems.find(entry => entry.uid === master.uid
          && entry.recurrenceId != null
          && calendarTimeValueKey(entry.recurrenceId) === recurrenceKey);
        planned = planRecurringEdit({
          master,
          originalOccurrence: request.item,
          editedOccurrence: item,
          scope: editScope,
          now,
          exceptionId: existingException?.id ?? crypto.randomUUID(),
          followingSeriesId: crypto.randomUUID(),
          priorOccurrences: priorOccurrenceCount(master, request.item),
        }).upserts;
      }
      for (const plannedItem of planned) await persistItem(plannedItem);
      await syncCalendars().catch(() => {});
      await onSaved();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!request.item) return;
    setSaving(true);
    setError('');
    try {
      let target = request.item;
      if (target.recurrenceId && target.recurrenceSeriesId) {
        const master = sourceItems.find(entry => entry.id === target.recurrenceSeriesId);
        if (!master?.recurrence) throw new Error('The recurring series is not available in the local cache.');
        if (editScope === 'occurrence') {
          const exdates = [...(master.recurrence.exdates ?? [])];
          if (!exdates.some(value => calendarTimeValueKey(value) === calendarTimeValueKey(target.recurrenceId!))) exdates.push(target.recurrenceId);
          await persistItem({ ...master, recurrence: { ...master.recurrence, exdates } });
          await syncCalendars().catch(() => {});
          await onSaved();
          return;
        }
        if (editScope === 'following') {
          const recurrence = splitRecurrence(master.recurrence, target.recurrenceId, priorOccurrenceCount(master, target)).previous;
          if (recurrence) {
            await persistItem({ ...master, recurrence });
            await syncCalendars().catch(() => {});
            await onSaved();
            return;
          }
        }
        target = master;
      }
      const calendar = calendars.find(entry => entry.id === target.calendarId);
      if (!calendar) throw new Error('Calendar is not available.');
      const deletedAt = new Date().toISOString();
      const operation: CalendarOperation = {
        clientOperationId: crypto.randomUUID(),
        deviceId: deviceId(),
        expectedRevision: target.revision,
        mutation: { type: 'deleteItem', calendarId: target.calendarId, itemId: target.id, deletedAt },
      };
      await deleteProfileCalendarItem(profileId, target.calendarId, target.id, deletedAt, operation);
      if (calendar.location.kind === 'local') await acknowledgeProfileCalendarOperations(profileId, [operation.clientOperationId]);
      await syncCalendars().catch(() => {});
      await onSaved();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };
  return <div className="sheet-backdrop" onClick={onClose}><div className="sheet calendar-item-sheet" role="dialog" aria-label={request.item ? 'Edit calendar item' : 'New calendar item'} onClick={event => event.stopPropagation()}>
    <div className="sheet-handle" />
    <div className="sheet-head"><strong>{request.item ? 'Edit item' : 'New item'}</strong><button type="button" className="icon-button" aria-label="Close editor" onClick={onClose}><X size={18} /></button></div>
    {error ? <Banner tone="error">{error}</Banner> : null}
    {kanbanBound ? <Banner tone="info">Dates, completion, and supported recurrence write back to Kanban. Other details remain source-owned.</Banner> : null}
    <div className="calendar-kind-picker" role="group" aria-label="Item type">{(['event', 'task', 'birthday'] as CalendarItemKind[]).map(value => <button key={value} type="button" className={kind === value ? 'active' : ''} disabled={!!request.item} onClick={() => setKind(value)}>{value === 'event' ? <CalendarDays size={15} /> : value === 'task' ? <ClipboardCheck size={15} /> : <Gift size={15} />}{value}</button>)}</div>
    <label className="form-field"><span>Title</span><input value={title} onChange={event => setTitle(event.target.value)} autoFocus disabled={kanbanBound} /></label>
    <fieldset className="calendar-editor-calendars" disabled={kanbanBound}><legend>Calendar</legend>{calendars.map(calendar => <button key={calendar.id} type="button" className={calendarId === calendar.id ? 'active' : ''} aria-pressed={calendarId === calendar.id} onClick={() => setCalendarId(calendar.id)}><span style={{ background: calendar.color }} /><span>{calendar.name}</span><small>{calendarOrigin(calendar)}</small></button>)}</fieldset>
    {kind !== 'birthday' ? <button type="button" role="switch" aria-checked={allDay} className="calendar-all-day-toggle" disabled={kanbanBound} onClick={() => setAllDay(value => !value)}><span aria-hidden><i /></span><b>All day</b></button> : null}
    <label className="form-field"><span>{kind === 'birthday' ? 'Birthday' : 'Start'}</span><DateField value={startDate || undefined} onChange={value => {
      if (value || kanbanBound) setStartDate(value ?? '');
    }} />{kind !== 'birthday' && !allDay && startDate ? <TimeField label="Start time" format={prefs.calendarTimeFormat} value={startTime} onChange={(value) => {
      setStartTime(value);
      setEndTime(addMinutes(value, prefs.calendarDefaultDurationMinutes));
    }} /> : null}</label>
    {kind !== 'birthday' ? <label className="form-field"><span>{kind === 'task' ? 'Deadline' : 'End'}</span><DateField value={endDate || undefined} min={startDate || undefined} onChange={value => {
      if (value || kanbanBound) setEndDate(value ?? '');
    }} /></label> : null}
    {kind !== 'birthday' && !allDay && endDate ? <div className="form-field"><span>{kind === 'task' ? 'Deadline time' : 'End time'}</span><TimeField label={kind === 'task' ? 'Deadline time' : 'End time'} format={prefs.calendarTimeFormat} value={endTime} onChange={setEndTime} /></div> : null}
    {kind === 'task' ? <fieldset className="calendar-editor-options"><legend>Status</legend>{(['needs-action', 'in-progress', 'completed', 'cancelled'] as CalendarTaskStatus[]).filter(value => !kanbanBound || value === 'needs-action' || value === 'completed').map(value => <button key={value} type="button" className={taskStatus === value ? 'active' : ''} onClick={() => setTaskStatus(value)}>{value.replace('-', ' ')}</button>)}</fieldset> : null}
    {kind !== 'birthday' ? <><fieldset className="calendar-editor-options"><legend>Repeats</legend>{RECURRENCE_OPTIONS.map(option => <button key={option.value || 'none'} type="button" className={recurrence === option.value ? 'active' : ''} onClick={() => setRecurrence(option.value)}>{option.label}</button>)}</fieldset>{recurrence === 'CUSTOM' ? <label className="form-field"><span>Recurrence rule</span><input aria-label="Recurrence rule" value={customRecurrence} onChange={event => setCustomRecurrence(event.target.value)} placeholder="FREQ=WEEKLY;INTERVAL=2" /></label> : null}{request.item?.recurrenceId ? <fieldset className="calendar-editor-options"><legend>Apply changes to</legend>{([
      ['occurrence', 'This occurrence'],
      ['following', 'This and following'],
      ['series', 'Entire series'],
    ] as const).map(([value, label]) => <button key={value} type="button" className={editScope === value ? 'active' : ''} onClick={() => setEditScope(value)}>{label}</button>)}</fieldset> : null}</> : null}
    {kind === 'event' ? <label className="form-field"><span>Location</span><div className="calendar-location-field"><MapPin size={16} aria-hidden /><input aria-label="Location" value={location} onChange={event => setLocation(event.target.value)} placeholder="Place or address" /><button type="button" aria-label="Open location in maps" disabled={!location.trim()} onClick={() => void openExternalUrl(`geo:0,0?q=${encodeURIComponent(location.trim())}`).catch(reason => setError(String(reason)))}><MapPin size={16} /></button></div></label> : null}
    {!kanbanBound ? <fieldset className="calendar-editor-options"><legend>Reminders</legend>{REMINDER_OPTIONS.map(option => {
      const active = option.value < 0 ? reminders.length === 0 : reminders.includes(option.value);
      return <button key={option.value} type="button" className={active ? 'active' : ''} onClick={() => setReminders(current => {
        if (option.value < 0) return [];
        return current.includes(option.value) ? current.filter(value => value !== option.value) : [...current, option.value].sort((left, right) => left - right);
      })}>{option.label}</button>;
    })}<div className="calendar-custom-reminder"><input aria-label="Custom reminder minutes" inputMode="numeric" type="number" min={1} max={525600} value={customReminder} onChange={event => setCustomReminder(event.target.value)} /><span>minutes before</span><button type="button" disabled={!Number(customReminder) || reminders.includes(Number(customReminder))} onClick={() => setReminders(current => [...current, Number(customReminder)].sort((left, right) => left - right))}>Add</button></div></fieldset> : null}
    {kind !== 'birthday' && !kanbanBound ? <label className="form-field"><span>Description</span><textarea rows={4} value={description} onChange={event => setDescription(event.target.value)} /></label> : null}
    {kind === 'event' ? <MobileAttendeeEditor calendar={selectedCalendar} attendees={attendees} onChange={setAttendees} /> : null}
    {kind !== 'birthday' && !kanbanBound ? <MobileAttachmentEditor calendar={selectedCalendar} attachments={attachments} onChange={setAttachments} onOpen={onOpenAttachment} /> : null}
    <div className="form-actions calendar-item-actions">{request.item && !kanbanBound ? <button type="button" className="ghost-button destructive" disabled={saving} onClick={() => void remove()}><Trash2 size={15} />Delete</button> : null}<span /><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={saving || !title.trim() || !calendarId || (recurrence === 'CUSTOM' && !customRecurrence.trim())} onClick={() => void save()}>{saving ? <Spinner /> : null}{request.item ? 'Save' : 'Create'}</button></div>
  </div></div>;
}

function MobileAttendeeEditor({ calendar, attendees, onChange }: {
  calendar?: CalendarDefinition;
  attendees: CalendarAttendee[];
  onChange: (attendees: CalendarAttendee[]) => void;
}) {
  const hosted = calendar?.location.kind === 'hosted' ? calendar.location : null;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserDirectoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!hosted || query.trim().length < 2) {
      setResults([]);
      return;
    }
    let active = true;
    setBusy(true);
    const timeout = window.setTimeout(() => {
      void hostedUserDirectory(hosted.serverUrl, query.trim())
        .then(entries => { if (active) setResults(entries); })
        .catch(() => { if (active) setResults([]); })
        .finally(() => { if (active) setBusy(false); });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [hosted?.serverUrl, query]);
  if (!hosted) return null;
  const add = (entry: UserDirectoryEntry) => {
    if (attendees.some(attendee => attendee.kind === 'collabUser' && attendee.userId === entry.userId)) return;
    onChange([...attendees, {
      id: crypto.randomUUID(),
      kind: 'collabUser',
      serverUrl: hosted.serverUrl,
      userId: entry.userId,
      displayName: entry.displayName || entry.username,
      response: 'needs-action',
      role: 'required',
    }]);
    setQuery('');
    setResults([]);
  };
  return <section className="calendar-editor-relations"><h3><Users size={15} />People</h3>{attendees.map(attendee => <div className="calendar-editor-relation" key={attendee.id}><Users size={15} /><span><strong>{attendee.displayName ?? (attendee.kind === 'email' ? attendee.email : attendee.userId)}</strong><small>{attendee.role} · {attendee.response.replace('-', ' ')}</small></span><button type="button" aria-label={`Remove ${attendee.displayName ?? 'attendee'}`} onClick={() => onChange(attendees.filter(entry => entry.id !== attendee.id))}><X size={15} /></button></div>)}
    <label className="calendar-relation-search"><UserPlus size={15} /><input aria-label="Search server users" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search people on this server" />{busy ? <Spinner size={14} /> : null}</label>
    {query.trim().length >= 2 && !busy ? <div className="calendar-relation-results">{results.map(entry => <button key={entry.userId} type="button" onClick={() => add(entry)}><span>{entry.displayName || entry.username}</span><small>@{entry.username}</small></button>)}{results.length === 0 ? <small>No people found</small> : null}</div> : null}
  </section>;
}

function MobileAttachmentEditor({ calendar, attachments, onChange, onOpen }: {
  calendar?: CalendarDefinition;
  attachments: CalendarAttachment[];
  onChange: (attachments: CalendarAttachment[]) => void;
  onOpen: (attachment: CalendarAttachment) => void;
}) {
  const selected = useMobileStore(state => state.selected);
  const files = useMobileStore(state => state.files);
  const [showFiles, setShowFiles] = useState(false);
  const [boards, setBoards] = useState<Array<{ fileId: string; fileName: string; cardId: string; cardTitle: string }>>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const referenceOrigin = selected ? { serverUrl: selected.serverUrl, vaultId: selected.vault.id } : {};
  const attachFile = (fileId: string) => {
    const file = files.find(entry => entry.id === fileId);
    if (!file || attachments.some(entry => entry.kind === 'vaultFile' && entry.fileId === file.id)) return;
    onChange([...attachments, { id: crypto.randomUUID(), kind: 'vaultFile', name: file.name, fileId: file.id, path: file.relativePath, ...referenceOrigin }]);
    setShowFiles(false);
  };
  const loadKanbanCards = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const entries = await Promise.all(files.filter(file => file.documentType === 'kanban').map(async file => {
        const document = await readHostedDocument(selected.serverUrl, selected.vault.id, file.id);
        const board = normalizeKanbanBoard(JSON.parse(document.content));
        return board.columns.flatMap(column => column.cards.map(card => ({ fileId: file.id, fileName: file.name, cardId: card.id, cardTitle: card.title })));
      }));
      setBoards(entries.flat());
    } finally {
      setBusy(false);
    }
  };
  const attachCard = (entry: { fileId: string; fileName: string; cardId: string; cardTitle: string }) => {
    if (attachments.some(attachment => attachment.kind === 'kanbanTask' && attachment.fileId === entry.fileId && attachment.cardId === entry.cardId)) return;
    onChange([...attachments, { id: crypto.randomUUID(), kind: 'kanbanTask', name: entry.cardTitle, fileId: entry.fileId, cardId: entry.cardId, ...referenceOrigin }]);
  };
  const addUrl = () => {
    try {
      const parsed = new URL(url.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) return;
      onChange([...attachments, { id: crypto.randomUUID(), kind: 'externalUrl', name: parsed.hostname, url: parsed.toString() }]);
      setUrl('');
    } catch {
      // Keep invalid input available for correction.
    }
  };
  const upload = async () => {
    if (calendar?.location.kind !== 'hosted') return;
    const [sourcePath] = await showMobileOpenFiles(['pdf', 'txt', 'md', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'csv', 'json', 'ics']);
    if (!sourcePath) return;
    setBusy(true);
    try {
      const payload = await readFileForUpload(sourcePath);
      const uploaded = await hostedCalendarRequest<{ id: string; name: string; mediaType?: string; sizeBytes?: number }>(
        calendar.location.serverUrl,
        'POST',
        `/api/v1/calendars/${encodeURIComponent(calendar.id)}/attachments`,
        { name: payload.name, mediaType: payload.mediaType, contentBase64: payload.contentBase64 },
      );
      onChange([...attachments, { id: crypto.randomUUID(), kind: 'uploaded', name: uploaded.name || payload.name, attachmentId: uploaded.id, contentType: uploaded.mediaType || payload.mediaType, sizeBytes: uploaded.sizeBytes }]);
    } finally {
      setBusy(false);
    }
  };
  return <section className="calendar-editor-relations"><h3><Paperclip size={15} />Attachments</h3>{attachments.map(attachment => <div className="calendar-editor-relation" key={attachment.id}>{attachment.kind === 'kanbanTask' ? <SquareKanban size={15} /> : attachment.kind === 'externalUrl' ? <Link size={15} /> : <Paperclip size={15} />}<button type="button" className="calendar-attachment-open" disabled={attachment.kind === 'uploaded'} onClick={() => onOpen(attachment)}><strong>{attachment.name}</strong><small>{attachment.kind === 'kanbanTask' ? 'Kanban task' : attachment.kind === 'vaultFile' ? 'Vault file' : attachment.kind === 'externalUrl' ? 'Web link' : 'Uploaded file'}</small></button><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => onChange(attachments.filter(entry => entry.id !== attachment.id))}><X size={15} /></button></div>)}
    <div className="calendar-attachment-actions">{selected ? <button type="button" onClick={() => setShowFiles(value => !value)}><Paperclip size={15} />Vault file</button> : null}{selected ? <button type="button" disabled={busy} onClick={() => void loadKanbanCards()}><SquareKanban size={15} />Kanban task</button> : null}{calendar?.location.kind === 'hosted' ? <button type="button" disabled={busy} onClick={() => void upload()}><Paperclip size={15} />Upload</button> : null}</div>
    {showFiles ? <div className="calendar-relation-results">{files.filter(file => file.kind !== 'folder').map(file => <button key={file.id} type="button" onClick={() => attachFile(file.id)}><span>{file.name}</span><small>{file.relativePath}</small></button>)}</div> : null}
    {boards.length > 0 ? <div className="calendar-relation-results">{boards.map(entry => <button key={`${entry.fileId}:${entry.cardId}`} type="button" onClick={() => attachCard(entry)}><span>{entry.cardTitle}</span><small>{entry.fileName}</small></button>)}</div> : null}
    <div className="calendar-attachment-url"><input aria-label="Attachment URL" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://..." /><button type="button" disabled={!url.trim()} onClick={addUrl}>Add link</button></div>
  </section>;
}
