import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import type { SheetDocument } from '../../types/sheet';
import type { SheetExportOptions, SheetExportRange } from '../../types/sheetConversion';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

/**
 * CSV export options.
 *
 * CSV cannot hold a workbook, so this dialog exists to make the two lossy
 * choices explicit rather than silent: which single worksheet or range is
 * written, and whether the file is allowed to contain fields a spreadsheet
 * application will execute when it opens them.
 */

export interface SheetCsvExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: SheetDocument | null;
  activeWorksheetId: string | undefined;
  /** The current selection, offered as an alternative to the whole worksheet. */
  selectionRange: SheetExportRange | null;
  selectionLabel: string;
  onExport: (options: SheetExportOptions) => void;
}

const DELIMITERS: { value: string; label: string }[] = [
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\\t', label: 'Tab' },
  { value: '|', label: 'Pipe  |' },
];

export default function SheetCsvExportDialog({
  open,
  onOpenChange,
  document,
  activeWorksheetId,
  selectionRange,
  selectionLabel,
  onExport,
}: SheetCsvExportDialogProps) {
  const [worksheetId, setWorksheetId] = useState<string | undefined>(activeWorksheetId);
  const [scope, setScope] = useState<'worksheet' | 'selection'>('worksheet');
  const [delimiter, setDelimiter] = useState(',');
  const [includeFormulas, setIncludeFormulas] = useState(false);
  const [allowExecutable, setAllowExecutable] = useState(false);

  const worksheets = document?.worksheets ?? [];
  const effectiveWorksheetId = worksheetId ?? activeWorksheetId ?? worksheets[0]?.id;
  const leftOut = Math.max(0, worksheets.length - 1);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Export as CSV</DialogTitle>
          <DialogDescription>
            CSV holds values from one worksheet. Formatting, merged ranges, frozen panes, charts,
            and other worksheets are not written.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="csv-worksheet" className="text-xs font-medium">Worksheet</label>
            <Select value={effectiveWorksheetId} onValueChange={setWorksheetId}>
              <SelectTrigger id="csv-worksheet">
                <SelectValue placeholder="Choose a worksheet" />
              </SelectTrigger>
              <SelectContent>
                {worksheets.map((worksheet) => (
                  <SelectItem key={worksheet.id} value={worksheet.id}>
                    {worksheet.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {leftOut > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="csv-worksheets-left-out">
                {leftOut === 1
                  ? '1 other worksheet will not be written.'
                  : `${leftOut} other worksheets will not be written.`}
              </p>
            )}
          </div>

          {selectionRange && (
            <div className="space-y-1.5">
              <label htmlFor="csv-scope" className="text-xs font-medium">Cells</label>
              <Select
                value={scope}
                onValueChange={(value) => setScope(value as 'worksheet' | 'selection')}
              >
                <SelectTrigger id="csv-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="worksheet">Whole worksheet</SelectItem>
                  <SelectItem value="selection">Selected range ({selectionLabel})</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="csv-delimiter" className="text-xs font-medium">Delimiter</label>
            <Select value={delimiter} onValueChange={setDelimiter}>
              <SelectTrigger id="csv-delimiter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DELIMITERS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="csv-formulas"
              checked={includeFormulas}
              onCheckedChange={(checked) => setIncludeFormulas(checked === true)}
            />
            <div className="space-y-0.5">
              <label htmlFor="csv-formulas" className="text-sm">
                Write formula source instead of values
              </label>
              <p className="text-xs text-muted-foreground">
                Off by default. Most tools reading a CSV expect the calculated value.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="csv-executable"
              checked={allowExecutable}
              onCheckedChange={(checked) => setAllowExecutable(checked === true)}
            />
            <div className="space-y-0.5">
              <label htmlFor="csv-executable" className="text-sm">
                Allow fields a spreadsheet will execute
              </label>
              <p className="text-xs text-muted-foreground">
                By default, a field starting with <code>=</code>, <code>+</code>, <code>-</code>, or{' '}
                <code>@</code> is prefixed so it is shown as text.
              </p>
            </div>
          </div>

          {allowExecutable && (
            <div
              className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs"
              data-testid="csv-injection-warning"
            >
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-destructive" />
              <span>
                Anyone who opens this file in a spreadsheet application will run those fields.
                Only do this when you are sending the file to someone who expects live formulas.
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onExport({
                worksheetId: effectiveWorksheetId,
                range: scope === 'selection' && selectionRange ? selectionRange : undefined,
                delimiter,
                includeFormulas,
                sanitizeFormulas: !allowExecutable,
              });
              onOpenChange(false);
            }}
          >
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
