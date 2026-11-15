import { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { KanbanAutomationRule } from '../../types/kanban';

import { KanbanAutomationsDialog } from './KanbanAutomationsDialog';

const columns = [
  { id: 'todo', title: 'To do', cardIds: [] },
  { id: 'done', title: 'Done', cardIds: [] },
] as never;

const rule: KanbanAutomationRule = {
  id: 'r1',
  name: 'Close overdue',
  enabled: true,
  trigger: 'onBoardOpen',
  condition: { overdue: true },
  action: { type: 'moveToColumn', columnId: 'done' },
};

function Harness({
  initial,
  onSave = vi.fn(),
}: {
  initial: KanbanAutomationRule[];
  onSave?: () => void;
}) {
  const [rules, setRules] = useState(initial);
  return (
    <KanbanAutomationsDialog
      open
      onOpenChange={() => {}}
      rules={rules}
      columns={columns}
      users={[]}
      onAdd={(next) => setRules((prev) => [...prev, next])}
      onUpdate={(next) =>
        setRules((prev) => prev.map((entry) => (entry.id === next.id ? next : entry)))
      }
      onDelete={(id) => setRules((prev) => prev.filter((entry) => entry.id !== id))}
      presets={[]}
      onApplyPreset={() => {}}
      onSavePreset={onSave}
      vaultPresetsAvailable={false}
      onRunNow={() => {}}
    />
  );
}

describe('KanbanAutomationsDialog', () => {
  it('lists rules with a summary and shows the rule as a sentence', () => {
    render(<Harness initial={[rule]} />);
    expect(screen.getByText('If overdue → move to Done')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Trigger' }).textContent).toContain(
      'the board opens',
    );
    expect(screen.getByRole('combobox', { name: 'Target column' }).textContent).toContain('Done');
  });

  it('pauses a rule from the list and edits the name in place', () => {
    render(<Harness initial={[rule]} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Close overdue active' }));
    expect(screen.getByRole('switch', { name: 'Rule active' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Rule name' }), {
      target: { value: 'Tidy up' },
    });
    expect(screen.getByRole('option', { name: /Tidy up/ })).toBeTruthy();
  });

  it('creates from the empty state and deletes the selected rule', () => {
    render(<Harness initial={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
    expect(screen.getByRole('textbox', { name: 'Rule name' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Delete rule/ }));
    expect(screen.getByText('No automations yet')).toBeTruthy();
  });

  it('saves the rule as an app preset', () => {
    const onSave = vi.fn();
    render(<Harness initial={[rule]} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'App' }));
    expect(onSave).toHaveBeenCalledWith(rule, 'app', 'Close overdue');
  });
});
