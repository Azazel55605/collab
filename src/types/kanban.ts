export interface KanbanBoard {
  id: string;
  title: string;
  columns: KanbanColumn[];
}

export interface KanbanColumn {
  id: string;
  title: string;
  color?: string;
  cards: KanbanCard[];
}

export interface KanbanCard {
  id: string;
  title: string;
  relativePath?: string;
  assignees: string[];
  tags: string[];
  dueDate?: string;
  priority?: 'low' | 'medium' | 'high';
  description?: string;
}
