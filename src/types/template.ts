import type { KanbanBoard } from './kanban';

export type TemplateSource = 'vault' | 'app';

export interface KanbanTemplate {
  kind: 'kanban';
  name: string;
  source: TemplateSource;
  hash: string;
  updatedAt: number;
  board: KanbanBoard;
}
