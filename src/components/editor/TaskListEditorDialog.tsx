import { useEffect, useState } from 'react';
import { CheckSquare, GripVertical, Minus, Plus } from 'lucide-react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';

export interface TaskListItemDraft {
  id: string;
  text: string;
  checked: boolean;
}

interface TaskListEditorDialogProps {
  open: boolean;
  initialValue: TaskListItemDraft[];
  onOpenChange: (open: boolean) => void;
  onApply: (value: TaskListItemDraft[]) => void;
}

function cloneTasks(tasks: TaskListItemDraft[]): TaskListItemDraft[] {
  return tasks.map((task) => ({ ...task }));
}

export function renderMarkdownTaskList(tasks: TaskListItemDraft[]) {
  const lines = tasks
    .map((task) => task.text.trim())
    .filter((text) => text.length > 0);

  if (lines.length === 0) {
    return '- [ ] ';
  }

  return tasks
    .filter((task) => task.text.trim().length > 0)
    .map((task) => `- [${task.checked ? 'x' : ' '}] ${task.text.trim()}`)
    .join('\n');
}

export function createEmptyTaskList(): TaskListItemDraft[] {
  return [
    { id: crypto.randomUUID(), text: '', checked: false },
    { id: crypto.randomUUID(), text: '', checked: false },
  ];
}

export function TaskListEditorDialog({
  open,
  initialValue,
  onOpenChange,
  onApply,
}: TaskListEditorDialogProps) {
  const [draft, setDraft] = useState<TaskListItemDraft[]>(cloneTasks(initialValue));

  useEffect(() => {
    if (open) {
      setDraft(cloneTasks(initialValue));
    }
  }, [initialValue, open]);

  const updateTask = (id: string, nextTask: Partial<TaskListItemDraft>) => {
    setDraft((prev) => prev.map((task) => (task.id === id ? { ...task, ...nextTask } : task)));
  };

  const addTask = () => {
    setDraft((prev) => [...prev, { id: crypto.randomUUID(), text: '', checked: false }]);
  };

  const removeTask = (id: string) => {
    setDraft((prev) => (prev.length > 1 ? prev.filter((task) => task.id !== id) : prev));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="border-b border-border/40 px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <CheckSquare size={16} />
            Insert task list
          </DialogTitle>
          <DialogDescription>
            Add multiple tasks, choose their checked state, and insert the markdown list into the note.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 border-b border-border/30 px-5 py-3">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={addTask}>
            <Plus size={13} />
            Task
          </Button>
          <div className="ml-auto text-xs text-muted-foreground">
            {draft.filter((task) => task.text.trim().length > 0).length} filled, {draft.length} total
          </div>
        </div>

        <div className="max-h-[60vh] overflow-auto px-5 py-4">
          <div className="space-y-3">
            {draft.map((task, index) => (
              <div
                key={task.id}
                className="flex items-center gap-3 rounded-xl border border-border/30 bg-background/40 px-3 py-3"
              >
                <GripVertical size={14} className="shrink-0 text-muted-foreground/60" />
                <Button
                  type="button"
                  size="sm"
                  variant={task.checked ? 'default' : 'outline'}
                  className="h-8 shrink-0 px-2.5 text-xs"
                  onClick={() => updateTask(task.id, { checked: !task.checked })}
                >
                  [{task.checked ? 'x' : ' '}]
                </Button>
                <Input
                  value={task.text}
                  onChange={(event) => updateTask(task.id, { text: event.target.value })}
                  placeholder={`Task ${index + 1}`}
                  className="h-9"
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  onClick={() => removeTask(task.id)}
                  disabled={draft.length <= 1}
                  aria-label={`Remove task ${index + 1}`}
                >
                  <Minus size={14} />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter className="-mx-0 -mb-0 border-none bg-transparent px-5 pb-5 pt-3 gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onApply(draft)} disabled={!draft.some((task) => task.text.trim().length > 0)}>
            Insert task list
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
