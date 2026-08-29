import { useMemo, useState } from 'react';

import { format } from 'date-fns';
import { Box, Calendar, Tag, Trash2, Users } from 'lucide-react';

import { formatDate } from '../../store/uiStore';
import type {
  CanvasNodePriority,
  CanvasPlanningMetadata,
  CanvasPlanningStatus,
  CanvasSwimlaneOrientation,
  PlanningCanvasNode,
} from '../../types/canvas';
import type { KnownUser } from '../../types/vault';
import { Button } from '../ui/button';
import { Calendar as CalendarUI } from '../ui/calendar';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Textarea } from '../ui/textarea';

import { supportsLinkedPath, supportsPlanningMetadata } from './canvasDiagramUtils';
import { getPlanningNodeLabel } from './canvasPlanning';

interface CanvasNodeInspectorProps {
  selectedNode: {
    id: string;
    type: string;
    title?: string;
    subtitle?: string;
    content?: string;
    symbolGlyph?: string;
    symbolId?: string;
    symbolLabel?: string;
    relativePath?: string;
    linkedRelativePath?: string;
    planning?: CanvasPlanningMetadata;
    orientation?: CanvasSwimlaneOrientation;
  } | null;
  knownUsers: KnownUser[];
  availableTags: string[];
  dateFormat: Parameters<typeof formatDate>[1];
  onTitleChange: (title: string) => void;
  onBodyChange: (body: string) => void;
  onPickSymbol: () => void;
  onPickLinkedPath: () => void;
  onLinkedPathChange: (relativePath: string) => void;
  onPlanningChange: (planning: CanvasPlanningMetadata) => void;
  onOrientationChange: (orientation: CanvasSwimlaneOrientation) => void;
  onDeleteSelected: () => void;
}

const statusOptions: CanvasPlanningStatus[] = ['not_started', 'in_progress', 'blocked', 'done'];
const priorityOptions: CanvasNodePriority[] = ['low', 'medium', 'high', 'critical'];
const canvasInspectorSelectTriggerClassName =
  'h-8 w-full rounded-xl border-border/60 bg-background/80 text-xs shadow-none';
const canvasInspectorSelectContentClassName =
  'min-w-[var(--radix-select-trigger-width)] rounded-xl ring-1 ring-border/60';

export function CanvasNodeInspector({
  selectedNode,
  knownUsers,
  availableTags,
  dateFormat,
  onTitleChange,
  onBodyChange,
  onPickSymbol,
  onPickLinkedPath,
  onLinkedPathChange,
  onPlanningChange,
  onOrientationChange,
  onDeleteSelected,
}: CanvasNodeInspectorProps) {
  const kind = selectedNode?.type;
  const isPlanningNode =
    !!kind && !['noteCard', 'fileCard', 'textCard', 'webCard', 'symbolCard'].includes(kind);
  const isSymbolNode = kind === 'symbolCard';
  const isFileBackedNode = kind === 'noteCard' || kind === 'fileCard';
  const isDescriptivePlanningNode =
    isPlanningNode && kind !== 'junctionCard' && kind !== 'crossingCard';
  const planningKind = kind?.replace(/Card$/, '') as PlanningCanvasNode['type'] | undefined;
  const planning = selectedNode?.planning ?? {};
  const [dueDateOpen, setDueDateOpen] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [tagInputFocused, setTagInputFocused] = useState(false);
  const selectedTags = planning.tags ?? [];
  const suggestedTags = useMemo(
    () =>
      availableTags
        .filter((tag) => !selectedTags.includes(tag))
        .filter((tag) => !tagInput || tag.toLowerCase().includes(tagInput.toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    [availableTags, selectedTags, tagInput],
  );

  const addPlanningTag = (tag: string) => {
    const trimmed = tag.trim().replace(/,$/, '');
    if (!trimmed || selectedTags.includes(trimmed)) {
      setTagInput('');
      return;
    }
    onPlanningChange({ ...planning, tags: [...selectedTags, trimmed] });
    setTagInput('');
    setTagInputFocused(false);
  };

  const removePlanningTag = (tag: string) => {
    onPlanningChange({ ...planning, tags: selectedTags.filter((entry) => entry !== tag) });
  };

  return (
    <div className="pointer-events-auto flex max-w-[min(420px,calc(100vw-220px))] flex-col gap-2 rounded-2xl border border-border/60 bg-popover/90 p-2.5 shadow-xl backdrop-blur-xs-webkit app-panel-enter">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Box size={13} />
        Selected node
      </div>
      {selectedNode ? (
        <>
          {isSymbolNode ? (
            <>
              <div className="rounded-xl border border-border/60 bg-card/45 p-3">
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Selected symbol
                </div>
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-background/65 text-[28px] leading-none text-primary"
                    style={{ fontFamily: "'Pure Nerd Font', PureNerdFont, monospace" }}
                    aria-hidden="true"
                  >
                    {selectedNode.symbolGlyph || '?'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {selectedNode.symbolLabel || selectedNode.title || 'Canvas symbol'}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {selectedNode.symbolId || 'Nerd Font icon'}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={onPickSymbol}>
                    Change icon
                  </Button>
                </div>
              </div>
              <Input
                value={selectedNode.title ?? ''}
                onChange={(event) => onTitleChange(event.target.value)}
                placeholder="Optional caption"
                className="h-8"
              />
            </>
          ) : isFileBackedNode ? (
            <div className="rounded-xl border border-border/60 bg-card/45 px-3 py-2 text-xs">
              <div className="font-medium text-foreground">{selectedNode.title}</div>
              <div className="truncate text-muted-foreground">
                {selectedNode.relativePath ?? selectedNode.subtitle}
              </div>
            </div>
          ) : kind === 'textCard' || kind === 'webCard' ? null : (
            <Input
              value={selectedNode.title ?? ''}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder="Node title"
              className="h-8"
            />
          )}
          {isFileBackedNode || isDescriptivePlanningNode ? (
            <Textarea
              value={selectedNode.content ?? ''}
              onChange={(event) => onBodyChange(event.target.value)}
              placeholder={
                isFileBackedNode
                  ? 'Add a canvas-local description'
                  : 'Description, branch notes, or supporting context'
              }
              className="min-h-24 resize-y text-sm"
            />
          ) : null}
          {isPlanningNode ? (
            <>
              <div className="rounded-xl border border-border/60 bg-card/45 px-3 py-2 text-xs">
                <div className="font-medium text-foreground">
                  {planningKind ? getPlanningNodeLabel(planningKind) : 'Planning node'}
                </div>
                <div className="text-muted-foreground">
                  Planning metadata stays local to this canvas for v1.
                </div>
              </div>
              {planningKind && supportsLinkedPath(planningKind) ? (
                <div className="flex gap-2">
                  <Input
                    value={selectedNode.linkedRelativePath ?? ''}
                    onChange={(event) => onLinkedPathChange(event.target.value)}
                    placeholder="Optional linked vault path"
                    className="h-8"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="shrink-0"
                    onClick={onPickLinkedPath}
                  >
                    Select file
                  </Button>
                </div>
              ) : null}
              {planningKind && supportsPlanningMetadata(planningKind) ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-xl border border-border/60 bg-card/45 p-2">
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                        Status
                      </div>
                      <Select
                        value={planning.status ?? 'not_started'}
                        onValueChange={(value) =>
                          onPlanningChange({ ...planning, status: value as CanvasPlanningStatus })
                        }
                      >
                        <SelectTrigger size="sm" className={canvasInspectorSelectTriggerClassName}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent
                          align="end"
                          position="popper"
                          className={canvasInspectorSelectContentClassName}
                        >
                          {statusOptions.map((status) => (
                            <SelectItem key={status} value={status}>
                              {status.replace(/_/g, ' ')}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-card/45 p-2">
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                        Priority
                      </div>
                      <Select
                        value={planning.priority ?? 'medium'}
                        onValueChange={(value) =>
                          onPlanningChange({ ...planning, priority: value as CanvasNodePriority })
                        }
                      >
                        <SelectTrigger size="sm" className={canvasInspectorSelectTriggerClassName}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent
                          align="end"
                          position="popper"
                          className={canvasInspectorSelectContentClassName}
                        >
                          {priorityOptions.map((priority) => (
                            <SelectItem key={priority} value={priority}>
                              <span className="flex items-center gap-2">
                                <span
                                  className={
                                    priority === 'critical' || priority === 'high'
                                      ? 'inline-block size-2 rounded-full bg-red-400'
                                      : priority === 'medium'
                                        ? 'inline-block size-2 rounded-full bg-yellow-400'
                                        : 'inline-block size-2 rounded-full bg-green-400'
                                  }
                                />
                                {priority}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-xl border border-border/60 bg-card/45 p-2">
                      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                        <Users size={11} />
                        Owner
                      </div>
                      <Select
                        value={planning.ownerLabel ?? '__none__'}
                        onValueChange={(value) =>
                          onPlanningChange({
                            ...planning,
                            ownerLabel: value === '__none__' ? undefined : value,
                          })
                        }
                      >
                        <SelectTrigger size="sm" className={canvasInspectorSelectTriggerClassName}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent
                          align="end"
                          position="popper"
                          className={canvasInspectorSelectContentClassName}
                        >
                          <SelectItem value="__none__">No owner</SelectItem>
                          {knownUsers.map((user) => (
                            <SelectItem key={user.userId} value={user.userName}>
                              <span className="flex items-center gap-2">
                                <span
                                  className="inline-block size-2 rounded-full"
                                  style={{ backgroundColor: user.userColor }}
                                />
                                {user.userName}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-card/45 p-2">
                      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                        <Calendar size={11} />
                        Due date
                      </div>
                      <Popover open={dueDateOpen} onOpenChange={setDueDateOpen}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="flex h-8 w-full items-center gap-1.5 rounded-xl border border-border/60 bg-background/80 px-2.5 text-left text-xs text-foreground shadow-none transition-colors hover:border-border"
                          >
                            <Calendar size={10} className="shrink-0 text-muted-foreground" />
                            {planning.dueDate
                              ? formatDate(new Date(`${planning.dueDate}T12:00:00`), dateFormat)
                              : 'Pick a date'}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-auto p-0" sideOffset={4}>
                          <CalendarUI
                            mode="single"
                            selected={
                              planning.dueDate
                                ? new Date(`${planning.dueDate}T12:00:00`)
                                : undefined
                            }
                            onSelect={(date) => {
                              onPlanningChange({
                                ...planning,
                                dueDate: date ? format(date, 'yyyy-MM-dd') : undefined,
                              });
                              setDueDateOpen(false);
                            }}
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      value={planning.milestoneLabel ?? ''}
                      onChange={(event) =>
                        onPlanningChange({ ...planning, milestoneLabel: event.target.value })
                      }
                      placeholder="Milestone label"
                      className="h-8"
                    />
                    <div className="rounded-xl border border-border/60 bg-card/45 p-2">
                      <div className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                        <Tag size={11} />
                        Tags
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {selectedTags.map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => removePlanningTag(tag)}
                            className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/25"
                          >
                            {tag} ×
                          </button>
                        ))}
                      </div>
                      <div className="relative mt-2">
                        <Input
                          value={tagInput}
                          onChange={(event) => setTagInput(event.target.value)}
                          onFocus={() => setTagInputFocused(true)}
                          onBlur={() => setTimeout(() => setTagInputFocused(false), 150)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ',') {
                              event.preventDefault();
                              addPlanningTag(tagInput);
                            }
                            if (event.key === 'Escape') setTagInputFocused(false);
                          }}
                          placeholder="Type tag, press Enter"
                          className="h-8"
                        />
                        {tagInputFocused && suggestedTags.length > 0 ? (
                          <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-40 overflow-y-auto rounded-md border border-border/50 bg-popover shadow-lg">
                            {suggestedTags.map((tag) => (
                              <button
                                key={tag}
                                type="button"
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => addPlanningTag(tag)}
                                className="w-full px-2.5 py-1.5 text-left text-xs text-foreground/80 transition-colors hover:bg-accent/60"
                              >
                                {tag}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </>
              ) : null}
              {kind === 'swimlaneCard' ? (
                <div className="rounded-xl border border-border/60 bg-card/45 p-2">
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                    Orientation
                  </div>
                  <Select
                    value={selectedNode.orientation ?? 'horizontal'}
                    onValueChange={(value) =>
                      onOrientationChange(value as CanvasSwimlaneOrientation)
                    }
                  >
                    <SelectTrigger size="sm" className={canvasInspectorSelectTriggerClassName}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent
                      align="end"
                      position="popper"
                      className={canvasInspectorSelectContentClassName}
                    >
                      <SelectItem value="horizontal">Horizontal</SelectItem>
                      <SelectItem value="vertical">Vertical</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="gap-2 self-start"
            onClick={onDeleteSelected}
          >
            <Trash2 size={14} />
            Delete selected
          </Button>
        </>
      ) : (
        <div className="text-xs text-muted-foreground/75">
          Select a canvas node to edit its label, notes, or planning metadata.
        </div>
      )}
    </div>
  );
}
