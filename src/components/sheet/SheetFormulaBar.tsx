import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';

import { Input } from '../ui/input';
import { formatA1 } from '../../lib/sheet/address';
import type { SheetPosition } from '../../lib/sheet/address';
import { normalizeRange, selectedCellCount, type SheetSelection } from '../../lib/sheet/selection';

interface Props {
  selection: SheetSelection;
  /** Text of the active cell, or the in-progress edit when one is open. */
  value: string;
  editing: boolean;
  onChange: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  /** Jump to a typed reference from the name box (`B12`). */
  onNavigate: (position: SheetPosition) => void;
  readOnly?: boolean;
}

/**
 * Name box plus formula bar. The name box shows the active cell, or the size of
 * a multi-cell selection the way a spreadsheet does (`3R x 2C`), and doubles as
 * a go-to-cell input.
 */
export function selectionLabel(selection: SheetSelection): string {
  const active = formatA1(selection.active);
  if (selection.ranges.length !== 1) return active;
  const rectangle = normalizeRange(selection.ranges[0]);
  const rowSpan = rectangle.bottom - rectangle.top + 1;
  const columnSpan = rectangle.right - rectangle.left + 1;
  if (rowSpan === 1 && columnSpan === 1) return active;
  return `${rowSpan}R x ${columnSpan}C`;
}

export default function SheetFormulaBar({
  selection,
  value,
  editing,
  onChange,
  onCommit,
  onCancel,
  onNavigate,
  readOnly = false,
}: Props) {
  const [nameDraft, setNameDraft] = useState('');
  const [nameFocused, setNameFocused] = useState(false);

  useEffect(() => {
    if (!nameFocused) setNameDraft(selectionLabel(selection));
  }, [nameFocused, selection]);

  const submitName = () => {
    const reference = nameDraft.trim();
    const match = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(reference);
    if (match) {
      let column = 0;
      for (const character of match[1].toUpperCase()) {
        column = column * 26 + (character.charCodeAt(0) - 64);
      }
      onNavigate({ row: Number.parseInt(match[2], 10) - 1, column: column - 1 });
    }
    setNameFocused(false);
  };

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/50 bg-background/60 px-2 py-1">
      <Input
        aria-label="Name box"
        value={nameDraft}
        onFocus={() => setNameFocused(true)}
        onChange={(event) => setNameDraft(event.target.value)}
        onBlur={submitName}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submitName();
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            setNameDraft(selectionLabel(selection));
            event.currentTarget.blur();
          }
        }}
        className="h-6 w-24 shrink-0 text-center text-[12px]"
      />

      <span className="shrink-0 text-[12px] text-muted-foreground select-none" aria-hidden>
        fx
      </span>

      <Input
        aria-label="Formula bar"
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        className="h-6 flex-1 text-[12.5px]"
      />

      {editing && !readOnly && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Cancel edit"
            onClick={onCancel}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <X size={13} />
          </button>
          <button
            type="button"
            aria-label="Commit edit"
            onClick={onCommit}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <Check size={13} />
          </button>
        </div>
      )}

      <span className="shrink-0 text-[11px] text-muted-foreground select-none">
        {selectedCellCount(selection).toLocaleString()} selected
      </span>
    </div>
  );
}
