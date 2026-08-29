import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createPortal } from 'react-dom';

import {
  closestCorners,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Bot,
  Calendar,
  CalendarDays,
  Check,
  ChevronDown,
  Clock3,
  Filter,
  Flag,
  GanttChart,
  LayoutDashboard,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Trash2,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';

import { tauriCommands } from '../../lib/tauri';
import { cn } from '../../lib/utils';
import { createVaultClient } from '../../lib/vaultClient';
import { useCollabStore } from '../../store/collabStore';
import { useKanbanStore } from '../../store/kanbanStore';
import { formatDate, useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import type { KanbanAutomationAction } from '../../types/kanban';
import {
  applyCardSwimlaneValue,
  type ColumnSortField,
  getActiveBoardFilter,
  getCardAttachmentPaths,
  getFilteredBoard,
  getKanbanBoardStats,
  getMissingColumnDefaultTags,
  type KanbanAutomationRule,
  type KanbanCard,
  type KanbanColumn,
  type KanbanFilterSpec,
  type KanbanPriority,
  type KanbanSwimlaneMode,
  mergeUniqueTags,
  runKanbanAutomations,
  syncChecklistReferences,
} from '../../types/kanban';
import type {
  KanbanAutomationPreset,
  KanbanFilterPreset,
  TemplateSource,
} from '../../types/template';
import { useKanbanContext } from '../../views/KanbanPage';
import LivePeers from '../collaboration/LivePeers';
import { DocumentStatusPill } from '../layout/DocumentStatusPill';
import {
  DocumentTopBar,
  DocumentTopBarButton,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../layout/DocumentTopBar';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

import CalendarView from './CalendarView';
import CardDialog from './CardDialog';
import KanbanCardView from './KanbanCard';
import KanbanColumnView from './KanbanColumn';
import TimelineView from './TimelineView';

interface MoveTagsPromptState {
  cardId: string;
  cardTitle: string;
  columnId: string;
  columnTitle: string;
  missingTags: string[];
}

const KANBAN_LANE_DROP_PREFIX = 'lane:';

function parseLaneDropId(id: string): { columnId: string; laneKey: string } | null {
  if (!id.startsWith(KANBAN_LANE_DROP_PREFIX)) return null;
  const remainder = id.slice(KANBAN_LANE_DROP_PREFIX.length);
  const separatorIndex = remainder.indexOf(':');
  if (separatorIndex === -1) return null;
  return {
    columnId: decodeURIComponent(remainder.slice(0, separatorIndex)),
    laneKey: decodeURIComponent(remainder.slice(separatorIndex + 1)),
  };
}

function getLaneValueFromKey(laneKey: string) {
  const separatorIndex = laneKey.indexOf(':');
  if (separatorIndex === -1) return null;
  const value = laneKey.slice(separatorIndex + 1);
  return value === 'none' ? null : value;
}

function presetToken(source: TemplateSource, name: string) {
  return `${source}:${name}`;
}

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const PRIORITY_BADGES: Record<'high' | 'medium' | 'low', { label: string; cls: string }> = {
  high: { label: 'High', cls: 'bg-red-500/20 text-red-400 border-red-500/30' },
  medium: { label: 'Medium', cls: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' },
  low: { label: 'Low', cls: 'bg-green-500/20 text-green-400 border-green-500/30' },
};
const SORT_FIELDS: { field: ColumnSortField; label: string }[] = [
  { field: 'none', label: 'Manual (default)' },
  { field: 'name', label: 'Name' },
  { field: 'priority', label: 'Priority' },
  { field: 'createdAt', label: 'Creation date' },
  { field: 'startDate', label: 'Start date' },
  { field: 'dueDate', label: 'Due date' },
  { field: 'assignees', label: 'Assignees' },
];
const SWIMLANE_OPTIONS: { value: KanbanSwimlaneMode; label: string }[] = [
  { value: 'none', label: 'No swimlanes' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'priority', label: 'Priority' },
  { value: 'tag', label: 'Tag' },
  { value: 'dueStatus', label: 'Due status' },
];

type AutomationConditionKind =
  'overdue' | 'dueWithinDays' | 'hasTag' | 'column' | 'priority' | 'assigneeState' | 'doneState';
type AutomationActionKind =
  'moveToColumn' | 'addTag' | 'removeTag' | 'setPriority' | 'setDone' | 'assignUser';

interface AutomationDraft {
  name: string;
  trigger: KanbanAutomationRule['trigger'];
  conditionKind: AutomationConditionKind;
  conditionValue: string;
  actionKind: AutomationActionKind;
  actionValue: string;
}

function makeDefaultAutomationDraft(): AutomationDraft {
  return {
    name: '',
    trigger: 'manual',
    conditionKind: 'overdue',
    conditionValue: '',
    actionKind: 'moveToColumn',
    actionValue: '',
  };
}

function buildAutomationRuleFromDraft(draft: AutomationDraft): KanbanAutomationRule {
  const name = draft.name.trim() || 'Automation rule';
  const condition =
    draft.conditionKind === 'overdue'
      ? { overdue: true }
      : draft.conditionKind === 'dueWithinDays'
        ? { dueWithinDays: Math.max(0, Number(draft.conditionValue) || 0) }
        : draft.conditionKind === 'hasTag'
          ? { hasTag: draft.conditionValue.trim() }
          : draft.conditionKind === 'column'
            ? { columnId: draft.conditionValue }
            : draft.conditionKind === 'priority'
              ? { priority: (draft.conditionValue || 'none') as KanbanPriority | 'none' }
              : draft.conditionKind === 'assigneeState'
                ? { assigneeState: (draft.conditionValue || 'empty') as 'empty' | 'present' }
                : { isDone: draft.conditionValue === 'done' };

  const action: KanbanAutomationAction =
    draft.actionKind === 'moveToColumn'
      ? { type: 'moveToColumn', columnId: draft.actionValue }
      : draft.actionKind === 'addTag'
        ? { type: 'addTag', tag: draft.actionValue.trim() }
        : draft.actionKind === 'removeTag'
          ? { type: 'removeTag', tag: draft.actionValue.trim() }
          : draft.actionKind === 'setPriority'
            ? {
                type: 'setPriority',
                priority: (draft.actionValue || 'none') as KanbanPriority | 'none',
              }
            : draft.actionKind === 'setDone'
              ? { type: 'setDone', isDone: draft.actionValue === 'done' }
              : { type: 'assignUser', userId: draft.actionValue || null };

  return {
    id: crypto.randomUUID(),
    name,
    enabled: true,
    trigger: draft.trigger,
    condition,
    action,
  };
}

function describeAutomationRule(rule: KanbanAutomationRule, columns: KanbanColumn[]) {
  const action = rule.action;
  const conditionText = rule.condition.overdue
    ? 'when overdue'
    : typeof rule.condition.dueWithinDays === 'number'
      ? `when due within ${rule.condition.dueWithinDays} day(s)`
      : rule.condition.hasTag
        ? `when tagged ${rule.condition.hasTag}`
        : rule.condition.columnId
          ? `when in ${columns.find((column) => column.id === rule.condition.columnId)?.title ?? rule.condition.columnId}`
          : rule.condition.priority
            ? `when priority is ${rule.condition.priority}`
            : rule.condition.assigneeState
              ? `when assignee is ${rule.condition.assigneeState}`
              : typeof rule.condition.isDone === 'boolean'
                ? `when ${rule.condition.isDone ? 'done' : 'not done'}`
                : 'when matched';

  const actionText =
    action.type === 'moveToColumn'
      ? `move to ${columns.find((column) => column.id === action.columnId)?.title ?? action.columnId}`
      : action.type === 'addTag'
        ? `add tag ${action.tag}`
        : action.type === 'removeTag'
          ? `remove tag ${action.tag}`
          : action.type === 'setPriority'
            ? `set priority to ${action.priority}`
            : action.type === 'setDone'
              ? `mark ${action.isDone ? 'done' : 'not done'}`
              : `assign ${action.userId ?? 'nobody'}`;

  return `${conditionText}, ${actionText}`;
}

function archiveSearchText(card: KanbanCard) {
  return [
    card.title,
    card.description,
    ...card.tags,
    ...getCardAttachmentPaths(card),
    ...card.checklist.map((item) => item.text),
    ...card.comments.map((comment) => comment.content),
    card.archivedByUserName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function sortCards(
  cards: KanbanCard[],
  column: KanbanColumn,
  knownUsers: Array<{ userId: string; userName: string }>,
) {
  const sort = column.sort;
  if (!sort || sort.field === 'none') return cards;
  const next = [...cards];
  next.sort((a, b) => {
    let cmp = 0;
    switch (sort.field) {
      case 'name':
        cmp = a.title.localeCompare(b.title);
        break;
      case 'priority': {
        const pa = PRIORITY_ORDER[a.priority ?? ''] ?? 3;
        const pb = PRIORITY_ORDER[b.priority ?? ''] ?? 3;
        cmp = pa - pb;
        break;
      }
      case 'createdAt':
        cmp = (a.createdAt ?? 0) - (b.createdAt ?? 0);
        break;
      case 'startDate':
        cmp = (a.startDate ?? '').localeCompare(b.startDate ?? '');
        break;
      case 'dueDate':
        cmp = (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
        break;
      case 'assignees': {
        const aName =
          knownUsers.find((user) => a.assignees[0] === user.userId)?.userName ??
          a.assignees[0] ??
          '';
        const bName =
          knownUsers.find((user) => b.assignees[0] === user.userId)?.userName ??
          b.assignees[0] ??
          '';
        cmp = aName.localeCompare(bName);
        break;
      }
    }
    return sort.dir === 'asc' ? cmp : -cmp;
  });
  return next;
}

function clearArchivedState(card: KanbanCard) {
  return {
    ...card,
    archived: undefined,
    archivedColumnId: undefined,
    archivedAt: undefined,
    archivedByUserId: undefined,
    archivedByUserName: undefined,
  };
}

function ArchiveView({ onOpenCard }: { onOpenCard: (card: KanbanCard, columnId: string) => void }) {
  const { board, updateBoard, knownUsers } = useKanbanContext();
  const { dateFormat } = useUiStore();
  const [searchQuery, setSearchQuery] = useState('');
  const normalizedQuery = searchQuery.trim().toLowerCase();

  function setColumnSort(columnId: string, field: ColumnSortField) {
    updateBoard((prev) => ({
      ...prev,
      columns: prev.columns.map((column) => {
        if (column.id !== columnId) return column;
        if (field === 'none') return { ...column, sort: undefined };
        const dir = column.sort?.field === field && column.sort.dir === 'asc' ? 'desc' : 'asc';
        return { ...column, sort: { field, dir } };
      }),
    }));
  }

  const archivedGroups = board.columns
    .map((col) => ({
      col,
      cards: sortCards(
        col.cards
          .filter((card) => card.archived)
          .filter((card) => !normalizedQuery || archiveSearchText(card).includes(normalizedQuery)),
        col,
        knownUsers,
      ),
    }))
    .filter((group) => group.cards.length > 0);

  const totalArchived = archivedGroups.reduce((count, group) => count + group.cards.length, 0);

  function restoreCard(cardId: string, columnId: string) {
    updateBoard((prev) => ({
      ...prev,
      columns: prev.columns.map((col) =>
        col.id !== columnId
          ? col
          : {
              ...col,
              cards: col.cards.map((card) =>
                card.id !== cardId ? card : clearArchivedState(card),
              ),
            },
      ),
    }));
  }

  if (totalArchived === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="rounded-2xl border border-dashed border-border/50 bg-muted/10 px-6 py-8 text-center">
          <Archive size={24} className="mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-sm font-medium text-foreground">
            {normalizedQuery ? 'No archived cards match this search' : 'Archive is empty'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {normalizedQuery
              ? 'Try a different title, tag, checklist, or attachment term.'
              : 'Archived cards will show up here.'}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="mb-4 sticky top-0 z-10 bg-background/90 backdrop-blur-sm-webkit pb-3">
        <div className="relative max-w-md">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/60"
          />
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search archived cards..."
            className="h-9 pl-9 text-sm"
          />
        </div>
      </div>

      <div className="grid gap-4">
        {archivedGroups.map(({ col, cards }) => (
          <section
            key={col.id}
            className="rounded-2xl border border-border/40 bg-card/30 overflow-hidden"
          >
            <div className="flex items-center justify-between gap-3 border-b border-border/30 px-4 py-3">
              <div className="flex items-center gap-2">
                <div
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: col.color ?? '#64748b' }}
                />
                <span className="text-sm font-semibold text-foreground">{col.title}</span>
                {col.sort && col.sort.field !== 'none' && (
                  <span
                    title={`Sorted by ${col.sort.field} (${col.sort.dir})`}
                    className="shrink-0"
                  >
                    {col.sort.dir === 'asc' ? (
                      <ArrowUp size={11} className="text-primary/60" />
                    ) : (
                      <ArrowDown size={11} className="text-primary/60" />
                    )}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {cards.length} {cards.length === 1 ? 'archived card' : 'archived cards'}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent/50 hover:text-foreground"
                      aria-label={`Sort archived cards in ${col.title}`}
                    >
                      <MoreHorizontal size={13} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="text-xs">
                        <ArrowUpDown size={11} className="mr-2" />
                        Sort by
                        {col.sort && col.sort.field !== 'none' && (
                          <span className="ml-auto text-[10px] text-primary/70 capitalize">
                            {col.sort.field}
                          </span>
                        )}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="w-48">
                        {SORT_FIELDS.map(({ field, label }) => {
                          const isActive =
                            field === 'none'
                              ? !col.sort || col.sort.field === 'none'
                              : col.sort?.field === field;
                          const dir = isActive && field !== 'none' ? col.sort?.dir : null;
                          return (
                            <DropdownMenuItem
                              key={field}
                              onClick={() => setColumnSort(col.id, field)}
                              className="text-xs"
                            >
                              <span className="flex-1">{label}</span>
                              {isActive && field === 'none' && (
                                <Check size={11} className="text-primary/70" />
                              )}
                              {dir === 'asc' && <ArrowUp size={11} className="text-primary/70" />}
                              {dir === 'desc' && (
                                <ArrowDown size={11} className="text-primary/70" />
                              )}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <div className="divide-y divide-border/20">
              {cards.map((card) => {
                const attachments = getCardAttachmentPaths(card);
                const assigneeNames = card.assignees
                  .map(
                    (userId) =>
                      knownUsers.find((user) => user.userId === userId)?.userName ?? userId,
                  )
                  .filter(Boolean);
                return (
                  <div key={card.id} className="flex items-start gap-3 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onOpenCard(card, col.id)}
                      className="flex-1 min-w-0 text-left rounded-lg transition-colors hover:bg-accent/25 px-2 py-1.5 -mx-2 -my-1.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {card.title}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            {card.archivedAt && (
                              <span className="flex items-center gap-1">
                                <Clock3 size={11} />
                                {new Date(card.archivedAt).toLocaleString()}
                              </span>
                            )}
                            {card.archivedByUserName && (
                              <span>Archived by {card.archivedByUserName}</span>
                            )}
                            {card.priority && (
                              <span
                                className={cn(
                                  'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-medium capitalize',
                                  PRIORITY_BADGES[card.priority].cls,
                                )}
                              >
                                <Flag size={11} />
                                {PRIORITY_BADGES[card.priority].label}
                              </span>
                            )}
                            {assigneeNames.length > 0 && (
                              <span className="flex items-center gap-1">
                                <Users size={11} />
                                {assigneeNames.join(', ')}
                              </span>
                            )}
                            {card.startDate && (
                              <span className="flex items-center gap-1">
                                <Calendar size={11} />
                                Start{' '}
                                {formatDate(new Date(`${card.startDate}T12:00:00`), dateFormat)}
                              </span>
                            )}
                            {card.dueDate && (
                              <span className="flex items-center gap-1">
                                <Calendar size={11} />
                                Due {formatDate(new Date(`${card.dueDate}T12:00:00`), dateFormat)}
                              </span>
                            )}
                            {attachments.length > 0 && (
                              <span>
                                {attachments.length} attachment{attachments.length === 1 ? '' : 's'}
                              </span>
                            )}
                            {card.checklist.length > 0 && (
                              <span>
                                {card.checklist.filter((item) => item.checked).length}/
                                {card.checklist.length} tasks
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="shrink-0 text-[11px] text-muted-foreground">Open</span>
                      </div>
                    </button>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => restoreCard(card.id, col.id)}
                    >
                      <ArchiveRestore size={12} />
                      Restore
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

// ── Main board ────────────────────────────────────────────────────────────────

export default function KanbanBoardView() {
  const { board, updateBoard, relativePath, knownUsers, readOnly, caps, livePeers, sessionStatus } =
    useKanbanContext();
  const { vault } = useVaultStore();
  // Vault-scoped filter/automation presets live on the local filesystem under
  // .collab/templates/. Hosted vaults have no such endpoint, so only app-scoped
  // presets are available there (a null vault path targets app scope, like snippets).
  const supportsLocalTemplates = useMemo(
    () => (vault ? createVaultClient(vault).capabilities.nativeFilesystem : false),
    [vault],
  );
  const templateVaultPath = supportsLocalTemplates && vault ? vault.path : null;
  const { peers } = useCollabStore();
  const {
    boardPath,
    cardId: editingCardId,
    columnId: editingColumnId,
    clearEditing,
    setEditing,
  } = useKanbanStore();
  const boardViewportRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<'board' | 'calendar' | 'timeline' | 'archive'>('board');
  const [activeCard, setActiveCard] = useState<KanbanCard | null>(null);
  const [activeColumn, setActiveColumn] = useState<KanbanColumn | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColTitle, setNewColTitle] = useState('');
  const [moveTagsPrompt, setMoveTagsPrompt] = useState<MoveTagsPromptState | null>(null);
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  const [automationDialogOpen, setAutomationDialogOpen] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState('');
  const [saveFilterSource, setSaveFilterSource] = useState<'board' | TemplateSource>('board');
  const [selectedFilterPresetName, setSelectedFilterPresetName] = useState<string>('');
  const [workingFilter, setWorkingFilter] = useState<KanbanFilterSpec>({});
  const [filterPresets, setFilterPresets] = useState<KanbanFilterPreset[]>([]);
  const [automationPresets, setAutomationPresets] = useState<KanbanAutomationPreset[]>([]);
  const [selectedAutomationPresetName, setSelectedAutomationPresetName] = useState<string>('');
  const [automationDraft, setAutomationDraft] = useState<AutomationDraft>(
    makeDefaultAutomationDraft(),
  );
  const [automationPresetName, setAutomationPresetName] = useState('');

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<MoveTagsPromptState>).detail;
      if (!detail) return;
      setMoveTagsPrompt(detail);
    };

    window.addEventListener('kanban:prompt-move-tags', handler);
    return () => window.removeEventListener('kanban:prompt-move-tags', handler);
  }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Peers viewing this same board
  const boardPeers = useMemo(
    () => peers.filter((p) => p.activeFile === relativePath),
    [peers, relativePath],
  );

  const archivedCount = useMemo(
    () =>
      board.columns.reduce(
        (count, column) => count + column.cards.filter((card) => card.archived).length,
        0,
      ),
    [board.columns],
  );
  const swimlaneMode = board.viewSettings?.swimlaneMode ?? 'none';
  const activeFilter = useMemo(() => getActiveBoardFilter(board), [board]);
  const activeFilterSpec = activeFilter?.spec ?? (board.activeFilterId ? null : workingFilter);
  const activeSwimlaneLabel =
    SWIMLANE_OPTIONS.find((option) => option.value === swimlaneMode)?.label ?? 'No swimlanes';
  const activeFilterLabel = activeFilter?.name ?? 'All cards';
  const visibleBoard = useMemo(
    () => getFilteredBoard(board, activeFilterSpec, knownUsers),
    [activeFilterSpec, board, knownUsers],
  );
  const boardStats = useMemo(() => getKanbanBoardStats(board), [board]);
  const dragOverlay = (
    <DragOverlay dropAnimation={null}>
      {activeCard && <KanbanCardView card={activeCard} columnId="" isOverlay />}
      {activeColumn && (
        <div className="w-[272px] bg-card/80 border border-border/50 rounded-lg shadow-2xl opacity-90 px-3 py-2.5 flex items-center gap-2">
          <div
            className="w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: activeColumn.color ?? '#64748b' }}
          />
          <span className="text-sm font-semibold text-foreground truncate flex-1">
            {activeColumn.title}
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {activeColumn.cards.length}
          </span>
        </div>
      )}
    </DragOverlay>
  );
  const archivedEditingCard = useMemo(() => {
    if (boardPath !== relativePath || !editingCardId || !editingColumnId) return null;
    const column = board.columns.find((entry) => entry.id === editingColumnId);
    const card = column?.cards.find((entry) => entry.id === editingCardId);
    return card?.archived ? { card, columnId: editingColumnId } : null;
  }, [board.columns, boardPath, editingCardId, editingColumnId, relativePath]);

  // Track which column the dragged card started in so we can apply autoComplete
  // correctly even after onDragOver has already moved the card cross-column.
  const dragStartColRef = useRef<string | null>(null);

  // Track the last droppable the pointer was over so we don't call updateBoard
  // on every mouse-move event — only when the cursor actually crosses to a
  // different droppable.  onDragOver fires at pointer-move frequency (60+ Hz)
  // but over.id only changes when entering a new droppable region.
  const lastOverIdRef = useRef<string | null>(null);

  // Custom collision detection: when dragging a COLUMN, restrict candidates to
  // other columns only.  Without this, closestCorners may return a card ID
  // (which is "closer" by bounding-rect math) — the horizontal SortableContext
  // can't find that ID in its column list and produces no animation transform.
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      if (activeColumn) {
        const colIds = new Set(board.columns.map((c) => c.id));
        return closestCorners({
          ...args,
          droppableContainers: args.droppableContainers.filter((c) => colIds.has(c.id as string)),
        });
      }
      return closestCorners(args);
    },
    [activeColumn, board.columns],
  );

  function onDragStart({ active }: DragStartEvent) {
    const activeId = active.id as string;
    const isColDrag = board.columns.some((c) => c.id === activeId);
    lastOverIdRef.current = null;
    if (isColDrag) {
      setActiveColumn(board.columns.find((c) => c.id === activeId) ?? null);
      setActiveCard(null);
      dragStartColRef.current = null;
    } else {
      const col = board.columns.find((col) => col.cards.some((c) => c.id === activeId));
      setActiveCard(col?.cards.find((c) => c.id === activeId) ?? null);
      setActiveColumn(null);
      dragStartColRef.current = col?.id ?? null;
    }
  }

  // Optimistically move cards cross-column during the drag so dnd-kit's
  // per-column SortableContext can animate the insertion in real time.
  // All reads use `prev` (functional update) to avoid stale-closure issues
  // when onDragOver fires faster than React can flush state.
  function onDragOver({ active, over }: DragOverEvent) {
    if (!over || active.id === over.id) return;
    const activeId = active.id as string;
    const overId = over.id as string;
    if (board.columns.some((c) => c.id === activeId)) return; // column drag — skip

    // Bail out early if the pointer is still over the same droppable — this
    // fires at pointer-move frequency so skipping unchanged events is critical.
    if (overId === lastOverIdRef.current) return;
    lastOverIdRef.current = overId;

    const overLane = parseLaneDropId(overId);
    const overIsColumn = board.columns.some((c) => c.id === overId);

    // Pre-check using current board state (may be slightly stale but good enough
    // to avoid calling updateBoard for the common same-column case).
    const srcColId = board.columns.find((col) => col.cards.some((c) => c.id === activeId))?.id;
    const dstColId = overLane
      ? overLane.columnId
      : overIsColumn
        ? overId
        : board.columns.find((col) => col.cards.some((c) => c.id === overId))?.id;
    if (!srcColId || !dstColId || srcColId === dstColId) return;

    updateBoard((prev) => {
      const srcCol = prev.columns.find((col) => col.cards.some((c) => c.id === activeId));
      const dstCol = overLane
        ? prev.columns.find((c) => c.id === overLane.columnId)
        : overIsColumn
          ? prev.columns.find((c) => c.id === overId)
          : prev.columns.find((col) => col.cards.some((c) => c.id === overId));

      if (!srcCol || !dstCol || srcCol.id === dstCol.id) return prev;

      const srcIdx = srcCol.cards.findIndex((c) => c.id === activeId);
      const dstIdx = overIsColumn
        ? dstCol.cards.length
        : overLane
          ? dstCol.cards.length
          : dstCol.cards.findIndex((c) => c.id === overId);

      const srcCards = [...srcCol.cards];
      const [card] = srcCards.splice(srcIdx, 1);
      const dstCards = [...dstCol.cards];
      dstCards.splice(Math.max(0, dstIdx), 0, card);
      return {
        ...prev,
        columns: prev.columns.map((c) => {
          if (c.id === srcCol.id) return { ...c, cards: srcCards };
          if (c.id === dstCol.id) return { ...c, cards: dstCards };
          return c; // preserve reference — unchanged columns won't cause re-renders
        }),
      };
    });
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    const startColId = dragStartColRef.current;
    dragStartColRef.current = null;
    lastOverIdRef.current = null;
    setActiveCard(null);
    setActiveColumn(null);
    if (!over || active.id === over.id) return;

    const draggedId = active.id as string;
    const overId = over.id as string;
    const overLane = parseLaneDropId(overId);

    // ── Column reorder ──────────────────────────────────────────────────────
    // over.id may be a card inside the target column — resolve it to a column.
    if (board.columns.some((c) => c.id === draggedId)) {
      updateBoard((prev) => {
        const colIds = prev.columns.map((c) => c.id);
        const targetColId = colIds.includes(overId)
          ? overId
          : (prev.columns.find((col) => col.cards.some((c) => c.id === overId))?.id ?? null);
        if (!targetColId || targetColId === draggedId) return prev;
        const srcIdx = prev.columns.findIndex((c) => c.id === draggedId);
        const dstIdx = prev.columns.findIndex((c) => c.id === targetColId);
        return { ...prev, columns: arrayMove(prev.columns, srcIdx, dstIdx) };
      });
      return;
    }

    // ── Card reorder / cross-column commit ──────────────────────────────────
    // onDragOver may have already moved the card into the destination column.
    // We use a functional update so we read the latest state regardless.
    const overIsColumn = board.columns.some((c) => c.id === overId);

    let promptRequest: MoveTagsPromptState | null = null;
    const swimlaneMode = board.viewSettings?.swimlaneMode ?? 'none';

    updateBoard((prev) => {
      const srcCol = prev.columns.find((col) => col.cards.some((c) => c.id === draggedId));
      if (!srcCol) return prev;
      const srcIdx = srcCol.cards.findIndex((c) => c.id === draggedId);

      const dstCol = overLane
        ? prev.columns.find((c) => c.id === overLane.columnId)
        : overIsColumn
          ? prev.columns.find((c) => c.id === overId)
          : prev.columns.find((col) => col.cards.some((c) => c.id === overId));
      if (!dstCol) return prev;

      const dstIdx = overIsColumn
        ? dstCol.cards.length
        : overLane
          ? dstCol.cards.length
          : dstCol.cards.findIndex((c) => c.id === overId);

      // Was this a genuine cross-column move (judged by original column at drag-start)?
      const wasCrossColumn = startColId !== null && startColId !== dstCol.id;
      const autoComplete = dstCol.autoComplete ?? false;

      const finalizeMovedCard = (card: KanbanCard) => {
        if (!wasCrossColumn) return card;

        const missingTags = getMissingColumnDefaultTags(card, dstCol);
        if (missingTags.length === 0) {
          return autoComplete ? { ...card, isDone: true } : card;
        }

        if (dstCol.autoApplyDefaultTagsOnMove) {
          return {
            ...card,
            isDone: autoComplete ? true : card.isDone,
            tags: mergeUniqueTags(card.tags, missingTags),
          };
        }

        promptRequest = {
          cardId: card.id,
          cardTitle: card.title,
          columnId: dstCol.id,
          columnTitle: dstCol.title,
          missingTags,
        };
        return autoComplete ? { ...card, isDone: true } : card;
      };

      if (srcCol.id === dstCol.id) {
        // Card is already in the right column (moved by onDragOver) — final sort only.
        const reordered = arrayMove(srcCol.cards, srcIdx, dstIdx);
        const cards = reordered.map((card) =>
          card.id === draggedId ? finalizeMovedCard(card) : card,
        );
        let nextBoard = {
          ...prev,
          columns: prev.columns.map((col) => (col.id !== srcCol.id ? col : { ...col, cards })),
        };
        if (overLane) {
          nextBoard = applyCardSwimlaneValue(
            nextBoard,
            draggedId,
            dstCol.id,
            swimlaneMode,
            getLaneValueFromKey(overLane.laneKey),
          );
        }
        const movedCard = cards.find((card) => card.id === draggedId);
        return movedCard
          ? syncChecklistReferences(nextBoard, draggedId, movedCard.isDone ?? false)
          : nextBoard;
      }

      // Fallback: card wasn't moved by onDragOver (e.g., very fast drop).
      const srcCards = [...srcCol.cards];
      const [card] = srcCards.splice(srcIdx, 1);
      const dstCards = [...dstCol.cards];
      const movedCard = finalizeMovedCard(card);
      dstCards.splice(dstIdx, 0, movedCard);
      let nextBoard = {
        ...prev,
        columns: prev.columns.map((c) => {
          if (c.id === srcCol.id) return { ...c, cards: srcCards };
          if (c.id === dstCol.id) return { ...c, cards: dstCards };
          return c;
        }),
      };
      if (overLane) {
        nextBoard = applyCardSwimlaneValue(
          nextBoard,
          draggedId,
          dstCol.id,
          swimlaneMode,
          getLaneValueFromKey(overLane.laneKey),
        );
      }
      return syncChecklistReferences(nextBoard, draggedId, movedCard.isDone ?? false);
    });

    if (promptRequest) {
      setMoveTagsPrompt(promptRequest);
    }
  }

  function addColumn() {
    const title = newColTitle.trim() || 'New Column';
    updateBoard((prev) => ({
      ...prev,
      columns: [...prev.columns, { id: crypto.randomUUID(), title, color: '#64748b', cards: [] }],
    }));
    setNewColTitle('');
    setAddingColumn(false);
  }

  const columnIds = visibleBoard.columns.map((c) => c.id);
  const totalCards = board.columns.reduce((n, c) => n + c.cards.length, 0);

  const scrollBoardBy = (deltaX: number) => {
    const viewport = boardViewportRef.current;
    if (!viewport) return;
    viewport.scrollBy({ left: deltaX, behavior: 'smooth' });
  };

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      target.matches(
        'input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]',
      );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || event.altKey) return;

      switch (event.key) {
        case '1':
          event.preventDefault();
          setView('board');
          break;
        case '2':
          event.preventDefault();
          setView('calendar');
          break;
        case '3':
          event.preventDefault();
          setView('timeline');
          break;
        case '4':
          event.preventDefault();
          setView('archive');
          break;
        case 'b':
        case 'B':
          event.preventDefault();
          setView('board');
          break;
        case 'c':
        case 'C':
          event.preventDefault();
          setView('calendar');
          break;
        case 't':
        case 'T':
          event.preventDefault();
          setView('timeline');
          break;
        case 'a':
        case 'A':
          event.preventDefault();
          setView('archive');
          break;
        case 'n':
        case 'N':
          if (view === 'board') {
            event.preventDefault();
            setAddingColumn(true);
          }
          break;
        case 'ArrowRight':
          if (view === 'board') {
            event.preventDefault();
            scrollBoardBy(220);
          }
          break;
        case 'ArrowLeft':
          if (view === 'board') {
            event.preventDefault();
            scrollBoardBy(-220);
          }
          break;
        case 'Home':
          if (view === 'board') {
            event.preventDefault();
            boardViewportRef.current?.scrollTo({ left: 0, behavior: 'smooth' });
          }
          break;
        case 'End':
          if (view === 'board') {
            event.preventDefault();
            const viewport = boardViewportRef.current;
            if (viewport) {
              viewport.scrollTo({ left: viewport.scrollWidth, behavior: 'smooth' });
            }
          }
          break;
        case 'Escape':
          if (addingColumn) {
            event.preventDefault();
            setAddingColumn(false);
            setNewColTitle('');
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleKeyDown, {
        capture: true,
      } as EventListenerOptions);
    };
  }, [addingColumn, view]);

  const applyPromptTags = useCallback(
    (prompt: MoveTagsPromptState, enableAutoApply: boolean) => {
      updateBoard((prev) => ({
        ...prev,
        columns: prev.columns.map((column) => {
          if (column.id !== prompt.columnId) return column;
          return {
            ...column,
            autoApplyDefaultTagsOnMove: enableAutoApply ? true : column.autoApplyDefaultTagsOnMove,
            cards: column.cards.map((card) =>
              card.id !== prompt.cardId
                ? card
                : { ...card, tags: mergeUniqueTags(card.tags, prompt.missingTags) },
            ),
          };
        }),
      }));
      setMoveTagsPrompt(null);
    },
    [updateBoard],
  );

  const saveCurrentFilter = useCallback(() => {
    const name = saveFilterName.trim();
    if (!name) return;
    if (saveFilterSource === 'board') {
      const id = crypto.randomUUID();
      updateBoard((prev) => ({
        ...prev,
        savedFilters: [
          ...(prev.savedFilters ?? []),
          { id, name, spec: workingFilter, updatedAt: Date.now() },
        ],
        activeFilterId: id,
      }));
      setSaveFilterName('');
      setFilterDialogOpen(false);
      return;
    }

    if (!vault) return;
    if (saveFilterSource === 'vault' && !supportsLocalTemplates) {
      toast.error(
        'Vault-scoped presets are not available for hosted vaults. Use an app preset instead.',
      );
      return;
    }
    tauriCommands
      .saveKanbanFilterPreset(templateVaultPath, saveFilterSource, name, workingFilter)
      .then(async () => {
        setSaveFilterName('');
        const next = await tauriCommands.listKanbanFilterPresets(templateVaultPath);
        setFilterPresets(next);
        toast.success(`Saved ${saveFilterSource} filter preset "${name}"`);
      })
      .catch((error) => {
        toast.error(`Failed to save filter preset: ${error}`);
      });
  }, [
    saveFilterName,
    saveFilterSource,
    supportsLocalTemplates,
    templateVaultPath,
    updateBoard,
    vault,
    workingFilter,
  ]);

  const runAutomationsNow = useCallback(() => {
    updateBoard((prev) => runKanbanAutomations(prev, 'manual'));
  }, [updateBoard]);

  const applySelectedFilterPreset = useCallback(() => {
    const preset = filterPresets.find(
      (entry) => presetToken(entry.source, entry.name) === selectedFilterPresetName,
    );
    if (!preset) return;
    const id = crypto.randomUUID();
    updateBoard((prev) => ({
      ...prev,
      savedFilters: [
        ...(prev.savedFilters ?? []),
        { id, name: preset.name, spec: preset.spec, updatedAt: Date.now() },
      ],
      activeFilterId: id,
    }));
    setWorkingFilter(preset.spec);
    toast.success(`Applied filter preset "${preset.name}" to this board`);
  }, [filterPresets, selectedFilterPresetName, updateBoard]);

  const addAutomationRule = useCallback(() => {
    const rule = buildAutomationRuleFromDraft(automationDraft);
    updateBoard((prev) => ({
      ...prev,
      automations: [...(prev.automations ?? []), rule],
    }));
    setAutomationDraft(makeDefaultAutomationDraft());
  }, [automationDraft, updateBoard]);

  const deleteAutomationRule = useCallback(
    (ruleId: string) => {
      updateBoard((prev) => ({
        ...prev,
        automations: (prev.automations ?? []).filter((rule) => rule.id !== ruleId),
      }));
    },
    [updateBoard],
  );

  const applySelectedAutomationPreset = useCallback(() => {
    const preset = automationPresets.find(
      (entry) => presetToken(entry.source, entry.name) === selectedAutomationPresetName,
    );
    if (!preset) return;
    updateBoard((prev) => ({
      ...prev,
      automations: [
        ...(prev.automations ?? []),
        { ...preset.rule, id: crypto.randomUUID(), name: preset.name },
      ],
    }));
    toast.success(`Applied automation preset "${preset.name}" to this board`);
  }, [automationPresets, selectedAutomationPresetName, updateBoard]);

  const saveAutomationPreset = useCallback(
    (rule: KanbanAutomationRule, source: Extract<TemplateSource, 'vault' | 'app'>) => {
      if (!vault) return;
      if (source === 'vault' && !supportsLocalTemplates) {
        toast.error(
          'Vault-scoped presets are not available for hosted vaults. Use an app preset instead.',
        );
        return;
      }
      const presetName = automationPresetName.trim() || rule.name;
      tauriCommands
        .saveKanbanAutomationPreset(templateVaultPath, source, presetName, rule)
        .then(async () => {
          const next = await tauriCommands.listKanbanAutomationPresets(templateVaultPath);
          setAutomationPresets(next);
          setAutomationPresetName('');
          toast.success(`Saved ${source} automation preset "${presetName}"`);
        })
        .catch((error) => {
          toast.error(`Failed to save automation preset: ${error}`);
        });
    },
    [automationPresetName, supportsLocalTemplates, templateVaultPath, vault],
  );

  useEffect(() => {
    if (!filterDialogOpen || !vault) return;
    tauriCommands
      .listKanbanFilterPresets(templateVaultPath)
      .then(setFilterPresets)
      .catch(() => {});
  }, [filterDialogOpen, templateVaultPath, vault]);

  useEffect(() => {
    if (!automationDialogOpen || !vault) return;
    tauriCommands
      .listKanbanAutomationPresets(templateVaultPath)
      .then(setAutomationPresets)
      .catch(() => {});
  }, [automationDialogOpen, templateVaultPath, vault]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <DocumentTopBar
        title={getDocumentBaseName(relativePath, 'Board')}
        subtitle={getDocumentFolderPath(relativePath)}
        icon={<LayoutDashboard size={15} />}
        meta={
          <>
            <span className="shrink-0 text-xs text-muted-foreground">
              {totalCards} {totalCards === 1 ? 'card' : 'cards'} across {board.columns.length}{' '}
              columns
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">{archivedCount} archived</span>
            <DocumentStatusPill status={sessionStatus} compact />
            {boardPeers.length > 0 && (
              <div className="flex items-center gap-1" title="Also viewing this board">
                {boardPeers.map((p) => (
                  <div
                    key={p.userId}
                    title={p.userName}
                    className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white border-2 border-background"
                    style={{ backgroundColor: p.userColor }}
                  >
                    {p.userName[0]?.toUpperCase()}
                  </div>
                ))}
              </div>
            )}
            <LivePeers peers={livePeers} />
          </>
        }
        secondary={
          <>
            <div className={documentTopBarGroupClass}>
              <DocumentTopBarButton
                onClick={() => setView('board')}
                className={cn(
                  view === 'board'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <LayoutDashboard size={14} />
                Board
              </DocumentTopBarButton>
              <DocumentTopBarButton
                onClick={() => setView('calendar')}
                className={cn(
                  view === 'calendar'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <CalendarDays size={14} />
                Calendar
              </DocumentTopBarButton>
              <DocumentTopBarButton
                onClick={() => setView('timeline')}
                className={cn(
                  view === 'timeline'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <GanttChart size={14} />
                Timeline
              </DocumentTopBarButton>
              <DocumentTopBarButton
                onClick={() => setView('archive')}
                className={cn(
                  view === 'archive'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Archive size={14} />
                Archive
                {archivedCount > 0 && (
                  <span className="rounded-full bg-background/70 px-1.5 py-0.5 text-[10px] leading-none">
                    {archivedCount}
                  </span>
                )}
              </DocumentTopBarButton>
            </div>

            {view === 'board' && (
              <>
                <div className={documentTopBarGroupClass}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <DocumentTopBarButton>
                        <span className="truncate">Swimlanes: {activeSwimlaneLabel}</span>
                        <ChevronDown size={13} />
                      </DocumentTopBarButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-[180px]">
                      <DropdownMenuLabel>Swimlanes</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuRadioGroup
                        value={swimlaneMode}
                        onValueChange={(value) =>
                          updateBoard((prev) => ({
                            ...prev,
                            viewSettings: {
                              ...(prev.viewSettings ?? {}),
                              swimlaneMode: value as KanbanSwimlaneMode,
                            },
                          }))
                        }
                      >
                        {SWIMLANE_OPTIONS.map((option) => (
                          <DropdownMenuRadioItem key={option.value} value={option.value}>
                            {option.label}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <DocumentTopBarButton>
                        <span className="truncate">Filter: {activeFilterLabel}</span>
                        <ChevronDown size={13} />
                      </DocumentTopBarButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="min-w-[180px]">
                      <DropdownMenuLabel>Filters</DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      <DropdownMenuRadioGroup
                        value={board.activeFilterId ?? '__all__'}
                        onValueChange={(value) => {
                          if (value === '__all__') {
                            updateBoard((prev) => ({ ...prev, activeFilterId: null }));
                            return;
                          }
                          updateBoard((prev) => ({ ...prev, activeFilterId: value }));
                        }}
                      >
                        <DropdownMenuRadioItem value="__all__">All cards</DropdownMenuRadioItem>
                        {(board.savedFilters ?? []).length > 0 ? <DropdownMenuSeparator /> : null}
                        {(board.savedFilters ?? []).map((filter) => (
                          <DropdownMenuRadioItem key={filter.id} value={filter.id}>
                            {filter.name}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DocumentTopBarButton
                    onClick={() => {
                      setWorkingFilter(activeFilter?.spec ?? workingFilter);
                      setFilterDialogOpen(true);
                    }}
                  >
                    <Filter size={12} />
                    Filter
                  </DocumentTopBarButton>
                </div>

                <div className={documentTopBarGroupClass}>
                  <DocumentTopBarButton
                    onClick={() =>
                      updateBoard((prev) => ({
                        ...prev,
                        viewSettings: {
                          ...(prev.viewSettings ?? {}),
                          statsPanelOpen: !(prev.viewSettings?.statsPanelOpen ?? false),
                        },
                      }))
                    }
                  >
                    <BarChart3 size={14} />
                    Stats
                  </DocumentTopBarButton>
                  <DocumentTopBarButton onClick={() => setAutomationDialogOpen(true)}>
                    <Bot size={14} />
                    Automations
                  </DocumentTopBarButton>
                  <DocumentTopBarButton onClick={runAutomationsNow}>
                    <Play size={14} />
                    Run automations
                  </DocumentTopBarButton>
                </div>

                <div className={documentTopBarGroupClass}>
                  <DocumentTopBarButton onClick={() => setAddingColumn(true)}>
                    <Plus size={14} />
                    Add column
                  </DocumentTopBarButton>
                </div>
              </>
            )}
          </>
        }
      />

      {/* Calendar view */}
      {view === 'calendar' && <CalendarView />}

      {/* Timeline view */}
      {view === 'timeline' && <TimelineView />}

      {/* Archive view */}
      {view === 'archive' && (
        <ArchiveView
          onOpenCard={(card, columnId) => {
            setEditing(relativePath, card.id, columnId, card);
          }}
        />
      )}

      {/* Board body — horizontal scroll */}
      {view === 'board' && (
        <div className="flex-1 flex flex-col overflow-hidden">
          {board.viewSettings?.statsPanelOpen && (
            <div className="border-b border-border/30 px-4 py-3 grid grid-cols-2 lg:grid-cols-4 gap-3 bg-card/20">
              <div className="rounded-lg border border-border/30 bg-muted/15 px-3 py-2">
                <div className="text-[11px] text-muted-foreground">Active cards</div>
                <div className="text-lg font-semibold text-foreground">
                  {boardStats.totalActiveCards}
                </div>
              </div>
              <div className="rounded-lg border border-border/30 bg-muted/15 px-3 py-2">
                <div className="text-[11px] text-muted-foreground">Due today</div>
                <div className="text-lg font-semibold text-foreground">
                  {boardStats.dueTodayCount}
                </div>
              </div>
              <div className="rounded-lg border border-border/30 bg-muted/15 px-3 py-2">
                <div className="text-[11px] text-muted-foreground">Overdue</div>
                <div className="text-lg font-semibold text-foreground">
                  {boardStats.overdueCount}
                </div>
              </div>
              <div className="rounded-lg border border-border/30 bg-muted/15 px-3 py-2">
                <div className="text-[11px] text-muted-foreground">Checklist progress</div>
                <div className="text-lg font-semibold text-foreground">
                  {boardStats.checklistCompletion.completed}/{boardStats.checklistCompletion.total}
                </div>
              </div>
            </div>
          )}
          <div ref={boardViewportRef} className="flex-1 overflow-x-auto overflow-y-hidden">
            <DndContext
              sensors={caps.move || caps.columnManage ? sensors : []}
              collisionDetection={collisionDetection}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDragEnd={onDragEnd}
              onDragCancel={() => {
                dragStartColRef.current = null;
                lastOverIdRef.current = null;
                setActiveCard(null);
                setActiveColumn(null);
              }}
            >
              <div className="flex gap-3 h-full p-4 w-max min-w-full items-start">
                <SortableContext items={columnIds} strategy={horizontalListSortingStrategy}>
                  {visibleBoard.columns.map((col) => (
                    <KanbanColumnView key={col.id} column={col} />
                  ))}
                </SortableContext>

                {/* Add column */}
                {!readOnly && caps.columnManage && (
                  <div className="shrink-0 w-[272px]">
                    {addingColumn ? (
                      <div className="bg-card/60 border border-border/50 rounded-lg p-2 flex flex-col gap-2">
                        <input
                          autoFocus
                          value={newColTitle}
                          onChange={(e) => setNewColTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') addColumn();
                            if (e.key === 'Escape') {
                              setAddingColumn(false);
                              setNewColTitle('');
                            }
                          }}
                          placeholder="Column title..."
                          className="w-full bg-transparent text-sm px-2 py-1 rounded border border-border/50 focus:outline-none focus:ring-1 focus:ring-primary/50 text-foreground placeholder:text-muted-foreground/40"
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={addColumn}
                            className="flex-1 text-xs px-2 py-1 bg-primary/20 hover:bg-primary/30 text-primary rounded transition-colors"
                          >
                            Add column
                          </button>
                          <button
                            onClick={() => {
                              setAddingColumn(false);
                              setNewColTitle('');
                            }}
                            className="text-xs px-2 py-1 text-muted-foreground hover:text-foreground rounded transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => setAddingColumn(true)}
                        className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors border border-dashed border-border/40 hover:border-border/60"
                      >
                        <Plus size={14} />
                        Add column
                      </button>
                    )}
                  </div>
                )}
              </div>

              {createPortal(dragOverlay, document.body)}
            </DndContext>
          </div>
        </div>
      )}

      {archivedEditingCard && (
        <CardDialog
          card={archivedEditingCard.card}
          columnId={archivedEditingCard.columnId}
          onClose={clearEditing}
        />
      )}

      <Dialog
        open={moveTagsPrompt !== null}
        onOpenChange={(open) => !open && setMoveTagsPrompt(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Apply column tags?</DialogTitle>
          </DialogHeader>
          {moveTagsPrompt && (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                <span className="text-foreground font-medium">{moveTagsPrompt.cardTitle}</span> was
                moved to{' '}
                <span className="text-foreground font-medium">{moveTagsPrompt.columnTitle}</span>.
              </p>
              <p className="text-muted-foreground">
                This column has default tags that are not yet on the card:
              </p>
              <div className="flex flex-wrap gap-1.5">
                {moveTagsPrompt.missingTags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary/80"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="ghost" onClick={() => setMoveTagsPrompt(null)}>
              Not now
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => moveTagsPrompt && applyPromptTags(moveTagsPrompt, false)}
              >
                Apply once
              </Button>
              <Button onClick={() => moveTagsPrompt && applyPromptTags(moveTagsPrompt, true)}>
                Always apply here
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={filterDialogOpen} onOpenChange={setFilterDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Board filters</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <label htmlFor="kanban-filter-query" className="text-sm font-medium">
                Search
              </label>
              <Input
                id="kanban-filter-query"
                value={workingFilter.query ?? ''}
                onChange={(event) =>
                  setWorkingFilter((prev) => ({ ...prev, query: event.target.value || undefined }))
                }
                placeholder="Title, description, tags, comments..."
              />
            </div>

            <div className="grid gap-1.5">
              <label htmlFor="kanban-filter-assignee" className="text-sm font-medium">
                Assignee contains
              </label>
              <Input
                id="kanban-filter-assignee"
                value={workingFilter.assigneeQuery ?? ''}
                onChange={(event) =>
                  setWorkingFilter((prev) => ({
                    ...prev,
                    assigneeQuery: event.target.value || undefined,
                  }))
                }
                placeholder="Name or user id"
              />
            </div>

            <div className="grid gap-1.5">
              <label htmlFor="kanban-filter-tags" className="text-sm font-medium">
                Tags any
              </label>
              <Input
                id="kanban-filter-tags"
                value={(workingFilter.tagsAny ?? []).join(', ')}
                onChange={(event) =>
                  setWorkingFilter((prev) => ({
                    ...prev,
                    tagsAny: event.target.value
                      ? event.target.value
                          .split(',')
                          .map((tag) => tag.trim())
                          .filter(Boolean)
                      : undefined,
                  }))
                }
                placeholder="bug, urgent"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() =>
                  setWorkingFilter((prev) => ({
                    ...prev,
                    includeArchived: !prev.includeArchived,
                  }))
                }
                className={cn(
                  'rounded-md border px-2.5 py-1.5 text-xs transition-colors',
                  workingFilter.includeArchived
                    ? 'border-primary/40 bg-primary/10 text-foreground'
                    : 'border-border/30 text-muted-foreground hover:text-foreground',
                )}
              >
                Include archived cards
              </button>
            </div>

            <div className="grid gap-1.5">
              <label htmlFor="kanban-filter-name" className="text-sm font-medium">
                Save current filter as
              </label>
              <div className="flex gap-2">
                <Input
                  id="kanban-filter-name"
                  value={saveFilterName}
                  onChange={(event) => setSaveFilterName(event.target.value)}
                  placeholder="My filter"
                />
                <Select
                  value={saveFilterSource}
                  onValueChange={(value) => setSaveFilterSource(value as 'board' | TemplateSource)}
                >
                  <SelectTrigger className="w-[110px] shrink-0 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="board" className="text-xs">
                      Board
                    </SelectItem>
                    {supportsLocalTemplates && (
                      <SelectItem value="vault" className="text-xs">
                        Vault
                      </SelectItem>
                    )}
                    <SelectItem value="app" className="text-xs">
                      App
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button type="button" onClick={saveCurrentFilter} className="shrink-0">
                  Save
                </Button>
              </div>
            </div>

            <div className="grid gap-1.5">
              <label htmlFor="kanban-filter-preset" className="text-sm font-medium">
                Apply preset
              </label>
              <div className="flex gap-2">
                <Select
                  value={selectedFilterPresetName || '__none__'}
                  onValueChange={(value) =>
                    setSelectedFilterPresetName(value === '__none__' ? '' : value)
                  }
                >
                  <SelectTrigger id="kanban-filter-preset" className="text-xs">
                    <SelectValue placeholder="Choose a vault or app preset" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__" className="text-xs">
                      No preset selected
                    </SelectItem>
                    {filterPresets.map((preset) => (
                      <SelectItem
                        key={`${preset.source}:${preset.name}`}
                        value={presetToken(preset.source, preset.name)}
                        className="text-xs"
                      >
                        {preset.name} ({preset.source})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  onClick={applySelectedFilterPreset}
                  disabled={!selectedFilterPresetName}
                >
                  Apply preset
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setWorkingFilter({});
                updateBoard((prev) => ({ ...prev, activeFilterId: null }));
              }}
            >
              Clear
            </Button>
            <Button
              type="button"
              onClick={() => {
                updateBoard((prev) => ({ ...prev, activeFilterId: null }));
                setFilterDialogOpen(false);
              }}
            >
              Apply quick filter
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={automationDialogOpen} onOpenChange={setAutomationDialogOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Automations</DialogTitle>
          </DialogHeader>
          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="grid gap-3">
              <div className="rounded-lg border border-border/30 bg-muted/15 p-3">
                <div className="mb-3 text-sm font-medium text-foreground">Create board rule</div>
                <div className="grid gap-3">
                  <Input
                    value={automationDraft.name}
                    onChange={(event) =>
                      setAutomationDraft((prev) => ({ ...prev, name: event.target.value }))
                    }
                    placeholder="Rule name"
                  />

                  <div className="grid grid-cols-2 gap-2">
                    <Select
                      value={automationDraft.trigger}
                      onValueChange={(value) =>
                        setAutomationDraft((prev) => ({
                          ...prev,
                          trigger: value as KanbanAutomationRule['trigger'],
                        }))
                      }
                    >
                      <SelectTrigger className="text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="manual" className="text-xs">
                          Manual
                        </SelectItem>
                        <SelectItem value="onBoardOpen" className="text-xs">
                          On board open
                        </SelectItem>
                        <SelectItem value="onBoardSave" className="text-xs">
                          On board save
                        </SelectItem>
                      </SelectContent>
                    </Select>

                    <Select
                      value={automationDraft.conditionKind}
                      onValueChange={(value) =>
                        setAutomationDraft((prev) => ({
                          ...prev,
                          conditionKind: value as AutomationConditionKind,
                          conditionValue: '',
                        }))
                      }
                    >
                      <SelectTrigger className="text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="overdue" className="text-xs">
                          Condition: overdue
                        </SelectItem>
                        <SelectItem value="dueWithinDays" className="text-xs">
                          Condition: due within days
                        </SelectItem>
                        <SelectItem value="hasTag" className="text-xs">
                          Condition: has tag
                        </SelectItem>
                        <SelectItem value="column" className="text-xs">
                          Condition: in column
                        </SelectItem>
                        <SelectItem value="priority" className="text-xs">
                          Condition: priority
                        </SelectItem>
                        <SelectItem value="assigneeState" className="text-xs">
                          Condition: assignee state
                        </SelectItem>
                        <SelectItem value="doneState" className="text-xs">
                          Condition: done state
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {automationDraft.conditionKind !== 'overdue' &&
                    (automationDraft.conditionKind === 'column' ? (
                      <Select
                        value={automationDraft.conditionValue}
                        onValueChange={(value) =>
                          setAutomationDraft((prev) => ({ ...prev, conditionValue: value }))
                        }
                      >
                        <SelectTrigger className="text-xs">
                          <SelectValue placeholder="Choose a column" />
                        </SelectTrigger>
                        <SelectContent>
                          {board.columns.map((column) => (
                            <SelectItem key={column.id} value={column.id} className="text-xs">
                              {column.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : automationDraft.conditionKind === 'priority' ? (
                      <Select
                        value={automationDraft.conditionValue || 'none'}
                        onValueChange={(value) =>
                          setAutomationDraft((prev) => ({ ...prev, conditionValue: value }))
                        }
                      >
                        <SelectTrigger className="text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none" className="text-xs">
                            No priority
                          </SelectItem>
                          <SelectItem value="high" className="text-xs">
                            High
                          </SelectItem>
                          <SelectItem value="medium" className="text-xs">
                            Medium
                          </SelectItem>
                          <SelectItem value="low" className="text-xs">
                            Low
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    ) : automationDraft.conditionKind === 'assigneeState' ? (
                      <Select
                        value={automationDraft.conditionValue || 'empty'}
                        onValueChange={(value) =>
                          setAutomationDraft((prev) => ({ ...prev, conditionValue: value }))
                        }
                      >
                        <SelectTrigger className="text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="empty" className="text-xs">
                            Assignee empty
                          </SelectItem>
                          <SelectItem value="present" className="text-xs">
                            Assignee present
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    ) : automationDraft.conditionKind === 'doneState' ? (
                      <Select
                        value={automationDraft.conditionValue || 'done'}
                        onValueChange={(value) =>
                          setAutomationDraft((prev) => ({ ...prev, conditionValue: value }))
                        }
                      >
                        <SelectTrigger className="text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="done" className="text-xs">
                            Done
                          </SelectItem>
                          <SelectItem value="not-done" className="text-xs">
                            Not done
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={automationDraft.conditionValue}
                        onChange={(event) =>
                          setAutomationDraft((prev) => ({
                            ...prev,
                            conditionValue: event.target.value,
                          }))
                        }
                        placeholder={
                          automationDraft.conditionKind === 'dueWithinDays' ? 'Days' : 'Value'
                        }
                      />
                    ))}

                  <div className="grid grid-cols-2 gap-2">
                    <Select
                      value={automationDraft.actionKind}
                      onValueChange={(value) =>
                        setAutomationDraft((prev) => ({
                          ...prev,
                          actionKind: value as AutomationActionKind,
                          actionValue: '',
                        }))
                      }
                    >
                      <SelectTrigger className="text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="moveToColumn" className="text-xs">
                          Action: move to column
                        </SelectItem>
                        <SelectItem value="addTag" className="text-xs">
                          Action: add tag
                        </SelectItem>
                        <SelectItem value="removeTag" className="text-xs">
                          Action: remove tag
                        </SelectItem>
                        <SelectItem value="setPriority" className="text-xs">
                          Action: set priority
                        </SelectItem>
                        <SelectItem value="setDone" className="text-xs">
                          Action: set done state
                        </SelectItem>
                        <SelectItem value="assignUser" className="text-xs">
                          Action: assign user
                        </SelectItem>
                      </SelectContent>
                    </Select>

                    {automationDraft.actionKind === 'moveToColumn' ? (
                      <Select
                        value={automationDraft.actionValue}
                        onValueChange={(value) =>
                          setAutomationDraft((prev) => ({ ...prev, actionValue: value }))
                        }
                      >
                        <SelectTrigger className="text-xs">
                          <SelectValue placeholder="Choose a column" />
                        </SelectTrigger>
                        <SelectContent>
                          {board.columns.map((column) => (
                            <SelectItem key={column.id} value={column.id} className="text-xs">
                              {column.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : automationDraft.actionKind === 'setPriority' ? (
                      <Select
                        value={automationDraft.actionValue || 'none'}
                        onValueChange={(value) =>
                          setAutomationDraft((prev) => ({ ...prev, actionValue: value }))
                        }
                      >
                        <SelectTrigger className="text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none" className="text-xs">
                            No priority
                          </SelectItem>
                          <SelectItem value="high" className="text-xs">
                            High
                          </SelectItem>
                          <SelectItem value="medium" className="text-xs">
                            Medium
                          </SelectItem>
                          <SelectItem value="low" className="text-xs">
                            Low
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    ) : automationDraft.actionKind === 'setDone' ? (
                      <Select
                        value={automationDraft.actionValue || 'done'}
                        onValueChange={(value) =>
                          setAutomationDraft((prev) => ({ ...prev, actionValue: value }))
                        }
                      >
                        <SelectTrigger className="text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="done" className="text-xs">
                            Mark done
                          </SelectItem>
                          <SelectItem value="not-done" className="text-xs">
                            Mark not done
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    ) : automationDraft.actionKind === 'assignUser' ? (
                      <Select
                        value={automationDraft.actionValue || '__none__'}
                        onValueChange={(value) =>
                          setAutomationDraft((prev) => ({
                            ...prev,
                            actionValue: value === '__none__' ? '' : value,
                          }))
                        }
                      >
                        <SelectTrigger className="text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__" className="text-xs">
                            Unassign
                          </SelectItem>
                          {knownUsers.map((user) => (
                            <SelectItem key={user.userId} value={user.userId} className="text-xs">
                              {user.userName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={automationDraft.actionValue}
                        onChange={(event) =>
                          setAutomationDraft((prev) => ({
                            ...prev,
                            actionValue: event.target.value,
                          }))
                        }
                        placeholder="Value"
                      />
                    )}
                  </div>

                  <Button type="button" onClick={addAutomationRule}>
                    Add rule
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border border-border/30 bg-muted/15 p-3">
                <div className="mb-3 text-sm font-medium text-foreground">Board rules</div>
                <div className="space-y-2">
                  {(board.automations ?? []).length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No automations on this board yet.
                    </p>
                  )}
                  {(board.automations ?? []).map((rule) => (
                    <div
                      key={rule.id}
                      className="rounded-md border border-border/25 bg-background/50 px-3 py-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground">{rule.name}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {describeAutomationRule(rule, board.columns)}
                          </div>
                          <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
                            {rule.trigger}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => deleteAutomationRule(rule.id)}
                          className="rounded-md p-1 text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                          aria-label={`Delete ${rule.name}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Input
                          value={automationPresetName}
                          onChange={(event) => setAutomationPresetName(event.target.value)}
                          placeholder="Preset name"
                          className="h-8 max-w-[180px] text-xs"
                        />
                        {supportsLocalTemplates && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => saveAutomationPreset(rule, 'vault')}
                          >
                            Save to vault
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => saveAutomationPreset(rule, 'app')}
                        >
                          Save to app
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-border/30 bg-muted/15 p-3">
              <div className="mb-3 text-sm font-medium text-foreground">Automation presets</div>
              <div className="grid gap-3">
                <Select
                  value={selectedAutomationPresetName || '__none__'}
                  onValueChange={(value) =>
                    setSelectedAutomationPresetName(value === '__none__' ? '' : value)
                  }
                >
                  <SelectTrigger className="text-xs">
                    <SelectValue placeholder="Choose a preset" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__" className="text-xs">
                      No preset selected
                    </SelectItem>
                    {automationPresets.map((preset) => (
                      <SelectItem
                        key={`${preset.source}:${preset.name}`}
                        value={presetToken(preset.source, preset.name)}
                        className="text-xs"
                      >
                        {preset.name} ({preset.source})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="outline"
                  onClick={applySelectedAutomationPreset}
                  disabled={!selectedAutomationPresetName}
                >
                  Apply preset to board
                </Button>
                <div className="space-y-2">
                  {automationPresets.map((preset) => (
                    <div
                      key={`${preset.source}:${preset.name}:summary`}
                      className="rounded-md border border-border/25 bg-background/50 px-3 py-2"
                    >
                      <div className="text-sm font-medium text-foreground">{preset.name}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {describeAutomationRule(preset.rule, board.columns)}
                      </div>
                      <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
                        {preset.source}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
