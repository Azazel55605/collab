import { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ExportDialog } from './export-dialog';
import { DetailRow, ListDetailDialog, ListDetailRow } from './list-detail-dialog';
import { PickerDialog, PickerRow } from './picker-dialog';
import { ChangeReviewDialog, ReportDialog } from './review-dialog';

type Item = { id: string; name: string };
const items: Item[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
];

describe('ListDetailDialog', () => {
  function Harness({ list = items }: { list?: Item[] }) {
    const [selected, setSelected] = useState<string | null>('a');
    return (
      <ListDetailDialog
        open
        onOpenChange={() => {}}
        title="Rules"
        items={list}
        getKey={(item) => item.id}
        selectedKey={selected}
        onSelect={setSelected}
        renderRow={(item) => <ListDetailRow title={item.name} summary="summary" />}
        renderDetail={(item) => <DetailRow label={`Detail of ${item.name}`} />}
        onNew={() => {}}
        newLabel="New rule"
        empty={{ title: 'No rules yet' }}
      />
    );
  }

  it('shows the selected item and switches on click', () => {
    render(<Harness />);
    expect(screen.getByText('Detail of Alpha')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Beta/ }));
    expect(screen.getByText('Detail of Beta')).toBeTruthy();
  });

  it('shows the empty state when there is nothing', () => {
    render(<Harness list={[]} />);
    expect(screen.getByText('No rules yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /New rule/ })).toBeTruthy();
  });
});

describe('PickerDialog', () => {
  it('moves with the arrow keys and picks with Enter', () => {
    const onPick = vi.fn();
    function Harness() {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <PickerDialog
          open
          onOpenChange={() => {}}
          title="Insert component"
          query=""
          onQueryChange={() => {}}
          groups={[{ items }]}
          getKey={(item) => item.id}
          selectedKey={selected}
          onSelect={setSelected}
          renderItem={(item) => <PickerRow title={item.name} />}
          onPick={onPick}
          pickLabel={(item) => (item ? `Insert ${item.name}` : 'Insert')}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Insert Alpha' })).toBeTruthy();
    const search = screen.getByRole('textbox');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: 'Insert Beta' })).toBeTruthy();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(items[1]);
  });
});

describe('ExportDialog', () => {
  it('chooses a format by card and exports', () => {
    const onExport = vi.fn();
    function Harness() {
      const [format, setFormat] = useState<'pdf' | 'png'>('pdf');
      return (
        <ExportDialog
          open
          onOpenChange={() => {}}
          title="Export"
          formats={[
            { value: 'pdf', label: 'PDF' },
            { value: 'png', label: 'PNG' },
          ]}
          format={format}
          onFormatChange={setFormat}
          exportLabel={`Export ${format.toUpperCase()}`}
          onExport={onExport}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: 'PNG' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export PNG' }));
    expect(onExport).toHaveBeenCalled();
  });
});

describe('ChangeReviewDialog and ReportDialog', () => {
  it('disables the change when it is blocked and says why', () => {
    render(
      <ChangeReviewDialog
        open
        onOpenChange={() => {}}
        title="Move?"
        items={[{ key: 'x', title: 'Roadmap', chip: { label: 'link' } }]}
        blockedReason="A file with that name exists"
        confirmLabel="Move"
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('A file with that name exists');
    expect((screen.getByRole('button', { name: 'Move' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Roadmap')).toBeTruthy();
  });

  it('reports numbers and findings', () => {
    render(
      <ReportDialog
        open
        onOpenChange={() => {}}
        title="Exported"
        stats={[{ key: 's', label: 'Slides', value: 12 }]}
        items={[{ key: 'f', title: 'Font replaced', chip: { label: 'all', tone: 'warning' } }]}
      />,
    );
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('Font replaced')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });
});
