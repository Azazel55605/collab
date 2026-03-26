import { LayoutDashboard } from 'lucide-react';

// Kanban view — full implementation coming soon
export default function KanbanPage({ relativePath }: { relativePath: string | null }) {
  return (
    <div className="flex flex-col h-full items-center justify-center text-muted-foreground gap-3 select-none">
      <LayoutDashboard size={40} className="opacity-30" />
      <p className="text-lg font-medium">Kanban Board</p>
      <p className="text-sm opacity-60">
        {relativePath ? relativePath : 'Assign tasks to collaborators with a drag-and-drop board.'}
      </p>
    </div>
  );
}
