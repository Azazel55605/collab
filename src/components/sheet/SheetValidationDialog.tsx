import { useEffect, useMemo, useState } from 'react';

import { BadgeCheck, ListChecks, Trash2 } from 'lucide-react';

import { parseA1Range } from '../../lib/sheet/address';
import type { SheetValidationDraft } from '../../lib/sheet/validation';
import type { SheetValidation, SheetValidationKind, SheetWorksheet } from '../../types/sheet';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { DatePicker } from '../ui/date-picker';
import { FormDialog, FormField } from '../ui/form-dialog';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
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
  const valid =
    kind !== 'list' || options.split(',').some((option) => option.trim())
      ? kind !== 'range' || Boolean(sourceRange)
        ? kind !== 'custom' || formula.trim().startsWith('=')
        : false
      : false;

  const submit = () => {
    if (readOnly || !valid) return;
    const draft: SheetValidationDraft = {
      kind,
      strict,
      message: message.trim() || undefined,
    };
    if (kind === 'list') {
      draft.options = [
        ...new Set(
          options
            .split(',')
            .map((option) => option.trim())
            .filter(Boolean),
        ),
      ];
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
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<ListChecks />}
      title="Data validation"
      description={<>Apply an input rule to {selectionLabel}.</>}
      submitLabel={
        <>
          <BadgeCheck />
          Apply
        </>
      }
      submitDisabled={readOnly || !valid}
      onSubmit={submit}
      secondary={
        activeValidation ? (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={readOnly}
            onClick={() => {
              onClear();
              onOpenChange(false);
            }}
          >
            <Trash2 />
            Clear
          </Button>
        ) : undefined
      }
    >
      <>
        <FormField label="Rule">
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
        </FormField>
        {kind === 'list' && (
          <FormField label="Allowed values" htmlFor="validation-allowed-values">
            <Textarea
              id="validation-allowed-values"
              value={options}
              rows={3}
              placeholder="Open, In progress, Done"
              onChange={(event) => setOptions(event.target.value)}
            />
          </FormField>
        )}
        {kind === 'range' && (
          <FormField label="Source range" htmlFor="validation-source-range">
            <Input
              id="validation-source-range"
              value={source}
              placeholder="A1:A10"
              onChange={(event) => setSource(event.target.value)}
            />
          </FormField>
        )}
        {(kind === 'number' || kind === 'text') && (
          <div className="grid grid-cols-2 gap-2">
            <FormField
              label={kind === 'text' ? 'Minimum length' : 'Minimum'}
              htmlFor="validation-f4"
            >
              <Input
                id="validation-f4"
                type="number"
                value={minimum}
                onChange={(event) => setMinimum(event.target.value)}
              />
            </FormField>
            <FormField
              label={kind === 'text' ? 'Maximum length' : 'Maximum'}
              htmlFor="validation-f5"
            >
              <Input
                id="validation-f5"
                type="number"
                value={maximum}
                onChange={(event) => setMaximum(event.target.value)}
              />
            </FormField>
          </div>
        )}
        {kind === 'date' && (
          <div className="grid grid-cols-2 gap-2">
            <DatePicker label="Earliest" value={minimum} onChange={setMinimum} />
            <DatePicker
              label="Latest"
              value={maximum}
              min={minimum || undefined}
              onChange={setMaximum}
            />
          </div>
        )}
        {kind === 'custom' && (
          <FormField label="Formula" htmlFor="validation-formula">
            <Input
              id="validation-formula"
              value={formula}
              placeholder="=A1&gt;0"
              onChange={(event) => setFormula(event.target.value)}
            />
          </FormField>
        )}
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox checked={strict} onCheckedChange={(checked) => setStrict(checked === true)} />
          Reject invalid entries
        </label>
        <FormField label="Message" htmlFor="validation-message">
          <Input
            id="validation-message"
            value={message}
            placeholder="Explain the expected value"
            onChange={(event) => setMessage(event.target.value)}
          />
        </FormField>
      </>
    </FormDialog>
  );
}
