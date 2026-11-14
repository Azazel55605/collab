import { useEffect, useState } from 'react';

import { Cpu, LayoutTemplate, Loader2, Pencil, RotateCcw } from 'lucide-react';

import type {
  LogicComponentDefinition,
  LogicComponentInstanceMode,
} from '../../types/logicDiagram';
import { ChoiceCard, ChoiceGroup } from '../ui/app-dialog';
import { Button } from '../ui/button';
import { PickerDialog, PickerRow } from '../ui/picker-dialog';

import type { LogicDiagramTemplate } from './logicDiagramTemplates';

/** Insert template: a searchable list of starting diagrams. */
export function LogicTemplatePicker({
  open,
  onOpenChange,
  templates,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: LogicDiagramTemplate[];
  onInsert: (template: LogicDiagramTemplate) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? templates.filter((template) =>
        `${template.name} ${template.description}`.toLowerCase().includes(needle),
      )
    : templates;
  return (
    <PickerDialog
      open={open}
      onOpenChange={onOpenChange}
      size="m"
      className="h-[min(560px,calc(100vh-2rem))]"
      icon={<LayoutTemplate />}
      title="Insert template"
      description="Added to the current diagram at the centre of the view."
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search templates"
      groups={[{ items: shown }]}
      getKey={(template) => template.id}
      selectedKey={selected}
      onSelect={setSelected}
      renderItem={(template) => (
        <PickerRow icon={<LayoutTemplate />} title={template.name} detail={template.description} />
      )}
      onPick={onInsert}
      pickLabel={(template) => (template ? `Insert ${template.name}` : 'Insert')}
      emptyText="No matching templates."
    />
  );
}

function ports(component: LogicComponentDefinition, direction: 'input' | 'output') {
  return (
    component.ports
      .filter((port) => port.direction === direction)
      .map((port) => port.label)
      .join(' ') || 'none'
  );
}

/**
 * Insert component: saved components as a grid, the selection's ports and the
 * insert mode on the right. Snapshot is the safe default; linked follows future
 * updates of the component.
 */
export function LogicComponentPicker({
  open,
  onOpenChange,
  components,
  loading,
  mode,
  onModeChange,
  onReload,
  onInsert,
  onEdit,
  editDisabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  components: LogicComponentDefinition[];
  loading: boolean;
  mode: LogicComponentInstanceMode;
  onModeChange: (mode: LogicComponentInstanceMode) => void;
  onReload: () => void;
  onInsert: (component: LogicComponentDefinition) => void;
  onEdit: (component: LogicComponentDefinition) => void;
  editDisabled: boolean;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? components.filter((component) =>
        `${component.name} ${component.description ?? ''}`.toLowerCase().includes(needle),
      )
    : components;
  const current = components.find((component) => component.id === selected) ?? null;
  return (
    <PickerDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<Cpu />}
      title="Insert component"
      description="Saved components from this vault, placed as single reusable nodes."
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search components"
      layout="grid"
      groups={[{ items: shown }]}
      getKey={(component) => component.id}
      selectedKey={selected}
      onSelect={setSelected}
      renderItem={(component) => (
        <div className="flex flex-col gap-1.5">
          <div className="flex h-12 items-center justify-center rounded-md border border-border/50 bg-background/60 text-muted-foreground">
            <Cpu className="size-6" />
          </div>
          <span className="truncate text-[13px] font-medium">{component.name}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {ports(component, 'input')} → {ports(component, 'output')}
          </span>
        </div>
      )}
      onPick={onInsert}
      pickLabel={(component) => (component ? `Insert ${component.name}` : 'Insert')}
      emptyText={
        loading ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" />
            Loading components…
          </span>
        ) : (
          'No saved logic components in this vault yet.'
        )
      }
      secondary={
        <Button type="button" variant="ghost" onClick={onReload} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          Refresh
        </Button>
      }
      preview={
        current ? (
          <>
            <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              {current.name}
            </p>
            {current.description && <p className="text-muted-foreground">{current.description}</p>}
            <p className="font-mono text-xs leading-relaxed">
              in&nbsp;&nbsp;{ports(current, 'input')}
              <br />
              out {ports(current, 'output')}
              <br />
              <span className="text-muted-foreground">version {current.version}</span>
            </p>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-medium text-foreground/85">Insert as</span>
              <ChoiceGroup
                value={mode}
                onValueChange={(value) => onModeChange(value as LogicComponentInstanceMode)}
                aria-label="Insert mode"
              >
                <ChoiceCard
                  value="snapshot"
                  title="Snapshot"
                  description="A copy that stays as it is now"
                />
                <ChoiceCard
                  value="linked"
                  title="Linked"
                  description="Follows later changes to the component"
                />
              </ChoiceGroup>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label="Edit saved component"
              disabled={editDisabled}
              onClick={() => onEdit(current)}
            >
              <Pencil />
              Edit component
            </Button>
          </>
        ) : undefined
      }
    />
  );
}
