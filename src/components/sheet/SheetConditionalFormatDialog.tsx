import { useState } from 'react';

import { Paintbrush, PaintBucket, Trash2 } from 'lucide-react';

import type { SheetConditionalFormatDraft } from '../../lib/sheet/conditionalFormatting';
import type { SheetConditionalFormat, SheetConditionalFormatKind } from '../../types/sheet';
import { Button } from '../ui/button';
import { ColorPicker } from '../ui/color-picker';
import { FormDialog, FormField, FormRow, FormSection } from '../ui/form-dialog';
import { Input } from '../ui/input';
import { ReviewList } from '../ui/review-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

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

  const incomplete =
    (kind === 'comparison' && !firstValue.trim()) ||
    (kind === 'formula' && !formula.trim().startsWith('='));

  const apply = () => {
    const draft: SheetConditionalFormatDraft = { kind };
    if (kind === 'comparison') {
      draft.operator = operator;
      draft.values =
        operator === 'between'
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
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<Paintbrush />}
      title="Conditional formatting"
      description={<>Format {selectionLabel} when its values match a rule.</>}
      submitLabel={
        <>
          <PaintBucket />
          Add rule
        </>
      }
      submitDisabled={readOnly || incomplete}
      onSubmit={apply}
    >
      <FormField label="Format cells when">
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
      </FormField>

      {kind === 'comparison' && (
        <FormField label="Value is">
          <div className="grid grid-cols-[1.2fr_1fr_1fr] gap-2">
            <Select
              value={operator}
              onValueChange={(value) => setOperator(value as ComparisonOperator)}
            >
              <SelectTrigger className="w-full" aria-label="Comparison operator">
                <SelectValue />
              </SelectTrigger>
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
            <Input
              aria-label="Comparison value"
              value={firstValue}
              onChange={(event) => setFirstValue(event.target.value)}
            />
            {operator === 'between' && (
              <Input
                aria-label="Second comparison value"
                value={secondValue}
                onChange={(event) => setSecondValue(event.target.value)}
              />
            )}
          </div>
        </FormField>
      )}
      {kind === 'formula' && (
        <FormField
          label="Formula"
          htmlFor="conditional-formula"
          hint="True for the cells to format."
        >
          <Input
            id="conditional-formula"
            aria-label="Conditional formula"
            value={formula}
            placeholder="=A1&gt;0"
            onChange={(event) => setFormula(event.target.value)}
          />
        </FormField>
      )}

      {kind === 'colorScale' ? (
        <FormRow>
          <FormField label="Low values">
            <ColorPicker
              label="Low values"
              value={scaleStart}
              onValueChange={setScaleStart}
              className="w-full"
            />
          </FormField>
          <FormField label="High values">
            <ColorPicker
              label="High values"
              value={scaleEnd}
              onValueChange={setScaleEnd}
              className="w-full"
            />
          </FormField>
        </FormRow>
      ) : (
        <FormField label="Cell fill">
          <ColorPicker
            label="Cell fill"
            value={color}
            onValueChange={setColor}
            className="w-full"
          />
        </FormField>
      )}

      {rules.length > 0 && (
        <FormSection title="Rules on this worksheet" className="border-t border-border/50 pt-4">
          <ReviewList
            label="Worksheet rules"
            className="max-h-40"
            items={rules.map((rule) => ({
              key: rule.id,
              title: KIND_LABELS[rule.kind],
              detail: `${rule.ranges.length} range${rule.ranges.length === 1 ? '' : 's'}`,
              action: (
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
              ),
            }))}
          />
        </FormSection>
      )}
    </FormDialog>
  );
}
