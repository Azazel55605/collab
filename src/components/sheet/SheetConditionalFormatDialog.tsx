import { useState } from 'react';
import { PaintBucket, Trash2 } from 'lucide-react';

import type {
  SheetConditionalFormat,
  SheetConditionalFormatKind,
} from '../../types/sheet';
import type { SheetConditionalFormatDraft } from '../../lib/sheet/conditionalFormatting';
import { Button } from '../ui/button';
import { ColorPicker } from '../ui/color-picker';
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

const KIND_LABELS: Record<SheetConditionalFormatKind, string> = {
  comparison: 'Comparison',
  formula: 'Formula',
  colorScale: 'Color scale',
  duplicateValues: 'Duplicate values',
  uniqueValues: 'Unique values',
};

type ComparisonOperator = NonNullable<SheetConditionalFormat['operator']>;

interface Props {
  open: boolean;
  readOnly?: boolean;
  selectionLabel: string;
  rules: SheetConditionalFormat[];
  onOpenChange: (open: boolean) => void;
  onApply: (draft: SheetConditionalFormatDraft) => void;
  onRemove: (formatId: string) => void;
}

function parsedValue(value: string): string | number {
  const numeric = Number(value);
  return value.trim() !== '' && Number.isFinite(numeric) ? numeric : value;
}

export default function SheetConditionalFormatDialog({
  open,
  readOnly,
  selectionLabel,
  rules,
  onOpenChange,
  onApply,
  onRemove,
}: Props) {
  const [kind, setKind] = useState<SheetConditionalFormatKind>('comparison');
  const [operator, setOperator] = useState<ComparisonOperator>('greater');
  const [firstValue, setFirstValue] = useState('');
  const [secondValue, setSecondValue] = useState('');
  const [color, setColor] = useState<string>('#fee2e2');
  const [scaleStart, setScaleStart] = useState<string>('#fee2e2');
  const [scaleEnd, setScaleEnd] = useState<string>('#dcfce7');
  const [formula, setFormula] = useState('');

  const apply = () => {
    const draft: SheetConditionalFormatDraft = { kind };
    if (kind === 'comparison') {
      draft.operator = operator;
      draft.values = operator === 'between'
        ? [parsedValue(firstValue), parsedValue(secondValue)]
        : [parsedValue(firstValue)];
      draft.style = { backgroundColor: color };
    } else if (kind === 'formula') {
      draft.formula = formula.trim();
      draft.style = { backgroundColor: color };
    } else if (kind === 'colorScale') {
      draft.colorScale = [
        { position: 0, color: scaleStart },
        { position: 1, color: scaleEnd },
      ];
    } else {
      draft.style = { backgroundColor: color };
    }
    onApply(draft);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Conditional formatting</DialogTitle>
          <DialogDescription>Format {selectionLabel} when its values match a rule.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Select value={kind} onValueChange={(value) => setKind(value as typeof kind)}>
            <SelectTrigger className="w-full" aria-label="Conditional format type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="comparison">Comparison</SelectItem>
              <SelectItem value="formula">Formula</SelectItem>
              <SelectItem value="colorScale">Color scale</SelectItem>
              <SelectItem value="duplicateValues">Duplicate values</SelectItem>
              <SelectItem value="uniqueValues">Unique values</SelectItem>
            </SelectContent>
          </Select>

          {kind === 'comparison' && (
            <div className="grid grid-cols-[1.2fr_1fr_1fr] gap-2">
              <Select value={operator} onValueChange={(value) => setOperator(value as ComparisonOperator)}>
                <SelectTrigger aria-label="Comparison operator"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="equal">Equal to</SelectItem>
                  <SelectItem value="notEqual">Not equal to</SelectItem>
                  <SelectItem value="greater">Greater than</SelectItem>
                  <SelectItem value="greaterOrEqual">At least</SelectItem>
                  <SelectItem value="less">Less than</SelectItem>
                  <SelectItem value="lessOrEqual">At most</SelectItem>
                  <SelectItem value="between">Between</SelectItem>
                  <SelectItem value="contains">Text contains</SelectItem>
                </SelectContent>
              </Select>
              <Input aria-label="Comparison value" value={firstValue} onChange={(event) => setFirstValue(event.target.value)} />
              {operator === 'between' && (
                <Input aria-label="Second comparison value" value={secondValue} onChange={(event) => setSecondValue(event.target.value)} />
              )}
            </div>
          )}
          {kind === 'formula' && (
            <Input
              aria-label="Conditional formula"
              value={formula}
              placeholder="=A1&gt;0"
              onChange={(event) => setFormula(event.target.value)}
            />
          )}

          {kind === 'colorScale' ? (
            <div className="grid grid-cols-2 gap-3">
              <ColorPicker label="Low values" value={scaleStart} onValueChange={setScaleStart} className="w-full" />
              <ColorPicker label="High values" value={scaleEnd} onValueChange={setScaleEnd} className="w-full" />
            </div>
          ) : (
            <ColorPicker label="Cell fill" value={color} onValueChange={setColor} className="w-full" />
          )}

          {rules.length > 0 && (
            <div className="max-h-40 space-y-1 overflow-y-auto border-t border-border/60 pt-3">
              <div className="mb-1 text-xs font-medium">Worksheet rules</div>
              {rules.map((rule) => (
                <div key={rule.id} className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs">
                  <span className="flex-1">{KIND_LABELS[rule.kind]} · {rule.ranges.length} range{rule.ranges.length === 1 ? '' : 's'}</span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    disabled={readOnly}
                    aria-label={`Remove ${KIND_LABELS[rule.kind]} rule`}
                    onClick={() => onRemove(rule.id)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            disabled={readOnly
              || (kind === 'comparison' && !firstValue.trim())
              || (kind === 'formula' && !formula.trim().startsWith('='))}
            onClick={apply}
          >
            <PaintBucket />
            Add rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
