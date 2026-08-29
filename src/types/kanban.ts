export interface KanbanComment {
  id: string;
  userId: string;
  userName: string;
  userColor: string;
  content: string;
  timestamp: number;
}

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
  cardRef?: string;
}

export type KanbanPriority = 'low' | 'medium' | 'high';
export type KanbanDueStatus = 'overdue' | 'due-today' | 'upcoming' | 'none';
export type KanbanSwimlaneMode = 'none' | 'assignee' | 'priority' | 'tag' | 'dueStatus';
export type KanbanRecurrenceMode = 'daily' | 'weekly' | 'monthly' | 'interval';
export type KanbanRecurrenceAnchor = 'dueDate' | 'completionDate';
export type KanbanRecurrenceCopyMode = 'clone' | 'rollover';
export type KanbanAutomationTrigger = 'onBoardOpen' | 'onBoardSave' | 'manual';

export interface KanbanRecurrenceRule {
  enabled: boolean;
  mode: KanbanRecurrenceMode;
  interval?: number;
  weekdays?: number[];
  anchor?: KanbanRecurrenceAnchor;
  copyMode?: KanbanRecurrenceCopyMode;
  preserveChecklist?: boolean;
}

export interface KanbanFilterSpec {
  query?: string;
  tagsAny?: string[];
  tagsAll?: string[];
  assigneeQuery?: string;
  priorities?: KanbanPriority[];
  dueStatuses?: KanbanDueStatus[];
  includeArchived?: boolean;
  columnIds?: string[];
}

export interface KanbanSavedFilter {
  id: string;
  name: string;
  spec: KanbanFilterSpec;
  updatedAt?: number;
}

export interface KanbanBoardViewSettings {
  swimlaneMode?: KanbanSwimlaneMode;
  swimlaneValue?: string | null;
  statsPanelOpen?: boolean;
}

export interface KanbanAutomationCondition {
  overdue?: boolean;
  dueWithinDays?: number;
  hasTag?: string;
  columnId?: string;
  priority?: KanbanPriority | 'none';
  assigneeState?: 'empty' | 'present';
  isDone?: boolean;
}

export type KanbanAutomationAction =
  | { type: 'moveToColumn'; columnId: string }
  | { type: 'addTag'; tag: string }
  | { type: 'removeTag'; tag: string }
  | { type: 'setPriority'; priority: KanbanPriority | 'none' }
  | { type: 'setDone'; isDone: boolean }
  | { type: 'assignUser'; userId: string | null };

export interface KanbanAutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: KanbanAutomationTrigger;
  condition: KanbanAutomationCondition;
  action: KanbanAutomationAction;
}

export interface KanbanCard {
  id: string;
  title: string;
  description?: string;
  relativePath?: string;
  attachmentPaths?: string[];
  assignees: string[];
  tags: string[];
  startDate?: string;
  dueDate?: string;
  createdAt?: number;
  priority?: KanbanPriority;
  comments: KanbanComment[];
  checklist: ChecklistItem[];
  isDone?: boolean;
  completedAt?: number | null;
  archived?: boolean;
  archivedColumnId?: string;
  archivedAt?: number;
  archivedByUserId?: string;
  archivedByUserName?: string;
  recurrence?: KanbanRecurrenceRule | null;
}

export type ColumnSortField =
  'none' | 'name' | 'priority' | 'createdAt' | 'startDate' | 'dueDate' | 'assignees';

export interface KanbanColumn {
  id: string;
  title: string;
  color?: string;
  autoComplete?: boolean;
  sort?: { field: ColumnSortField; dir: 'asc' | 'desc' };
  hideFromTimeline?: boolean;
  isDoneDestination?: boolean;
  defaultTags?: string[];
  autoApplyDefaultTagsOnMove?: boolean;
  cards: KanbanCard[];
}

export interface KanbanBoard {
  columns: KanbanColumn[];
  savedFilters?: KanbanSavedFilter[];
  activeFilterId?: string | null;
  viewSettings?: KanbanBoardViewSettings;
  automations?: KanbanAutomationRule[];
}

export interface KanbanLane {
  key: string;
  title: string;
  cards: KanbanCard[];
  mutableValue?: string | null;
}

export interface KanbanBoardStats {
  totalActiveCards: number;
  completedCount: number;
  archivedCount: number;
  overdueCount: number;
  dueTodayCount: number;
  cardsByColumn: Array<{ columnId: string; title: string; count: number }>;
  assigneeDistribution: Array<{ key: string; label: string; count: number }>;
  priorityDistribution: Array<{ key: string; label: string; count: number }>;
  checklistCompletion: { completed: number; total: number };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function pad(value: number) {
  return value.toString().padStart(2, '0');
}

function toDateOnly(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDateOnly(value?: string) {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

function endOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
}

function differenceInWholeDays(later: Date, earlier: Date) {
  return Math.round((later.getTime() - earlier.getTime()) / DAY_MS);
}

function advanceRecurrenceDate(date: Date, recurrence: KanbanRecurrenceRule) {
  const interval = Math.max(1, recurrence.interval ?? 1);
  const next = new Date(date);
  switch (recurrence.mode) {
    case 'daily':
      next.setDate(next.getDate() + interval);
      return next;
    case 'weekly':
      next.setDate(next.getDate() + interval * 7);
      return next;
    case 'monthly':
      next.setMonth(next.getMonth() + interval);
      return next;
    case 'interval':
      next.setDate(next.getDate() + interval);
      return next;
  }
}

function normalizeQuery(value?: string) {
  return value?.trim().toLowerCase() ?? '';
}

export function syncChecklistReferences(
  board: KanbanBoard,
  cardId: string,
  checked: boolean,
): KanbanBoard {
  let changed = false;

  const columns = board.columns.map((column) => {
    let columnChanged = false;

    const cards = column.cards.map((card) => {
      let cardChanged = false;
      const checklist = card.checklist.map((item) => {
        if (item.cardRef !== cardId || item.checked === checked) return item;
        cardChanged = true;
        changed = true;
        return { ...item, checked };
      });

      if (!cardChanged) return card;
      columnChanged = true;
      return { ...card, checklist };
    });

    if (!columnChanged) return column;
    return { ...column, cards };
  });

  return changed ? { ...board, columns } : board;
}

export function mergeUniqueTags(existingTags: string[], incomingTags: string[]) {
  return [...existingTags, ...incomingTags.filter((tag) => !existingTags.includes(tag))];
}

export function getMissingColumnDefaultTags(
  card: Pick<KanbanCard, 'tags'>,
  column: Pick<KanbanColumn, 'defaultTags'>,
) {
  return (column.defaultTags ?? []).filter((tag) => !card.tags.includes(tag));
}

export function getCardAttachmentPaths(
  card: Pick<KanbanCard, 'relativePath' | 'attachmentPaths'>,
): string[] {
  const paths = [
    ...(card.attachmentPaths ?? []),
    ...(card.relativePath ? [card.relativePath] : []),
  ].filter(Boolean);

  return [...new Set(paths)];
}

export function getCardDueStatus(
  card: Pick<KanbanCard, 'dueDate' | 'isDone'>,
  now = new Date(),
): KanbanDueStatus {
  if (!card.dueDate) return 'none';
  const due = parseDateOnly(card.dueDate);
  if (!due) return 'none';
  if ((card.isDone ?? false) && due.getTime() < startOfToday(now).getTime()) return 'none';
  if (due.getTime() < startOfToday(now).getTime()) return 'overdue';
  if (due.getTime() <= endOfToday(now).getTime()) return 'due-today';
  return 'upcoming';
}

export function getActiveBoardFilter(board: KanbanBoard): KanbanSavedFilter | null {
  if (!board.activeFilterId) return null;
  return board.savedFilters?.find((filter) => filter.id === board.activeFilterId) ?? null;
}

export function cardMatchesFilter(
  card: KanbanCard,
  columnId: string,
  spec: KanbanFilterSpec | null | undefined,
  assigneeLabels: string[] = [],
  now = new Date(),
) {
  if (!spec) return true;
  if (!spec.includeArchived && card.archived) return false;
  if (spec.columnIds?.length && !spec.columnIds.includes(columnId)) return false;

  const query = normalizeQuery(spec.query);
  if (query) {
    const haystack = [
      card.title,
      card.description,
      ...card.tags,
      ...card.assignees,
      ...assigneeLabels,
      ...card.comments.map((comment) => comment.content),
      ...card.checklist.map((item) => item.text),
      ...getCardAttachmentPaths(card),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }

  if (spec.tagsAny?.length && !spec.tagsAny.some((tag) => card.tags.includes(tag))) return false;
  if (spec.tagsAll?.length && !spec.tagsAll.every((tag) => card.tags.includes(tag))) return false;

  const assigneeQuery = normalizeQuery(spec.assigneeQuery);
  if (assigneeQuery) {
    const matched = [...card.assignees, ...assigneeLabels].some((value) =>
      value.toLowerCase().includes(assigneeQuery),
    );
    if (!matched) return false;
  }

  if (spec.priorities?.length) {
    if (!card.priority || !spec.priorities.includes(card.priority)) return false;
  }

  if (spec.dueStatuses?.length) {
    const dueStatus = getCardDueStatus(card, now);
    if (!spec.dueStatuses.includes(dueStatus)) return false;
  }

  return true;
}

export function getFilteredBoard(
  board: KanbanBoard,
  spec: KanbanFilterSpec | null | undefined,
  knownUsers: Array<{ userId: string; userName: string }> = [],
  now = new Date(),
): KanbanBoard {
  if (!spec) return board;
  const columns = board.columns.map((column) => ({
    ...column,
    cards: column.cards.filter((card) => {
      const assigneeLabels = card.assignees
        .map((userId) => knownUsers.find((user) => user.userId === userId)?.userName ?? userId)
        .filter(Boolean);
      return cardMatchesFilter(card, column.id, spec, assigneeLabels, now);
    }),
  }));
  return { ...board, columns };
}

function createNextRecurringCard(card: KanbanCard, completedAt: number) {
  const recurrence = card.recurrence;
  if (!recurrence?.enabled) return null;

  const completionDate = new Date(completedAt);
  const dueDate = parseDateOnly(card.dueDate);
  const startDate = parseDateOnly(card.startDate);
  const anchorMode = recurrence.anchor ?? 'dueDate';
  const anchorDate =
    anchorMode === 'completionDate' ? completionDate : (dueDate ?? startDate ?? completionDate);
  const nextAnchor = advanceRecurrenceDate(anchorDate, recurrence);

  let nextDueDate = card.dueDate;
  let nextStartDate = card.startDate;

  if (dueDate && startDate) {
    const span = differenceInWholeDays(dueDate, startDate);
    if (card.dueDate) nextDueDate = toDateOnly(nextAnchor);
    nextStartDate = toDateOnly(addDays(nextAnchor, -span));
  } else if (dueDate) {
    nextDueDate = toDateOnly(nextAnchor);
  } else if (startDate) {
    nextStartDate = toDateOnly(nextAnchor);
  }

  return {
    ...card,
    id: crypto.randomUUID(),
    isDone: undefined,
    completedAt: null,
    archived: undefined,
    archivedColumnId: undefined,
    archivedAt: undefined,
    archivedByUserId: undefined,
    archivedByUserName: undefined,
    comments: [],
    checklist: recurrence.preserveChecklist
      ? card.checklist.map((item) => ({ ...item }))
      : card.checklist.map((item) => ({ ...item, checked: false })),
    startDate: nextStartDate,
    dueDate: nextDueDate,
    createdAt: completedAt,
  } satisfies KanbanCard;
}

function setCardStateWithRecurrence(
  board: KanbanBoard,
  cardId: string,
  isDone: boolean,
  completedAt = Date.now(),
): KanbanBoard {
  let changed = false;
  let nextRecurringCard: KanbanCard | null = null;
  let recurringColumnId: string | null = null;

  const columns = board.columns.map((column) => {
    let columnChanged = false;
    const cards: KanbanCard[] = [];
    for (const card of column.cards) {
      if (card.id !== cardId || card.isDone === isDone) {
        cards.push(card);
        continue;
      }
      changed = true;
      columnChanged = true;
      const nextCard: KanbanCard = {
        ...card,
        isDone,
        completedAt: isDone ? completedAt : null,
      };
      if (isDone && card.recurrence?.enabled) {
        nextRecurringCard = createNextRecurringCard(card, completedAt);
        recurringColumnId = column.id;
      }
      cards.push(nextCard);
    }

    if (!columnChanged) return column;
    return { ...column, cards };
  });

  if (!changed) return board;

  let nextBoard: KanbanBoard = { ...board, columns };
  if (nextRecurringCard && recurringColumnId) {
    nextBoard = {
      ...nextBoard,
      columns: nextBoard.columns.map((column) =>
        column.id !== recurringColumnId
          ? column
          : { ...column, cards: [...column.cards, nextRecurringCard as KanbanCard] },
      ),
    };
  }
  return syncChecklistReferences(nextBoard, cardId, isDone);
}

export function setCardDoneState(board: KanbanBoard, cardId: string, isDone: boolean): KanbanBoard {
  return setCardStateWithRecurrence(board, cardId, isDone);
}

export function normalizeKanbanBoard(input: KanbanBoard): KanbanBoard {
  return {
    columns: input.columns ?? [],
    savedFilters: input.savedFilters ?? [],
    activeFilterId: input.activeFilterId ?? null,
    viewSettings: {
      swimlaneMode: input.viewSettings?.swimlaneMode ?? 'none',
      swimlaneValue: input.viewSettings?.swimlaneValue ?? null,
      statsPanelOpen: input.viewSettings?.statsPanelOpen ?? false,
    },
    automations: input.automations ?? [],
  };
}

function conditionMatchesCard(
  card: KanbanCard,
  columnId: string,
  condition: KanbanAutomationCondition,
  now = new Date(),
) {
  if (condition.overdue && getCardDueStatus(card, now) !== 'overdue') return false;
  if (typeof condition.dueWithinDays === 'number') {
    const due = parseDateOnly(card.dueDate);
    if (!due) return false;
    const daysUntilDue = differenceInWholeDays(due, startOfToday(now));
    if (daysUntilDue < 0 || daysUntilDue > condition.dueWithinDays) return false;
  }
  if (condition.hasTag && !card.tags.includes(condition.hasTag)) return false;
  if (condition.columnId && condition.columnId !== columnId) return false;
  if (condition.priority && (card.priority ?? 'none') !== condition.priority) return false;
  if (condition.assigneeState === 'empty' && card.assignees.length > 0) return false;
  if (condition.assigneeState === 'present' && card.assignees.length === 0) return false;
  if (typeof condition.isDone === 'boolean' && (card.isDone ?? false) !== condition.isDone)
    return false;
  return true;
}

export function runKanbanAutomations(
  board: KanbanBoard,
  trigger: KanbanAutomationTrigger,
  now = Date.now(),
): KanbanBoard {
  const rules = (board.automations ?? []).filter(
    (rule) => rule.enabled && rule.trigger === trigger,
  );
  if (rules.length === 0) return board;

  let nextBoard = board;
  const processed = new Set<string>();

  for (const rule of rules) {
    if (!rule.enabled) continue;

    for (const column of nextBoard.columns) {
      cardLoop: for (const card of column.cards) {
        if (processed.has(card.id)) continue;
        if (!conditionMatchesCard(card, column.id, rule.condition, new Date(now))) continue;

        const action = rule.action;

        switch (action.type) {
          case 'moveToColumn': {
            if (action.columnId === column.id) {
              processed.add(card.id);
              continue cardLoop;
            }
            const destination = nextBoard.columns.find((entry) => entry.id === action.columnId);
            if (!destination) {
              processed.add(card.id);
              continue cardLoop;
            }
            nextBoard = {
              ...nextBoard,
              columns: nextBoard.columns.map((entry) => {
                if (entry.id === column.id) {
                  return { ...entry, cards: entry.cards.filter((item) => item.id !== card.id) };
                }
                if (entry.id === destination.id) {
                  return {
                    ...entry,
                    cards: [
                      ...entry.cards,
                      {
                        ...card,
                        isDone: entry.autoComplete ? true : card.isDone,
                        tags: entry.autoApplyDefaultTagsOnMove
                          ? mergeUniqueTags(card.tags, getMissingColumnDefaultTags(card, entry))
                          : card.tags,
                      },
                    ],
                  };
                }
                return entry;
              }),
            };
            processed.add(card.id);
            continue cardLoop;
          }
          case 'addTag':
            if (!card.tags.includes(action.tag)) {
              nextBoard = {
                ...nextBoard,
                columns: nextBoard.columns.map((entry) =>
                  entry.id !== column.id
                    ? entry
                    : {
                        ...entry,
                        cards: entry.cards.map((item) =>
                          item.id !== card.id
                            ? item
                            : { ...item, tags: mergeUniqueTags(item.tags, [action.tag]) },
                        ),
                      },
                ),
              };
            }
            processed.add(card.id);
            continue cardLoop;
          case 'removeTag':
            nextBoard = {
              ...nextBoard,
              columns: nextBoard.columns.map((entry) =>
                entry.id !== column.id
                  ? entry
                  : {
                      ...entry,
                      cards: entry.cards.map((item) =>
                        item.id !== card.id
                          ? item
                          : { ...item, tags: item.tags.filter((tag) => tag !== action.tag) },
                      ),
                    },
              ),
            };
            processed.add(card.id);
            continue cardLoop;
          case 'setPriority':
            nextBoard = {
              ...nextBoard,
              columns: nextBoard.columns.map((entry) =>
                entry.id !== column.id
                  ? entry
                  : {
                      ...entry,
                      cards: entry.cards.map((item) =>
                        item.id !== card.id
                          ? item
                          : {
                              ...item,
                              priority: action.priority === 'none' ? undefined : action.priority,
                            },
                      ),
                    },
              ),
            };
            processed.add(card.id);
            continue cardLoop;
          case 'setDone':
            nextBoard = setCardStateWithRecurrence(nextBoard, card.id, action.isDone, now);
            processed.add(card.id);
            continue cardLoop;
          case 'assignUser':
            nextBoard = {
              ...nextBoard,
              columns: nextBoard.columns.map((entry) =>
                entry.id !== column.id
                  ? entry
                  : {
                      ...entry,
                      cards: entry.cards.map((item) =>
                        item.id !== card.id
                          ? item
                          : {
                              ...item,
                              assignees: action.userId ? [action.userId] : [],
                            },
                      ),
                    },
              ),
            };
            processed.add(card.id);
            continue cardLoop;
        }
      }
    }
  }

  return nextBoard;
}

export function getKanbanBoardStats(board: KanbanBoard, now = new Date()): KanbanBoardStats {
  const activeCards = board.columns.reduce<KanbanCard[]>((cards, column) => {
    cards.push(...column.cards.filter((card) => !card.archived));
    return cards;
  }, []);
  const archivedCards = board.columns.reduce<KanbanCard[]>((cards, column) => {
    cards.push(...column.cards.filter((card) => card.archived));
    return cards;
  }, []);
  const checklistTotal = activeCards.reduce((sum, card) => sum + card.checklist.length, 0);
  const checklistCompleted = activeCards.reduce(
    (sum, card) => sum + card.checklist.filter((item) => item.checked).length,
    0,
  );

  const assigneeCounts = new Map<string, number>();
  const priorityCounts = new Map<string, number>();

  for (const card of activeCards) {
    const assignees = card.assignees.length > 0 ? card.assignees : ['unassigned'];
    for (const assignee of assignees) {
      assigneeCounts.set(assignee, (assigneeCounts.get(assignee) ?? 0) + 1);
    }
    priorityCounts.set(
      card.priority ?? 'none',
      (priorityCounts.get(card.priority ?? 'none') ?? 0) + 1,
    );
  }

  return {
    totalActiveCards: activeCards.length,
    completedCount: activeCards.filter((card) => card.isDone).length,
    archivedCount: archivedCards.length,
    overdueCount: activeCards.filter((card) => getCardDueStatus(card, now) === 'overdue').length,
    dueTodayCount: activeCards.filter((card) => getCardDueStatus(card, now) === 'due-today').length,
    cardsByColumn: board.columns.map((column) => ({
      columnId: column.id,
      title: column.title,
      count: column.cards.filter((card) => !card.archived).length,
    })),
    assigneeDistribution: [...assigneeCounts.entries()].map(([key, count]) => ({
      key,
      label: key === 'unassigned' ? 'Unassigned' : key,
      count,
    })),
    priorityDistribution: [...priorityCounts.entries()].map(([key, count]) => ({
      key,
      label: key === 'none' ? 'No priority' : key[0].toUpperCase() + key.slice(1),
      count,
    })),
    checklistCompletion: {
      completed: checklistCompleted,
      total: checklistTotal,
    },
  };
}

export function getKanbanSwimlanes(
  cards: KanbanCard[],
  mode: KanbanSwimlaneMode,
  knownUsers: Array<{ userId: string; userName: string }> = [],
  now = new Date(),
): KanbanLane[] {
  if (mode === 'none') {
    return [{ key: 'all', title: 'Cards', cards }];
  }

  const laneMap = new Map<string, KanbanLane>();
  const ensureLane = (key: string, title: string, mutableValue?: string | null) => {
    if (!laneMap.has(key)) {
      laneMap.set(key, { key, title, cards: [], mutableValue });
    }
    return laneMap.get(key)!;
  };

  for (const card of cards) {
    if (mode === 'assignee') {
      const assignee = card.assignees[0];
      if (!assignee) {
        ensureLane('assignee:none', 'Unassigned', null).cards.push(card);
      } else {
        const label = knownUsers.find((user) => user.userId === assignee)?.userName ?? assignee;
        ensureLane(`assignee:${assignee}`, label, assignee).cards.push(card);
      }
      continue;
    }

    if (mode === 'priority') {
      const key = card.priority ?? 'none';
      const title = key === 'none' ? 'No priority' : key[0].toUpperCase() + key.slice(1);
      ensureLane(`priority:${key}`, title, key === 'none' ? null : key).cards.push(card);
      continue;
    }

    if (mode === 'tag') {
      const tag = [...card.tags].sort((left, right) => left.localeCompare(right))[0];
      if (!tag) {
        ensureLane('tag:none', 'No tag', null).cards.push(card);
      } else {
        ensureLane(`tag:${tag}`, tag, tag).cards.push(card);
      }
      continue;
    }

    const dueStatus = getCardDueStatus(card, now);
    const title =
      dueStatus === 'due-today'
        ? 'Due today'
        : dueStatus === 'none'
          ? 'No due date'
          : dueStatus[0].toUpperCase() + dueStatus.slice(1);
    ensureLane(`due:${dueStatus}`, title).cards.push(card);
  }

  return [...laneMap.values()].sort((left, right) => left.title.localeCompare(right.title));
}

export function applyCardSwimlaneValue(
  board: KanbanBoard,
  cardId: string,
  columnId: string,
  mode: KanbanSwimlaneMode,
  laneValue?: string | null,
): KanbanBoard {
  if (mode === 'none' || mode === 'dueStatus') return board;

  let changed = false;
  const columns = board.columns.map((column) => {
    if (column.id !== columnId) return column;
    let columnChanged = false;
    const cards = column.cards.map((card) => {
      if (card.id !== cardId) return card;
      let next = card;
      if (mode === 'assignee') {
        const nextAssignees = laneValue ? [laneValue] : [];
        if (JSON.stringify(next.assignees) !== JSON.stringify(nextAssignees)) {
          next = { ...next, assignees: nextAssignees };
        }
      } else if (mode === 'priority') {
        const nextPriority = (laneValue ?? undefined) as KanbanPriority | undefined;
        if (next.priority !== nextPriority) {
          next = { ...next, priority: nextPriority };
        }
      } else if (mode === 'tag') {
        const nextTags = laneValue
          ? mergeUniqueTags(
              card.tags.filter((tag) => tag !== laneValue),
              [laneValue],
            )
          : [];
        if (JSON.stringify(next.tags) !== JSON.stringify(nextTags)) {
          next = { ...next, tags: nextTags };
        }
      }

      if (next !== card) {
        columnChanged = true;
        changed = true;
      }
      return next;
    });
    return columnChanged ? { ...column, cards } : column;
  });

  return changed ? { ...board, columns } : board;
}
