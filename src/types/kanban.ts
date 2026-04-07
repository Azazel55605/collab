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
  cardRef?: string; // optional: references another card's ID on this board
}

export interface KanbanCard {
  id: string;
  title: string;
  description?: string;
  relativePath?: string;
  attachmentPaths?: string[];
  assignees: string[];
  tags: string[];
  startDate?: string;   // YYYY-MM-DD; if absent, createdAt is used
  dueDate?: string;     // YYYY-MM-DD
  createdAt?: number;   // Unix ms — set on creation
  priority?: 'low' | 'medium' | 'high';
  comments: KanbanComment[];
  checklist: ChecklistItem[];
  isDone?: boolean;
  archived?: boolean;
  archivedColumnId?: string; // remembers the column the card was in when archived
}

export type ColumnSortField = 'none' | 'name' | 'priority' | 'createdAt' | 'startDate' | 'dueDate' | 'assignees';

export interface KanbanColumn {
  id: string;
  title: string;
  color?: string;
  autoComplete?: boolean;     // auto-mark cards done when dropped here
  sort?: { field: ColumnSortField; dir: 'asc' | 'desc' };
  hideFromTimeline?: boolean; // exclude cards from Calendar and Timeline views
  isDoneDestination?: boolean; // done cards from other columns are moved here
  defaultTags?: string[];     // tags automatically assigned to new cards
  cards: KanbanCard[];
}

export interface KanbanBoard {
  columns: KanbanColumn[];
}

export function getCardAttachmentPaths(card: Pick<KanbanCard, 'relativePath' | 'attachmentPaths'>): string[] {
  const paths = [
    ...(card.attachmentPaths ?? []),
    ...(card.relativePath ? [card.relativePath] : []),
  ].filter(Boolean);

  return [...new Set(paths)];
}
