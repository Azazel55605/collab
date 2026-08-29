import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';

import { Grid2x2Plus, GripVertical, Minus, Plus, Table, Trash2 } from 'lucide-react';

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

type DragKind = 'row' | 'column';
type DragState = { kind: DragKind; index: number; motionId: string } | null;
type DropTarget = { kind: DragKind; index: number } | null;

function cloneModel(model: MarkdownTableModel): MarkdownTableModel {
  return {
    headers: [...model.headers],
    aligns: [...model.aligns],
    rows: model.rows.map((row) => [...row]),
  };
}

function moveArrayItem<T>(values: T[], fromIndex: number, toIndex: number) {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= values.length ||
    toIndex >= values.length
  ) {
    return [...values];
  }

  const next = [...values];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function moveTableRow(
  model: MarkdownTableModel,
  fromIndex: number,
  toIndex: number,
): MarkdownTableModel {
  return {
    ...model,
    rows: moveArrayItem(model.rows, fromIndex, toIndex),
  };
}

export function moveTableColumn(
  model: MarkdownTableModel,
  fromIndex: number,
  toIndex: number,
): MarkdownTableModel {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= model.headers.length ||
    toIndex >= model.headers.length
  ) {
    return cloneModel(model);
  }

  return {
    headers: moveArrayItem(model.headers, fromIndex, toIndex),
    aligns: moveArrayItem(model.aligns, fromIndex, toIndex),
    rows: model.rows.map((row) => moveArrayItem(row, fromIndex, toIndex)),
  };
}

function TableCellInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 min-w-[120px] border-border/40 bg-background/60 text-xs"
    />
  );
}

function createDragHandlers(
  kind: DragKind,
  index: number,
  motionId: string,
  setDragState: (state: DragState) => void,
  dragPreviewRef: { current: HTMLElement | null },
) {
  return {
    onDragStart(event: DragEvent<HTMLElement>) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `${kind}:${index}`);
      const source = event.currentTarget.closest(
        '[data-table-drag-surface="true"]',
      ) as HTMLElement | null;
      if (source) {
        const clone = source.cloneNode(true) as HTMLElement;
        clone.style.position = 'fixed';
        clone.style.top = '-9999px';
        clone.style.left = '-9999px';
        clone.style.width = `${source.offsetWidth}px`;
        clone.style.maxWidth = `${Math.max(120, Math.round(source.offsetWidth * 0.72))}px`;
        clone.style.pointerEvents = 'none';
        clone.style.zIndex = '9999';
        clone.style.opacity = '0.94';
        clone.style.transform = 'scale(0.92)';
        clone.style.transformOrigin = 'top left';
        clone.style.borderColor = 'color-mix(in oklch, var(--border) 82%, var(--primary) 18%)';
        clone.style.boxShadow = '0 14px 30px color-mix(in oklch, black 14%, transparent)';
        clone.style.background = 'color-mix(in oklch, var(--card) 96%, white 4%)';
        clone.style.filter = 'saturate(0.98)';
        document.body.appendChild(clone);
        dragPreviewRef.current = clone;
        if (typeof event.dataTransfer.setDragImage === 'function') {
          event.dataTransfer.setDragImage(clone, Math.min(20, source.offsetWidth / 3), 18);
        }
      }
      setDragState({ kind, index, motionId });
    },
    onDragEnd() {
      dragPreviewRef.current?.remove();
      dragPreviewRef.current = null;
      setDragState(null);
    },
  };
}

export function TableEditorDialog({
  open,
  initialValue,
  mode,
  onOpenChange,
  onApply,
}: TableEditorDialogProps) {
  const [draft, setDraft] = useState<MarkdownTableModel>(cloneModel(initialValue));
  const [dragState, setDragState] = useState<DragState>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const rowIdSeedRef = useRef(0);
  const columnIdSeedRef = useRef(0);
  const [rowMotionIds, setRowMotionIds] = useState<string[]>([]);
  const [columnMotionIds, setColumnMotionIds] = useState<string[]>([]);
  const dragPreviewRef = useRef<HTMLElement | null>(null);

  const buildRowMotionIds = (count: number) =>
    Array.from({ length: count }, () => `table-row-${rowIdSeedRef.current++}`);
  const buildColumnMotionIds = (count: number) =>
    Array.from({ length: count }, () => `table-column-${columnIdSeedRef.current++}`);

  const runAnimatedUpdate = (update: () => void) => {
    update();
  };

  useEffect(() => {
    if (open) {
      setDraft(cloneModel(initialValue));
      setDragState(null);
      setDropTarget(null);
      dragPreviewRef.current?.remove();
      dragPreviewRef.current = null;
      setRowMotionIds(buildRowMotionIds(initialValue.rows.length));
      setColumnMotionIds(buildColumnMotionIds(initialValue.headers.length));
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
      rows: prev.rows.map((row, currentRowIndex) =>
        currentRowIndex !== rowIndex
          ? row
          : row.map((cell, currentColIndex) => (currentColIndex === colIndex ? value : cell)),
      ),
    }));
  };

  const addRow = () => {
    runAnimatedUpdate(() => {
      setDraft((prev) => ({
        ...prev,
        rows: [...prev.rows, Array.from({ length: prev.headers.length }, () => '')],
      }));
      setRowMotionIds((prev) => [...prev, `table-row-${rowIdSeedRef.current++}`]);
    });
  };

  const removeRow = () => {
    runAnimatedUpdate(() => {
      setDraft((prev) => ({
        ...prev,
        rows: prev.rows.length > 1 ? prev.rows.slice(0, -1) : prev.rows,
      }));
      setRowMotionIds((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
    });
  };

  const removeRowAt = (rowIndex: number) => {
    runAnimatedUpdate(() => {
      setDraft((prev) => ({
        ...prev,
        rows:
          prev.rows.length > 1
            ? prev.rows.filter((_, currentIndex) => currentIndex !== rowIndex)
            : prev.rows,
      }));
      setRowMotionIds((prev) =>
        prev.length > 1 ? prev.filter((_, currentIndex) => currentIndex !== rowIndex) : prev,
      );
    });
  };

  const addColumn = () => {
    runAnimatedUpdate(() => {
      setDraft((prev) => ({
        headers: [...prev.headers, `Col ${prev.headers.length + 1}`],
        aligns: [...prev.aligns, 'left'],
        rows: prev.rows.map((row) => [...row, '']),
      }));
      setColumnMotionIds((prev) => [...prev, `table-column-${columnIdSeedRef.current++}`]);
    });
  };

  const removeColumn = () => {
    runAnimatedUpdate(() => {
      setDraft((prev) => ({
        headers: prev.headers.length > 1 ? prev.headers.slice(0, -1) : prev.headers,
        aligns: prev.aligns.length > 1 ? prev.aligns.slice(0, -1) : prev.aligns,
        rows: prev.rows.map((row) => (row.length > 1 ? row.slice(0, -1) : row)),
      }));
      setColumnMotionIds((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
    });
  };

  const removeColumnAt = (colIndex: number) => {
    runAnimatedUpdate(() => {
      setDraft((prev) => ({
        headers:
          prev.headers.length > 1
            ? prev.headers.filter((_, currentIndex) => currentIndex !== colIndex)
            : prev.headers,
        aligns:
          prev.aligns.length > 1
            ? prev.aligns.filter((_, currentIndex) => currentIndex !== colIndex)
            : prev.aligns,
        rows: prev.rows.map((row) =>
          row.length > 1 ? row.filter((_, currentIndex) => currentIndex !== colIndex) : row,
        ),
      }));
      setColumnMotionIds((prev) =>
        prev.length > 1 ? prev.filter((_, currentIndex) => currentIndex !== colIndex) : prev,
      );
    });
  };

  const allowDrop = (kind: DragKind, index: number) => (event: DragEvent<HTMLElement>) => {
    if (!dragState || dragState.kind !== kind) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dropTarget?.kind !== kind || dropTarget.index !== index) {
      setDropTarget({ kind, index });
    }
    if (dragState.index === index) return;
    runAnimatedUpdate(() => {
      setDraft((prev) =>
        kind === 'column'
          ? moveTableColumn(prev, dragState.index, index)
          : moveTableRow(prev, dragState.index, index),
      );
      if (kind === 'column') {
        setColumnMotionIds((prev) => moveArrayItem(prev, dragState.index, index));
      } else {
        setRowMotionIds((prev) => moveArrayItem(prev, dragState.index, index));
      }
      setDragState((prev) => (prev && prev.kind === kind ? { ...prev, index } : prev));
    });
  };

  const clearDropTarget = (kind: DragKind, index: number) => () => {
    if (dropTarget?.kind === kind && dropTarget.index === index) {
      setDropTarget(null);
    }
  };

  const applyDrop = (kind: DragKind) => (event: DragEvent<HTMLElement>) => {
    if (!dragState || dragState.kind !== kind) return;
    event.preventDefault();
    dragPreviewRef.current?.remove();
    dragPreviewRef.current = null;
    setDragState(null);
    setDropTarget(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-6xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="border-b border-border/40 px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Table size={16} />
            {mode === 'edit' ? 'Edit table' : 'Insert table'}
          </DialogTitle>
          <DialogDescription>
            Edit headers, cell values, size, and column alignment, then insert markdown into the
            note.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 border-b border-border/30 px-5 py-3">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={addColumn}>
            <Plus size={13} />
            Column
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={removeColumn}
            disabled={colCount <= 1}
          >
            <Minus size={13} />
            Column
          </Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={addRow}>
            <Grid2x2Plus size={13} />
            Row
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={removeRow}
            disabled={draft.rows.length <= 1}
          >
            <Minus size={13} />
            Row
          </Button>
          <div className="ml-auto text-right text-xs text-muted-foreground">
            <div>
              {draft.headers.length} columns, {draft.rows.length} rows
            </div>
            <div>Drag headers or row labels to reorder.</div>
          </div>
        </div>

        <div className="max-h-[65vh] overflow-auto px-5 py-4">
          <div
            className="inline-grid gap-2"
            style={{ gridTemplateColumns: `88px repeat(${colCount}, minmax(140px, 1fr))` }}
          >
            <div className="rounded-xl border border-dashed border-border/40 bg-muted/25 p-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Rows
            </div>

            {draft.headers.map((header, colIndex) => {
              const isDropTarget = dropTarget?.kind === 'column' && dropTarget.index === colIndex;
              const isDragging = dragState?.kind === 'column' && dragState.index === colIndex;
              return (
                <div
                  key={`header-${colIndex}`}
                  className={[
                    'space-y-2 rounded-xl border bg-card/35 p-3 transition-[transform,opacity,box-shadow,border-color,background-color] duration-150',
                    isDropTarget
                      ? 'border-primary/60 bg-primary/8 shadow-lg shadow-primary/10'
                      : 'border-border/40',
                    isDragging ? 'scale-[0.992] opacity-55 shadow-none ring-2 ring-primary/15' : '',
                  ].join(' ')}
                  style={{
                    gridColumn: colIndex + 2,
                    gridRow: 1,
                    viewTransitionName: columnMotionIds[colIndex],
                  }}
                  data-table-drag-surface="true"
                  onDragOver={allowDrop('column', colIndex)}
                  onDragLeave={clearDropTarget('column', colIndex)}
                  onDrop={applyDrop('column')}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Header {colIndex + 1}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        draggable
                        aria-label={`Drag column ${colIndex + 1}`}
                        className={[
                          'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/40 bg-background/70 text-muted-foreground transition-all hover:text-foreground',
                          isDragging ? 'cursor-grabbing bg-primary/10 text-primary' : 'cursor-grab',
                        ].join(' ')}
                        {...createDragHandlers(
                          'column',
                          colIndex,
                          columnMotionIds[colIndex] ?? `table-column-fallback-${colIndex}`,
                          setDragState,
                          dragPreviewRef,
                        )}
                      >
                        <GripVertical size={13} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete column ${colIndex + 1}`}
                        disabled={draft.headers.length <= 1}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/40 bg-background/70 text-muted-foreground transition-colors hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => removeColumnAt(colIndex)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  <TableCellInput
                    value={header}
                    onChange={(value) => updateHeader(colIndex, value)}
                  />
                  <div className="flex gap-1">
                    {(
                      [
                        ['left', 'L'],
                        ['center', 'C'],
                        ['right', 'R'],
                      ] as const
                    ).map(([align, label]) => (
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
              );
            })}

            {draft.rows.map((_, rowIndex) => {
              const isRowDropTarget = dropTarget?.kind === 'row' && dropTarget.index === rowIndex;
              const isRowDragging = dragState?.kind === 'row' && dragState.index === rowIndex;

              return (
                <div
                  key={`row-handle-${rowIndex}`}
                  className={[
                    'flex min-h-[90px] flex-col items-start justify-between rounded-xl border p-3 text-left transition-[transform,opacity,box-shadow,border-color,background-color] duration-150',
                    isRowDropTarget
                      ? 'border-primary/60 bg-primary/8 shadow-lg shadow-primary/10'
                      : 'border-border/40 bg-muted/20',
                    isRowDragging
                      ? 'scale-[0.992] opacity-55 shadow-none ring-2 ring-primary/15'
                      : '',
                  ].join(' ')}
                  style={{
                    gridColumn: 1,
                    gridRow: rowIndex + 2,
                    viewTransitionName: rowMotionIds[rowIndex],
                  }}
                  data-table-drag-surface="true"
                  onDragOver={allowDrop('row', rowIndex)}
                  onDragLeave={clearDropTarget('row', rowIndex)}
                  onDrop={applyDrop('row')}
                >
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Row {rowIndex + 1}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      draggable
                      aria-label={`Drag row ${rowIndex + 1}`}
                      className={[
                        'inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/40 bg-background/70 text-muted-foreground transition-all hover:text-foreground',
                        isRowDragging
                          ? 'cursor-grabbing bg-primary/10 text-primary'
                          : 'cursor-grab',
                      ].join(' ')}
                      {...createDragHandlers(
                        'row',
                        rowIndex,
                        rowMotionIds[rowIndex] ?? `table-row-fallback-${rowIndex}`,
                        setDragState,
                        dragPreviewRef,
                      )}
                    >
                      <GripVertical size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete row ${rowIndex + 1}`}
                      disabled={draft.rows.length <= 1}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border/40 bg-background/70 text-muted-foreground transition-colors hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => removeRowAt(rowIndex)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}

            {draft.rows.reduce<React.ReactNode[]>((cells, row, rowIndex) => {
              row.forEach((value, colIndex) => {
                cells.push(
                  <div
                    key={`cell-${rowIndex}-${colIndex}`}
                    className="space-y-1 rounded-xl border border-border/30 bg-background/35 p-3"
                    style={{
                      gridColumn: colIndex + 2,
                      gridRow: rowIndex + 2,
                      viewTransitionName: `${rowMotionIds[rowIndex]}-${columnMotionIds[colIndex]}`,
                    }}
                  >
                    <div className="text-[11px] text-muted-foreground">
                      Row {rowIndex + 1}, Col {colIndex + 1}
                    </div>
                    <TableCellInput
                      value={value}
                      onChange={(nextValue) => updateCell(rowIndex, colIndex, nextValue)}
                    />
                  </div>,
                );
              });
              return cells;
            }, [])}
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
