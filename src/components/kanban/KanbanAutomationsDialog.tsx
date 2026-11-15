import { type ReactNode, useState } from 'react';

import { Trash2, Workflow } from 'lucide-react';

import type {
  KanbanAutomationAction,
  KanbanAutomationRule,
  KanbanColumn,
  KanbanPriority,
} from '../../types/kanban';
import type { KanbanAutomationPreset, TemplateSource } from '../../types/template';
import { ToggleSwitch } from '../settings/settingsControls';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  DetailRow,
  ListDetailDialog,
  ListDetailRow,
  useKeepSelection,
} from '../ui/list-detail-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

type ConditionKind =
  'overdue' | 'dueWithinDays' | 'hasTag' | 'column' | 'priority' | 'assigneeState' | 'doneState';
type ActionKind = KanbanAutomationAction['type'];

interface RuleDraft {
  trigger: KanbanAutomationRule['trigger'];
  conditionKind: ConditionKind;
  conditionValue: string;
  actionKind: ActionKind;
  actionValue: string;
}

function ruleToDraft(rule: KanbanAutomationRule): RuleDraft {
  const c = rule.condition;
  const [conditionKind, conditionValue]: [ConditionKind, string] = c.overdue
    ? ['overdue', '']
    : typeof c.dueWithinDays === 'number'
      ? ['dueWithinDays', String(c.dueWithinDays)]
      : c.hasTag !== undefined
        ? ['hasTag', c.hasTag]
        : c.columnId !== undefined
          ? ['column', c.columnId]
          : c.priority
            ? ['priority', c.priority]
            : c.assigneeState
              ? ['assigneeState', c.assigneeState]
              : typeof c.isDone === 'boolean'
                ? ['doneState', c.isDone ? 'done' : 'not-done']
                : ['overdue', ''];
  const a = rule.action;
  const actionValue =
    a.type === 'moveToColumn'
      ? a.columnId
      : a.type === 'addTag' || a.type === 'removeTag'
        ? a.tag
        : a.type === 'setPriority'
          ? a.priority
          : a.type === 'setDone'
            ? a.isDone
              ? 'done'
              : 'not-done'
            : (a.userId ?? '');
  return {
    trigger: rule.trigger,
    conditionKind,
    conditionValue,
    actionKind: a.type,
    actionValue,
  };
}

function applyDraft(rule: KanbanAutomationRule, draft: RuleDraft): KanbanAutomationRule {
  const condition =
    draft.conditionKind === 'overdue'
      ? { overdue: true }
      : draft.conditionKind === 'dueWithinDays'
        ? { dueWithinDays: Math.max(0, Number(draft.conditionValue) || 0) }
        : draft.conditionKind === 'hasTag'
          ? { hasTag: draft.conditionValue.trim() }
          : draft.conditionKind === 'column'
            ? { columnId: draft.conditionValue }
            : draft.conditionKind === 'priority'
              ? { priority: (draft.conditionValue || 'none') as KanbanPriority | 'none' }
              : draft.conditionKind === 'assigneeState'
                ? { assigneeState: (draft.conditionValue || 'empty') as 'empty' | 'present' }
                : { isDone: draft.conditionValue !== 'not-done' };
  const action: KanbanAutomationAction =
    draft.actionKind === 'moveToColumn'
      ? { type: 'moveToColumn', columnId: draft.actionValue }
      : draft.actionKind === 'addTag'
        ? { type: 'addTag', tag: draft.actionValue.trim() }
        : draft.actionKind === 'removeTag'
          ? { type: 'removeTag', tag: draft.actionValue.trim() }
          : draft.actionKind === 'setPriority'
            ? {
                type: 'setPriority',
                priority: (draft.actionValue || 'none') as KanbanPriority | 'none',
              }
            : draft.actionKind === 'setDone'
              ? { type: 'setDone', isDone: draft.actionValue !== 'not-done' }
              : { type: 'assignUser', userId: draft.actionValue || null };
  return { ...rule, trigger: draft.trigger, condition, action };
}

function makeAutomationRule(columns: KanbanColumn[]): KanbanAutomationRule {
  return {
    id: crypto.randomUUID(),
    name: 'New rule',
    enabled: true,
    trigger: 'manual',
    condition: { overdue: true },
    action: { type: 'moveToColumn', columnId: columns[0]?.id ?? '' },
  };
}

const TRIGGERS: Record<KanbanAutomationRule['trigger'], string> = {
  manual: 'I run the rules',
  onBoardOpen: 'the board opens',
  onBoardSave: 'the board is saved',
};
const CONDITIONS: Record<ConditionKind, string> = {
  overdue: 'is overdue',
  dueWithinDays: 'is due within',
  hasTag: 'has the tag',
  column: 'is in',
  priority: 'has priority',
  assigneeState: 'is',
  doneState: 'is',
};
const ACTIONS: Record<ActionKind, string> = {
  moveToColumn: 'move it to',
  addTag: 'add the tag',
  removeTag: 'remove the tag',
  setPriority: 'set priority to',
  setDone: 'mark it',
  assignUser: 'assign it to',
};
const PRIORITIES = { none: 'no priority', high: 'high', medium: 'medium', low: 'low' };

function priorityLabel(value: string) {
  return PRIORITIES[value as keyof typeof PRIORITIES] ?? value;
}

/** One line summary used in the list: "When the board opens · if overdue → move to Done". */
function describeAutomationRule(rule: KanbanAutomationRule, columns: KanbanColumn[]) {
  const d = ruleToDraft(rule);
  const column = (id: string) => columns.find((entry) => entry.id === id)?.title ?? (id || '…');
  const condition =
    d.conditionKind === 'overdue'
      ? 'overdue'
      : d.conditionKind === 'dueWithinDays'
        ? `due within ${d.conditionValue} day(s)`
        : d.conditionKind === 'hasTag'
          ? `tagged ${d.conditionValue || '…'}`
          : d.conditionKind === 'column'
            ? `in ${column(d.conditionValue)}`
            : d.conditionKind === 'priority'
              ? `priority ${priorityLabel(d.conditionValue)}`
              : d.conditionKind === 'assigneeState'
                ? d.conditionValue === 'present'
                  ? 'assigned'
                  : 'unassigned'
                : d.conditionValue === 'not-done'
                  ? 'not done'
                  : 'done';
  const action =
    d.actionKind === 'moveToColumn'
      ? `move to ${column(d.actionValue)}`
      : d.actionKind === 'addTag'
        ? `add tag ${d.actionValue || '…'}`
        : d.actionKind === 'removeTag'
          ? `remove tag ${d.actionValue || '…'}`
          : d.actionKind === 'setPriority'
            ? `set priority ${priorityLabel(d.actionValue)}`
            : d.actionKind === 'setDone'
              ? `mark ${d.actionValue === 'not-done' ? 'not done' : 'done'}`
              : d.actionValue
                ? 'assign a user'
                : 'unassign';
  return `If ${condition} → ${action}`;
}

/** A select drawn as an inline token in the rule sentence. */
function Token({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label={label}
        className="h-7 w-auto gap-1 rounded-md border-primary/30 bg-primary/10 px-2 text-[13px] font-medium text-foreground"
      >
        <SelectValue placeholder={placeholder ?? 'Choose'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="text-[13px]">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function TextToken({
  label,
  value,
  onChange,
  placeholder,
  type,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  type?: 'number';
}) {
  return (
    <Input
      aria-label={label}
      type={type}
      min={type === 'number' ? 0 : undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="h-7 w-28 rounded-md border-primary/30 bg-primary/10 px-2 text-[13px] font-medium"
    />
  );
}

function Clause({ word, children }: { word: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13.5px]">
      <span className="w-12 shrink-0 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {word}
      </span>
      {children}
    </div>
  );
}

function presetToken(preset: KanbanAutomationPreset) {
  return `${preset.source}:${preset.name}`;
}

export interface KanbanAutomationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rules: KanbanAutomationRule[];
  columns: KanbanColumn[];
  users: { userId: string; userName: string }[];
  onAdd: (rule: KanbanAutomationRule) => void;
  onUpdate: (rule: KanbanAutomationRule) => void;
  onDelete: (ruleId: string) => void;
  presets: KanbanAutomationPreset[];
  onApplyPreset: (preset: KanbanAutomationPreset) => void;
  onSavePreset: (
    rule: KanbanAutomationRule,
    source: Extract<TemplateSource, 'vault' | 'app'>,
    name: string,
  ) => void;
  vaultPresetsAvailable: boolean;
  onRunNow: () => void;
}

/**
 * Board automations (template 4): rules on the left with an on/off switch, the
 * selected rule on the right as one sentence — When … If a card … Then … —
 * where every part is a token you can change. Edits apply right away.
 */
export function KanbanAutomationsDialog({
  open,
  onOpenChange,
  rules,
  columns,
  users,
  onAdd,
  onUpdate,
  onDelete,
  presets,
  onApplyPreset,
  onSavePreset,
  vaultPresetsAvailable,
  onRunNow,
}: KanbanAutomationsDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [presetName, setPresetName] = useState('');
  useKeepSelection(rules, (rule) => rule.id, selectedId, setSelectedId, open);
  const selected = rules.find((rule) => rule.id === selectedId) ?? null;

  const columnOptions = columns.map((column) => ({ value: column.id, label: column.title }));
  const priorityOptions = Object.entries(PRIORITIES).map(([value, label]) => ({ value, label }));

  const addRule = () => {
    const rule = makeAutomationRule(columns);
    onAdd(rule);
    setSelectedId(rule.id);
  };

  const presetPicker =
    presets.length > 0 ? (
      <Select
        value=""
        onValueChange={(value) => {
          const preset = presets.find((entry) => presetToken(entry) === value);
          if (preset) onApplyPreset(preset);
        }}
      >
        <SelectTrigger size="sm" aria-label="Add from preset" className="w-full text-xs">
          <SelectValue placeholder="Add from preset…" />
        </SelectTrigger>
        <SelectContent>
          {presets.map((preset) => (
            <SelectItem key={presetToken(preset)} value={presetToken(preset)} className="text-xs">
              {preset.name}
              <span className="text-muted-foreground"> · {preset.source}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null;

  const renderDetail = (rule: KanbanAutomationRule) => {
    const draft = ruleToDraft(rule);
    const set = (patch: Partial<RuleDraft>) => onUpdate(applyDraft(rule, { ...draft, ...patch }));
    const conditionValue = () => {
      switch (draft.conditionKind) {
        case 'dueWithinDays':
          return (
            <>
              <TextToken
                label="Days"
                type="number"
                value={draft.conditionValue}
                onChange={(value) => set({ conditionValue: value })}
                placeholder="Days"
              />
              <span>days</span>
            </>
          );
        case 'hasTag':
          return (
            <TextToken
              label="Condition tag"
              value={draft.conditionValue}
              onChange={(value) => set({ conditionValue: value })}
              placeholder="tag"
            />
          );
        case 'column':
          return (
            <Token
              label="Condition column"
              value={draft.conditionValue}
              onChange={(value) => set({ conditionValue: value })}
              options={columnOptions}
              placeholder="a column"
            />
          );
        case 'priority':
          return (
            <Token
              label="Condition priority"
              value={draft.conditionValue || 'none'}
              onChange={(value) => set({ conditionValue: value })}
              options={priorityOptions}
            />
          );
        case 'assigneeState':
          return (
            <Token
              label="Assignee state"
              value={draft.conditionValue || 'empty'}
              onChange={(value) => set({ conditionValue: value })}
              options={[
                { value: 'empty', label: 'unassigned' },
                { value: 'present', label: 'assigned' },
              ]}
            />
          );
        case 'doneState':
          return (
            <Token
              label="Done state"
              value={draft.conditionValue || 'done'}
              onChange={(value) => set({ conditionValue: value })}
              options={[
                { value: 'done', label: 'done' },
                { value: 'not-done', label: 'not done' },
              ]}
            />
          );
        default:
          return null;
      }
    };
    const actionValue = () => {
      switch (draft.actionKind) {
        case 'moveToColumn':
          return (
            <Token
              label="Target column"
              value={draft.actionValue}
              onChange={(value) => set({ actionValue: value })}
              options={columnOptions}
              placeholder="a column"
            />
          );
        case 'addTag':
        case 'removeTag':
          return (
            <TextToken
              label="Action tag"
              value={draft.actionValue}
              onChange={(value) => set({ actionValue: value })}
              placeholder="tag"
            />
          );
        case 'setPriority':
          return (
            <Token
              label="New priority"
              value={draft.actionValue || 'none'}
              onChange={(value) => set({ actionValue: value })}
              options={priorityOptions}
            />
          );
        case 'setDone':
          return (
            <Token
              label="Mark as"
              value={draft.actionValue || 'done'}
              onChange={(value) => set({ actionValue: value })}
              options={[
                { value: 'done', label: 'done' },
                { value: 'not-done', label: 'not done' },
              ]}
            />
          );
        default:
          return (
            <Token
              label="Assignee"
              value={draft.actionValue || '__none__'}
              onChange={(value) => set({ actionValue: value === '__none__' ? '' : value })}
              options={[
                { value: '__none__', label: 'nobody' },
                ...users.map((user) => ({ value: user.userId, label: user.userName })),
              ]}
            />
          );
      }
    };

    return (
      <div className="flex flex-col gap-4">
        <Input
          aria-label="Rule name"
          value={rule.name}
          onChange={(event) => onUpdate({ ...rule, name: event.target.value })}
          className="h-9 border-transparent bg-transparent px-0 text-base font-semibold shadow-none focus-visible:border-border focus-visible:px-2"
        />
        <div className="flex flex-col gap-3 rounded-[10px] border border-border/60 bg-muted/20 px-4 py-3.5">
          <Clause word="When">
            <Token
              label="Trigger"
              value={draft.trigger}
              onChange={(value) => set({ trigger: value as RuleDraft['trigger'] })}
              options={Object.entries(TRIGGERS).map(([value, label]) => ({ value, label }))}
            />
          </Clause>
          <Clause word="If">
            <span>a card</span>
            <Token
              label="Condition"
              value={draft.conditionKind}
              onChange={(value) =>
                set({ conditionKind: value as ConditionKind, conditionValue: '' })
              }
              options={Object.entries(CONDITIONS).map(([value, label]) => ({
                value,
                label:
                  value === 'assigneeState'
                    ? 'is (un)assigned'
                    : value === 'doneState'
                      ? 'is (not) done'
                      : label,
              }))}
            />
            {conditionValue()}
          </Clause>
          <Clause word="Then">
            <Token
              label="Action"
              value={draft.actionKind}
              onChange={(value) => set({ actionKind: value as ActionKind, actionValue: '' })}
              options={Object.entries(ACTIONS).map(([value, label]) => ({ value, label }))}
            />
            {actionValue()}
          </Clause>
        </div>
        <div className="flex flex-col">
          <DetailRow
            label="Active"
            description={
              rule.trigger === 'manual'
                ? 'Runs when you choose Run automations in the board menu.'
                : 'Paused rules keep their settings but do nothing.'
            }
          >
            <ToggleSwitch
              checked={rule.enabled}
              onToggle={() => onUpdate({ ...rule, enabled: !rule.enabled })}
              ariaLabel="Rule active"
            />
          </DetailRow>
          <DetailRow label="Save as preset" description="Reuse this rule on other boards.">
            <div className="flex items-center gap-1.5">
              <Input
                aria-label="Preset name"
                value={presetName}
                onChange={(event) => setPresetName(event.target.value)}
                placeholder={rule.name}
                className="h-8 w-36 text-xs"
              />
              {vaultPresetsAvailable && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onSavePreset(rule, 'vault', presetName.trim() || rule.name);
                    setPresetName('');
                  }}
                >
                  Vault
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onSavePreset(rule, 'app', presetName.trim() || rule.name);
                  setPresetName('');
                }}
              >
                App
              </Button>
            </div>
          </DetailRow>
        </div>
      </div>
    );
  };

  return (
    <ListDetailDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<Workflow />}
      title="Automations"
      description="Rules that update cards on this board."
      items={rules}
      getKey={(rule) => rule.id}
      selectedKey={selectedId}
      onSelect={setSelectedId}
      renderRow={(rule) => (
        <ListDetailRow
          title={rule.name}
          summary={describeAutomationRule(rule, columns)}
          muted={!rule.enabled}
          trailing={
            <ToggleSwitch
              checked={rule.enabled}
              onToggle={() => onUpdate({ ...rule, enabled: !rule.enabled })}
              ariaLabel={`${rule.name} active`}
            />
          }
        />
      )}
      renderDetail={renderDetail}
      newLabel="New rule"
      onNew={addRule}
      listFooter={presetPicker}
      footerStart={
        <>
          {selected && (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => onDelete(selected.id)}
            >
              <Trash2 />
              Delete rule
            </Button>
          )}
          {rules.some((rule) => rule.enabled && rule.trigger === 'manual') && (
            <Button variant="ghost" onClick={onRunNow}>
              Run manual rules
            </Button>
          )}
        </>
      }
      empty={{
        title: 'No automations yet',
        description:
          'A rule moves, tags or assigns cards for you — when the board opens, when it is saved, or when you run it.',
        action: (
          <div className="mt-2 flex flex-col items-center gap-2">
            <Button onClick={addRule}>New rule</Button>
            {presetPicker && <div className="w-52">{presetPicker}</div>}
          </div>
        ),
      }}
    />
  );
}
