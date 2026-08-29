import { useEffect, useMemo, useState } from 'react';

import { BarChart3, Download, Plus, Trash2 } from 'lucide-react';

import { columnLabel } from '../../lib/sheet/address';
import {
  buildSheetChartSvg,
  createChartFromSelection,
  groupedSheetSummary,
  pivotSheetSummary,
  stableRangeFromSelection,
} from '../../lib/sheet/analysis';
import type { SheetSelection } from '../../lib/sheet/selection';
import type { SheetChart, SheetChartKind, SheetWorksheet } from '../../types/sheet';
import type { SheetFormulaValueMap } from '../../types/sheetFormula';
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

interface Props {
  open: boolean;
  readOnly?: boolean;
  worksheet: SheetWorksheet;
  selection: SheetSelection;
  computedValues: SheetFormulaValueMap;
  onOpenChange: (open: boolean) => void;
  onUpsertChart: (chart: SheetChart) => void;
  onRemoveChart: (chartId: string) => void;
  onExportChart: (chart: SheetChart) => void;
}

const CHART_KINDS: Array<{ value: SheetChartKind; label: string }> = [
  { value: 'column', label: 'Column' },
  { value: 'bar', label: 'Bar' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'pie', label: 'Pie' },
  { value: 'scatter', label: 'Scatter' },
  { value: 'sparkline', label: 'Sparkline' },
];

export default function SheetAnalysisDialog({
  open,
  readOnly,
  worksheet,
  selection,
  computedValues,
  onOpenChange,
  onUpsertChart,
  onRemoveChart,
  onExportChart,
}: Props) {
  const [mode, setMode] = useState<'charts' | 'summary' | 'pivot'>('charts');
  const [kind, setKind] = useState<SheetChartKind>('column');
  const [title, setTitle] = useState('');
  const range = useMemo(
    () => stableRangeFromSelection(worksheet, selection),
    [selection, worksheet],
  );
  const rangeColumns = useMemo(() => {
    if (!range) return [];
    const left = worksheet.columnOrder.indexOf(range.startColumnId);
    const right = worksheet.columnOrder.indexOf(range.endColumnId);
    if (left < 0 || right < 0) return [];
    return worksheet.columnOrder
      .slice(Math.min(left, right), Math.max(left, right) + 1)
      .map((id, offset) => ({
        id,
        label: columnLabel(Math.min(left, right) + offset),
      }));
  }, [range, worksheet.columnOrder]);
  const [groupColumn, setGroupColumn] = useState('');
  const [valueColumn, setValueColumn] = useState('');
  const [pivotColumn, setPivotColumn] = useState('');

  useEffect(() => {
    if (!open || rangeColumns.length === 0) return;
    setGroupColumn((current) => current || rangeColumns[0].id);
    setValueColumn((current) => current || rangeColumns[Math.min(1, rangeColumns.length - 1)].id);
    setPivotColumn((current) => current || rangeColumns[Math.min(2, rangeColumns.length - 1)].id);
  }, [open, rangeColumns]);

  const charts = worksheet.charts ?? [];
  const summary = useMemo(
    () =>
      range && groupColumn && valueColumn
        ? groupedSheetSummary(worksheet, range, groupColumn, valueColumn, computedValues)
        : [],
    [computedValues, groupColumn, range, valueColumn, worksheet],
  );
  const pivot = useMemo(
    () =>
      range && groupColumn && pivotColumn && valueColumn
        ? pivotSheetSummary(worksheet, range, groupColumn, pivotColumn, valueColumn, computedValues)
        : { rows: [], columns: [], values: new Map<string, number>() },
    [computedValues, groupColumn, pivotColumn, range, valueColumn, worksheet],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Charts and analysis</DialogTitle>
          <DialogDescription>
            Visualize stable ranges or build a bounded summary from the current selection.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="inline-flex w-fit rounded-md border border-border bg-muted/30 p-0.5">
            {(['charts', 'summary', 'pivot'] as const).map((item) => (
              <Button
                key={item}
                type="button"
                variant={mode === item ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setMode(item)}
              >
                {item === 'charts'
                  ? 'Charts'
                  : item === 'summary'
                    ? 'Grouped summary'
                    : 'Pivot summary'}
              </Button>
            ))}
          </div>

          {mode === 'charts' ? (
            <div className="grid min-h-0 gap-3 md:grid-cols-[15rem_1fr]">
              <div className="flex flex-col gap-2">
                <Input
                  value={title}
                  aria-label="Chart title"
                  placeholder="Chart title"
                  disabled={readOnly}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <Select value={kind} onValueChange={(value) => setKind(value as SheetChartKind)}>
                  <SelectTrigger className="w-full" aria-label="Chart type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHART_KINDS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  disabled={readOnly || !range}
                  onClick={() =>
                    onUpsertChart(createChartFromSelection(worksheet, selection, kind, title))
                  }
                >
                  <Plus data-icon="inline-start" />
                  Add from selection
                </Button>
                <div className="text-[11px] text-muted-foreground">
                  The first selected column supplies categories when multiple columns are selected.
                </div>
              </div>
              <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
                {charts.length === 0 ? (
                  <div className="grid min-h-56 place-items-center rounded-md border border-dashed border-border text-xs text-muted-foreground">
                    No charts on {worksheet.name}.
                  </div>
                ) : (
                  charts.map((chart) => {
                    const svg = buildSheetChartSvg(worksheet, chart, computedValues);
                    return (
                      <section
                        key={chart.id}
                        className="rounded-md border border-border bg-background p-2"
                      >
                        <div className="mb-2 flex items-center gap-2">
                          <BarChart3 size={14} className="text-primary" />
                          <span className="min-w-0 flex-1 truncate text-xs font-medium">
                            {chart.title || `${chart.kind} chart`}
                          </span>
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Export ${chart.title || chart.kind} chart`}
                            onClick={() => onExportChart(chart)}
                          >
                            <Download />
                          </Button>
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            disabled={readOnly}
                            aria-label={`Remove ${chart.title || chart.kind} chart`}
                            onClick={() => onRemoveChart(chart.id)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                        <div
                          className="max-w-full overflow-auto rounded-sm bg-white"
                          dangerouslySetInnerHTML={{ __html: svg }}
                        />
                      </section>
                    );
                  })
                )}
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-col gap-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <ColumnSelect
                  label="Group rows by"
                  value={groupColumn}
                  columns={rangeColumns}
                  onChange={setGroupColumn}
                />
                {mode === 'pivot' && (
                  <ColumnSelect
                    label="Columns by"
                    value={pivotColumn}
                    columns={rangeColumns}
                    onChange={setPivotColumn}
                  />
                )}
                <ColumnSelect
                  label="Sum values from"
                  value={valueColumn}
                  columns={rangeColumns}
                  onChange={setValueColumn}
                />
              </div>
              <div className="max-h-[50vh] overflow-auto rounded-md border border-border">
                {mode === 'summary' ? (
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="p-2 text-left">Group</th>
                        <th>Count</th>
                        <th>Sum</th>
                        <th>Average</th>
                        <th>Min</th>
                        <th>Max</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.map((row) => (
                        <tr key={row.group} className="border-t border-border">
                          <th className="p-2 text-left font-medium">{row.group}</th>
                          <td className="text-center">{row.count}</td>
                          <td className="text-center">{row.sum}</td>
                          <td className="text-center">{row.average ?? '—'}</td>
                          <td className="text-center">{row.min ?? '—'}</td>
                          <td className="text-center">{row.max ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr>
                        <th className="p-2 text-left">Group</th>
                        {pivot.columns.map((column) => (
                          <th key={column} className="px-2">
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {pivot.rows.map((row) => (
                        <tr key={row} className="border-t border-border">
                          <th className="p-2 text-left font-medium">{row}</th>
                          {pivot.columns.map((column) => (
                            <td key={column} className="px-2 text-center">
                              {pivot.values.get(`${row}\u0000${column}`) ?? '—'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

function ColumnSelect({
  label,
  value,
  columns,
  onChange,
}: {
  label: string;
  value: string;
  columns: Array<{ id: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium">
      {label}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {columns.map((column) => (
            <SelectItem key={column.id} value={column.id}>
              Column {column.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
