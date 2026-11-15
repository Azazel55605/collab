import { useEffect, useState } from 'react';

import { Table2 } from 'lucide-react';

import type { SnapshotValue } from '../../lib/deck/sheetSnapshot';
import { DECK_LIMITS } from '../../types/deck';
import { ChoiceCard, ChoiceGroup } from '../ui/app-dialog';
import { FormDialog, FormField, FormRow } from '../ui/form-dialog';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

export type TableInsert =
  | { kind: 'blank'; rows: number; columns: number }
  | { kind: 'range'; grid: SnapshotValue[][]; source: string };

interface DeckTableDialogProps {
  /** Where focus goes when the dialog closes (the slide, rather than the menu that opened it). */
  onReturnFocus?: () => void;
  open: boolean;
  workbooks: string[];
  onOpenChange: (open: boolean) => void;
  onInsert: (insert: TableInsert) => void;
  onLoadRange: (path: string, range: string) => Promise<SnapshotValue[][]>;
}

/** Inserts a blank table, or a copy of a workbook range as table text. */
export function DeckTableDialog({
  onReturnFocus,
  open,
  workbooks,
  onOpenChange,
  onInsert,
  onLoadRange,
}: DeckTableDialogProps) {
  const [rows, setRows] = useState('3');
  const [columns, setColumns] = useState('3');
  const [path, setPath] = useState<string | undefined>(undefined);
  const [range, setRange] = useState('A1:D5');
  const [source, setSource] = useState<'blank' | 'range'>('blank');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setPath(workbooks[0]);
      setError(null);
    }
  }, [open, workbooks]);

  const count = (value: string, max: number) =>
    Math.max(1, Math.min(max, Math.floor(Number(value) || 1)));

  const importRange = async () => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const grid = await onLoadRange(path, range);
      if (grid.length === 0) throw new Error('That range is empty.');
      onInsert({ kind: 'range', grid, source: `${path} · ${range}` });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="s"
      onCloseAutoFocus={(event) => {
        if (!onReturnFocus) return;
        event.preventDefault();
        onReturnFocus();
      }}
      icon={<Table2 />}
      title="Insert table"
      description="Start from an empty grid, or copy a workbook range as the table's text."
      submitLabel={source === 'blank' ? 'Insert' : 'Insert from range'}
      submitDisabled={source === 'range' && !path}
      busy={loading}
      error={source === 'range' ? error : undefined}
      onSubmit={() => {
        if (source === 'range') return importRange();
        onInsert({
          kind: 'blank',
          rows: count(rows, DECK_LIMITS.tableRows),
          columns: count(columns, DECK_LIMITS.tableColumns),
        });
      }}
    >
      <ChoiceGroup
        value={source}
        onValueChange={(value) => setSource(value as 'blank' | 'range')}
        aria-label="Start from"
        className="grid grid-cols-2 gap-2"
      >
        <ChoiceCard value="blank" title="Empty grid" />
        <ChoiceCard
          value="range"
          title="Workbook range"
          disabled={workbooks.length === 0}
          description={workbooks.length === 0 ? 'No workbooks in this vault' : undefined}
        />
      </ChoiceGroup>
      {source === 'blank' ? (
        <FormRow>
          <FormField label="Rows" htmlFor="deck-table-rows">
            <Input
              id="deck-table-rows"
              inputMode="numeric"
              value={rows}
              onChange={(event) => setRows(event.target.value)}
            />
          </FormField>
          <FormField label="Columns" htmlFor="deck-table-columns">
            <Input
              id="deck-table-columns"
              inputMode="numeric"
              value={columns}
              onChange={(event) => setColumns(event.target.value)}
            />
          </FormField>
        </FormRow>
      ) : (
        <FormRow>
          <FormField label="Workbook">
            <Select value={path} onValueChange={setPath}>
              <SelectTrigger className="w-full" aria-label="Workbook">
                <SelectValue placeholder="Workbook" />
              </SelectTrigger>
              <SelectContent>
                {workbooks.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {entry}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Range" htmlFor="deck-table-range">
            <Input
              id="deck-table-range"
              value={range}
              onChange={(event) => setRange(event.target.value)}
            />
          </FormField>
        </FormRow>
      )}
    </FormDialog>
  );
}
