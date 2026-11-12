import type { ActiveView } from '../../store/uiStore';

export const WORKSPACE_ORDER = ['editor', 'chats', 'calendar', 'databases', 'grid'] as const;

export type WorkspaceView = (typeof WORKSPACE_ORDER)[number];

export function activityWorkspace(view: ActiveView): WorkspaceView {
  return view === 'graph' || view === 'canvas' || view === 'kanban' ? 'editor' : view;
}
