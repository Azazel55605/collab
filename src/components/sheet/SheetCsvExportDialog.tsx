import { useState } from 'react';

import { AlertTriangle, FileSpreadsheet } from 'lucide-react';

import type { SheetDocument } from '../../types/sheet';
import type { SheetExportOptions, SheetExportRange } from '../../types/sheetConversion';
import { Checkbox } from '../ui/checkbox';
import { ExportDialog } from '../ui/export-dialog';
import { DetailRow } from '../ui/list-detail-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

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

  const sheetName = worksheets.find((worksheet) => worksheet.id === effectiveWorksheetId)?.name;
  const select = (
    id: string,
    value: string | undefined,
    onChange: (value: string) => void,
    items: { value: string; label: string }[],
  ) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        id={id}
        size="sm"
        className="w-48"
        aria-label={
          { 'csv-worksheet': 'Worksheet', 'csv-scope': 'Cells', 'csv-delimiter': 'Delimiter' }[id]
        }
      >
        <SelectValue placeholder="Choose…" />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  return (
    <ExportDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<FileSpreadsheet />}
      title="Export as CSV"
      description="CSV holds the values of one worksheet. Formatting, merged ranges, frozen panes, charts and other worksheets are not written."
      exportLabel="Export CSV"
      summary={
        sheetName
          ? `${scope === 'selection' && selectionRange ? selectionLabel : `All of ${sheetName}`} → one .csv file`
          : undefined
      }
      onExport={() => {
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
      <DetailRow
        label="Worksheet"
        description={
          leftOut > 0 ? (
            <span data-testid="csv-worksheets-left-out">
              {leftOut === 1
                ? '1 other worksheet will not be written.'
                : `${leftOut} other worksheets will not be written.`}
            </span>
          ) : undefined
        }
      >
        {select(
          'csv-worksheet',
          effectiveWorksheetId,
          setWorksheetId,
          worksheets.map((worksheet) => ({ value: worksheet.id, label: worksheet.name })),
        )}
      </DetailRow>
      {selectionRange && (
        <DetailRow label="Cells">
          {select('csv-scope', scope, (value) => setScope(value as 'worksheet' | 'selection'), [
            { value: 'worksheet', label: 'Whole worksheet' },
            { value: 'selection', label: `Selected range (${selectionLabel})` },
          ])}
        </DetailRow>
      )}
      <DetailRow label="Delimiter">
        {select('csv-delimiter', delimiter, setDelimiter, DELIMITERS)}
      </DetailRow>
      <DetailRow
        label={<label htmlFor="csv-formulas">Write formula source instead of values</label>}
        description="Off by default. Most tools reading a CSV expect the calculated value."
      >
        <Checkbox
          id="csv-formulas"
          checked={includeFormulas}
          onCheckedChange={(checked) => setIncludeFormulas(checked === true)}
        />
      </DetailRow>
      <DetailRow
        label={<label htmlFor="csv-executable">Allow fields a spreadsheet will execute</label>}
        description={
          <>
            By default a field starting with <code>=</code>, <code>+</code>, <code>-</code> or{' '}
            <code>@</code> is prefixed so it shows as text.
          </>
        }
      >
        <Checkbox
          id="csv-executable"
          checked={allowExecutable}
          onCheckedChange={(checked) => setAllowExecutable(checked === true)}
        />
      </DetailRow>
      {allowExecutable && (
        <div
          className="mt-3 flex items-start gap-2 rounded-[10px] border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs"
          data-testid="csv-injection-warning"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-destructive" />
          <span>
            Anyone who opens this file in a spreadsheet application will run those fields. Only do
            this when you send the file to someone who expects live formulas.
          </span>
        </div>
      )}
    </ExportDialog>
  );
}
