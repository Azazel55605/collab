import { useEffect, useState } from 'react';

import { CheckSquare, GripVertical, Minus, Plus } from 'lucide-react';

import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { FormDialog } from '../ui/form-dialog';
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
  const lines = tasks.map((task) => task.text.trim()).filter((text) => text.length > 0);

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

  const [focusId, setFocusId] = useState<string | null>(null);
  const addTask = (afterId?: string) => {
    const task = { id: crypto.randomUUID(), text: '', checked: false };
    setDraft((prev) => {
      const index = afterId ? prev.findIndex((entry) => entry.id === afterId) : -1;
      return index < 0
        ? [...prev, task]
        : [...prev.slice(0, index + 1), task, ...prev.slice(index + 1)];
    });
    setFocusId(task.id);
  };

  const removeTask = (id: string) => {
    setDraft((prev) => (prev.length > 1 ? prev.filter((task) => task.id !== id) : prev));
  };

  const filled = draft.filter((task) => task.text.trim().length > 0).length;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<CheckSquare />}
      title="Insert task list"
      description="Type the tasks, tick the ones already done, then insert them as a Markdown list."
      submitLabel="Insert task list"
      submitDisabled={filled === 0}
      onSubmit={() => onApply(draft)}
      secondary={
        <span className="text-xs text-muted-foreground">
          {filled} of {draft.length} filled
        </span>
      }
      bodyClassName="gap-2"
    >
      <ul className="flex flex-col gap-1.5" aria-label="Tasks">
        {draft.map((task, index) => (
          <li key={task.id} className="flex items-center gap-2.5">
            <GripVertical size={14} className="shrink-0 text-muted-foreground/50" />
            <Checkbox
              checked={task.checked}
              onCheckedChange={(checked) => updateTask(task.id, { checked: checked === true })}
              aria-label={`Task ${index + 1} done`}
            />
            <Input
              value={task.text}
              autoFocus={task.id === focusId}
              onChange={(event) => updateTask(task.id, { text: event.target.value })}
              onKeyDown={(event) => {
                // Enter starts the next task, like in a list; Ctrl+Enter inserts.
                if (event.key === 'Enter' && !(event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  addTask(task.id);
                }
              }}
              placeholder={`Task ${index + 1}`}
              aria-label={`Task ${index + 1}`}
              className={task.checked ? 'text-muted-foreground line-through' : undefined}
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => removeTask(task.id)}
              disabled={draft.length <= 1}
              aria-label={`Remove task ${index + 1}`}
            >
              <Minus />
            </Button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => addTask()}
      >
        <Plus />
        Add task
      </Button>
    </FormDialog>
  );
}
