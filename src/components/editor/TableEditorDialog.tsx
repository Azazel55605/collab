import { useEffect, useState } from 'react';
import { Grid2x2Plus, Minus, Plus, Table } from 'lucide-react';
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
import type { MarkdownTableAlignment, MarkdownTableModel } from './tableMarkdown';

interface TableEditorDialogProps {
  open: boolean;
  initialValue: MarkdownTableModel;
  mode: 'insert' | 'edit';
  onOpenChange: (open: boolean) => void;
  onApply: (value: MarkdownTableModel) => void;
}

function cloneModel(model: MarkdownTableModel): MarkdownTableModel {
  return {
    headers: [...model.headers],
    aligns: [...model.aligns],
    rows: model.rows.map((row) => [...row]),
  };
}

function TableCellInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 min-w-[120px] border-border/40 bg-background/60 text-xs"
    />
  );
}

export function TableEditorDialog({
  open,
  initialValue,
  mode,
  onOpenChange,
  onApply,
}: TableEditorDialogProps) {
  const [draft, setDraft] = useState<MarkdownTableModel>(cloneModel(initialValue));

  useEffect(() => {
    if (open) {
      setDraft(cloneModel(initialValue));
    }
  }, [initialValue, open]);

  const colCount = draft.headers.length;

  const setAlignment = (index: number, align: MarkdownTableAlignment) => {
    setDraft((prev) => ({
      ...prev,
      aligns: prev.aligns.map((value, currentIndex) => (currentIndex === index ? align : value)),
    }));
  };

  const updateHeader = (index: number, value: string) => {
    setDraft((prev) => ({
      ...prev,
      headers: prev.headers.map((cell, currentIndex) => (currentIndex === index ? value : cell)),
    }));
  };

  const updateCell = (rowIndex: number, colIndex: number, value: string) => {
    setDraft((prev) => ({
      ...prev,
      rows: prev.rows.map((row, currentRowIndex) => (
        currentRowIndex !== rowIndex
          ? row
          : row.map((cell, currentColIndex) => (currentColIndex === colIndex ? value : cell))
      )),
    }));
  };

  const addRow = () => {
    setDraft((prev) => ({
      ...prev,
      rows: [...prev.rows, Array.from({ length: prev.headers.length }, () => '')],
    }));
  };

  const removeRow = () => {
    setDraft((prev) => ({
      ...prev,
      rows: prev.rows.length > 1 ? prev.rows.slice(0, -1) : prev.rows,
    }));
  };

  const addColumn = () => {
    setDraft((prev) => ({
      headers: [...prev.headers, `Col ${prev.headers.length + 1}`],
      aligns: [...prev.aligns, 'left'],
      rows: prev.rows.map((row) => [...row, '']),
    }));
  };

  const removeColumn = () => {
    setDraft((prev) => ({
      headers: prev.headers.length > 1 ? prev.headers.slice(0, -1) : prev.headers,
      aligns: prev.aligns.length > 1 ? prev.aligns.slice(0, -1) : prev.aligns,
      rows: prev.rows.map((row) => (row.length > 1 ? row.slice(0, -1) : row)),
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="border-b border-border/40 px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Table size={16} />
            {mode === 'edit' ? 'Edit table' : 'Insert table'}
          </DialogTitle>
          <DialogDescription>
            Edit headers, cell values, size, and column alignment, then insert markdown into the note.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 border-b border-border/30 px-5 py-3">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={addColumn}>
            <Plus size={13} />
            Column
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={removeColumn} disabled={colCount <= 1}>
            <Minus size={13} />
            Column
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={addRow}>
            <Grid2x2Plus size={13} />
            Row
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={removeRow} disabled={draft.rows.length <= 1}>
            <Minus size={13} />
            Row
          </Button>
          <div className="ml-auto text-xs text-muted-foreground">
            {draft.headers.length} columns, {draft.rows.length} rows
          </div>
        </div>

        <div className="max-h-[65vh] overflow-auto px-5 py-4">
          <div className="inline-grid gap-2" style={{ gridTemplateColumns: `repeat(${colCount}, minmax(140px, 1fr))` }}>
            {draft.headers.map((header, colIndex) => (
              <div key={`header-${colIndex}`} className="space-y-2 rounded-xl border border-border/40 bg-card/35 p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Header {colIndex + 1}
                </div>
                <TableCellInput value={header} onChange={(value) => updateHeader(colIndex, value)} />
                <div className="flex gap-1">
                  {([
                    ['left', 'L'],
                    ['center', 'C'],
                    ['right', 'R'],
                  ] as const).map(([align, label]) => (
                    <Button
                      key={align}
                      size="sm"
                      variant={draft.aligns[colIndex] === align ? 'default' : 'outline'}
                      className="h-7 min-w-0 flex-1 px-0 text-[11px]"
                      onClick={() => setAlignment(colIndex, align)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
            ))}

            {draft.rows.flatMap((row, rowIndex) => (
              row.map((value, colIndex) => (
                <div key={`cell-${rowIndex}-${colIndex}`} className="space-y-1 rounded-xl border border-border/30 bg-background/35 p-3">
                  <div className="text-[11px] text-muted-foreground">
                    Row {rowIndex + 1}, Col {colIndex + 1}
                  </div>
                  <TableCellInput value={value} onChange={(nextValue) => updateCell(rowIndex, colIndex, nextValue)} />
                </div>
              ))
            ))}
          </div>
        </div>

        <DialogFooter className="-mx-0 -mb-0 border-none bg-transparent px-5 pb-5 pt-3 gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onApply(draft)}>
            {mode === 'edit' ? 'Update table' : 'Insert table'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
