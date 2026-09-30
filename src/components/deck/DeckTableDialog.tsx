import { useEffect, useState } from 'react';

import { Loader2 } from 'lucide-react';

import type { SnapshotValue } from '../../lib/deck/sheetSnapshot';
import { DECK_LIMITS } from '../../types/deck';
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          if (!onReturnFocus) return;
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Insert table</DialogTitle>
          <DialogDescription>
            Start from an empty grid, or copy a workbook range as the table&apos;s text.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            Rows
            <Input
              aria-label="Rows"
              className="h-8 w-20"
              inputMode="numeric"
              value={rows}
              onChange={(event) => setRows(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            Columns
            <Input
              aria-label="Columns"
              className="h-8 w-20"
              inputMode="numeric"
              value={columns}
              onChange={(event) => setColumns(event.target.value)}
            />
          </label>
          <Button
            type="button"
            onClick={() =>
              onInsert({
                kind: 'blank',
                rows: count(rows, DECK_LIMITS.tableRows),
                columns: count(columns, DECK_LIMITS.tableColumns),
              })
            }
          >
            Insert
          </Button>
        </div>
        <div className="space-y-2 border-t border-border/50 pt-3">
          <p className="text-xs text-muted-foreground">From a workbook</p>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={path} onValueChange={setPath}>
              <SelectTrigger size="sm" className="w-52" aria-label="Workbook">
                <SelectValue
                  placeholder={workbooks.length ? 'Workbook' : 'No workbooks in this vault'}
                />
              </SelectTrigger>
              <SelectContent>
                {workbooks.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {entry}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="Range"
              className="h-8 w-32"
              value={range}
              onChange={(event) => setRange(event.target.value)}
            />
          </div>
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            disabled={!path || loading}
            onClick={() => void importRange()}
          >
            {loading && <Loader2 className="size-3.5 animate-spin" />}
            Insert from range
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
