import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, Trash2 } from 'lucide-react';

import type { SheetValidation, SheetValidationKind, SheetWorksheet } from '../../types/sheet';
import type { SheetValidationDraft } from '../../lib/sheet/validation';
import { parseA1Range } from '../../lib/sheet/address';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { DatePicker } from '../ui/date-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Textarea } from '../ui/textarea';

interface Props {
  open: boolean;
  readOnly?: boolean;
  worksheet: SheetWorksheet;
  selectionLabel: string;
  activeValidation: SheetValidation | null;
  onOpenChange: (open: boolean) => void;
  onApply: (validation: SheetValidationDraft) => void;
  onClear: () => void;
}

function rangeLabel(worksheet: SheetWorksheet, validation: SheetValidation | null): string {
  const range = validation?.sourceRange;
  if (!range) return '';
  const startRow = worksheet.rowOrder.indexOf(range.startRowId);
  const endRow = worksheet.rowOrder.indexOf(range.endRowId);
  const startColumn = worksheet.columnOrder.indexOf(range.startColumnId);
  const endColumn = worksheet.columnOrder.indexOf(range.endColumnId);
  if ([startRow, endRow, startColumn, endColumn].some((index) => index < 0)) return '';
  const columnName = (index: number) => {
    let name = '';
    for (let current = index; current >= 0; current = Math.floor(current / 26) - 1) {
      name = String.fromCharCode(65 + (current % 26)) + name;
    }
    return name;
  };
  return `${columnName(startColumn)}${startRow + 1}:${columnName(endColumn)}${endRow + 1}`;
}

export default function SheetValidationDialog({
  open,
  readOnly,
  worksheet,
  selectionLabel,
  activeValidation,
  onOpenChange,
  onApply,
  onClear,
}: Props) {
  const [kind, setKind] = useState<SheetValidationKind>('list');
  const [options, setOptions] = useState('');
  const [source, setSource] = useState('');
  const [minimum, setMinimum] = useState('');
  const [maximum, setMaximum] = useState('');
  const [formula, setFormula] = useState('');
  const [strict, setStrict] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!open) return;
    setKind(activeValidation?.kind ?? 'list');
    setOptions(activeValidation?.options?.join(', ') ?? '');
    setSource(rangeLabel(worksheet, activeValidation));
    setMinimum(activeValidation?.min?.toString() ?? '');
    setMaximum(activeValidation?.max?.toString() ?? '');
    setFormula(activeValidation?.formula ?? '');
    setStrict(activeValidation?.strict !== false);
    setMessage(activeValidation?.message ?? '');
  }, [activeValidation, open, worksheet]);

  const sourceRange = useMemo(() => {
    const parsed = parseA1Range(source);
    if (!parsed) return null;
    const startRowId = worksheet.rowOrder[parsed.start.row];
    const endRowId = worksheet.rowOrder[parsed.end.row];
    const startColumnId = worksheet.columnOrder[parsed.start.column];
    const endColumnId = worksheet.columnOrder[parsed.end.column];
    return startRowId && endRowId && startColumnId && endColumnId
      ? { startRowId, endRowId, startColumnId, endColumnId }
      : null;
  }, [source, worksheet]);
  const valid = kind !== 'list' || options.split(',').some((option) => option.trim())
    ? kind !== 'range' || Boolean(sourceRange)
      ? kind !== 'custom' || formula.trim().startsWith('=')
      : false
    : false;

  const submit = () => {
    const draft: SheetValidationDraft = {
      kind,
      strict,
      message: message.trim() || undefined,
    };
    if (kind === 'list') {
      draft.options = [...new Set(options.split(',').map((option) => option.trim()).filter(Boolean))];
    }
    if (kind === 'range' && sourceRange) draft.sourceRange = sourceRange;
    if (kind === 'number' || kind === 'text') {
      if (minimum.trim()) draft.min = Number(minimum);
      if (maximum.trim()) draft.max = Number(maximum);
    }
    if (kind === 'date') {
      if (minimum) draft.min = minimum;
      if (maximum) draft.max = maximum;
    }
    if (kind === 'custom') draft.formula = formula.trim();
    onApply(draft);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Data validation</DialogTitle>
          <DialogDescription>Apply an input rule to {selectionLabel}.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-xs font-medium">
            Rule
            <Select value={kind} onValueChange={(value) => setKind(value as SheetValidationKind)}>
              <SelectTrigger className="w-full" aria-label="Validation rule">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="list">List of values</SelectItem>
                <SelectItem value="range">Values from range</SelectItem>
                <SelectItem value="number">Number range</SelectItem>
                <SelectItem value="date">Date range</SelectItem>
                <SelectItem value="text">Text length</SelectItem>
                <SelectItem value="custom">Custom formula</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {kind === 'list' && (
            <label className="grid gap-1 text-xs font-medium">
              Allowed values
              <Textarea value={options} rows={3} placeholder="Open, In progress, Done" onChange={(event) => setOptions(event.target.value)} />
            </label>
          )}
          {kind === 'range' && (
            <label className="grid gap-1 text-xs font-medium">
              Source range
              <Input value={source} placeholder="A1:A10" onChange={(event) => setSource(event.target.value)} />
            </label>
          )}
          {(kind === 'number' || kind === 'text') && (
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-xs font-medium">
                {kind === 'text' ? 'Minimum length' : 'Minimum'}
                <Input type="number" value={minimum} onChange={(event) => setMinimum(event.target.value)} />
              </label>
              <label className="grid gap-1 text-xs font-medium">
                {kind === 'text' ? 'Maximum length' : 'Maximum'}
                <Input type="number" value={maximum} onChange={(event) => setMaximum(event.target.value)} />
              </label>
            </div>
          )}
          {kind === 'date' && (
            <div className="grid grid-cols-2 gap-2">
              <DatePicker label="Earliest" value={minimum} onChange={setMinimum} />
              <DatePicker label="Latest" value={maximum} min={minimum || undefined} onChange={setMaximum} />
            </div>
          )}
          {kind === 'custom' && (
            <label className="grid gap-1 text-xs font-medium">
              Formula
              <Input value={formula} placeholder="=A1&gt;0" onChange={(event) => setFormula(event.target.value)} />
            </label>
          )}
          <label className="flex items-center gap-2 text-xs">
            <Checkbox checked={strict} onCheckedChange={(checked) => setStrict(checked === true)} />
            Reject invalid entries
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Message
            <Input value={message} placeholder="Explain the expected value" onChange={(event) => setMessage(event.target.value)} />
          </label>
        </div>
        <DialogFooter>
          {activeValidation && (
            <Button type="button" variant="destructive" disabled={readOnly} onClick={() => {
              onClear();
              onOpenChange(false);
            }}>
              <Trash2 />
              Clear
            </Button>
          )}
          <Button type="button" disabled={readOnly || !valid} onClick={submit}>
            <BadgeCheck />
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
