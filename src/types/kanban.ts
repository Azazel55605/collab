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
  assignees: string[];
  tags: string[];
  startDate?: string;   // YYYY-MM-DD; if absent, createdAt is used
  dueDate?: string;     // YYYY-MM-DD
  createdAt?: number;   // Unix ms — set on creation
  priority?: 'low' | 'medium' | 'high';
  comments: KanbanComment[];
  checklist: ChecklistItem[];
  isDone?: boolean;
}

export interface KanbanColumn {
  id: string;
  title: string;
  color?: string;
  autoComplete?: boolean; // auto-mark cards done when dropped here
  cards: KanbanCard[];
}

export interface KanbanBoard {
  columns: KanbanColumn[];
}
