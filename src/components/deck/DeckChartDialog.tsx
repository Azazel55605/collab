import { useEffect, useState } from 'react';

import { Link2, Loader2, Plus, RefreshCw, Trash2, Unlink } from 'lucide-react';

import type { ChartData } from '../../lib/deck/sheetSnapshot';
import { DECK_LIMITS } from '../../types/deck';
import type { DeckChartElement, DeckChartKind } from '../../types/deck';
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

export interface ChartEdit {
  kind: DeckChartKind;
  title: string;
  showLegend: boolean;
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
  /** The linked range, `null` to unlink, `undefined` to leave as it was. */
  source?: { path: string; range: string } | null;
}

interface DeckChartDialogProps {
  /** Where focus goes when the dialog closes (the slide, rather than the menu that opened it). */
  onReturnFocus?: () => void;
  open: boolean;
  chart: DeckChartElement | null;
  workbooks: string[];
  onOpenChange: (open: boolean) => void;
  onApply: (edit: ChartEdit) => void;
  /** Reads a workbook range once; the caller evaluates formulas. */
  onLoadRange: (path: string, range: string) => Promise<ChartData>;
}

const KIND_NAMES: Record<DeckChartKind, string> = {
  column: 'Column',
  bar: 'Bar',
  line: 'Line',
  area: 'Area',
  pie: 'Pie',
};

type Grid = { categories: string[]; names: string[]; values: string[][] };

function toGrid(chart: Pick<ChartEdit, 'categories' | 'series'>): Grid {
  return {
    categories: [...chart.categories],
    names: chart.series.map((series) => series.name),
    values: chart.categories.map((_, row) =>
      chart.series.map((series) => String(series.values[row] ?? 0)),
    ),
  };
}

function parseNumber(text: string): number {
  const value = Number(text.replace(/,/g, '').trim());
  return Number.isFinite(value) ? value : 0;
}

/**
 * Edits a chart: its type, title, legend, and data — typed in, or read once
 * from a workbook range and linked so "Refresh" can read it again.
 */
export function DeckChartDialog({
  onReturnFocus,
  open,
  chart,
  workbooks,
  onOpenChange,
  onApply,
  onLoadRange,
}: DeckChartDialogProps) {
  const [kind, setKind] = useState<DeckChartKind>('column');
  const [title, setTitle] = useState('');
  const [showLegend, setShowLegend] = useState(true);
  const [grid, setGrid] = useState<Grid>({ categories: [], names: [], values: [] });
  const [source, setSource] = useState<{ path: string; range: string } | null>(null);
  const [linkPath, setLinkPath] = useState<string | undefined>(undefined);
  const [linkRange, setLinkRange] = useState('A1:C5');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !chart) return;
    setKind(chart.kind);
    setTitle(chart.title ?? '');
    setShowLegend(chart.showLegend ?? false);
    setGrid(toGrid(chart));
    setSource(chart.source ? { path: chart.source.path, range: chart.source.range } : null);
    setLinkPath(chart.source?.path ?? workbooks[0]);
    setLinkRange(chart.source?.range ?? 'A1:C5');
    setMessage(null);
  }, [chart, open, workbooks]);

  const setValue = (row: number, column: number, value: string) =>
    setGrid((current) => ({
      ...current,
      values: current.values.map((line, index) =>
        index === row ? line.map((cell, at) => (at === column ? value : cell)) : line,
      ),
    }));

  const load = async () => {
    if (!linkPath) return;
    setLoading(true);
    setMessage(null);
    try {
      const data = await onLoadRange(linkPath, linkRange);
      setGrid(toGrid(data));
      setSource({ path: linkPath, range: linkRange });
      setMessage(
        data.nonNumeric > 0
          ? `Read ${data.series.length} series. ${data.nonNumeric} cells were not numbers and are shown as 0.`
          : `Read ${data.series.length} series of ${data.categories.length} points.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const apply = () =>
    onApply({
      kind,
      title: title.trim(),
      showLegend,
      categories: grid.categories.map((category) => category.slice(0, DECK_LIMITS.nameLength)),
      series: grid.names.map((name, column) => ({
        name: name.trim() || `Series ${column + 1}`,
        values: grid.values.map((row) => parseNumber(row[column] ?? '0')),
      })),
      source: source ? source : chart?.source ? null : undefined,
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          if (!onReturnFocus) return;
          event.preventDefault();
          onReturnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Chart data</DialogTitle>
          <DialogDescription>
            Type values, or read them from a workbook range. A linked chart only changes when you
            refresh it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={kind} onValueChange={(value) => setKind(value as DeckChartKind)}>
            <SelectTrigger size="sm" className="w-28" aria-label="Chart type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(KIND_NAMES) as DeckChartKind[]).map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {KIND_NAMES[entry]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Chart title"
            placeholder="Title"
            className="h-8 w-56"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              className="accent-primary"
              checked={showLegend}
              onChange={(event) => setShowLegend(event.target.checked)}
            />
            Legend
          </label>
        </div>

        <div className="rounded-md border border-border/60 p-2">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
            <Link2 className="size-3.5 text-muted-foreground" />
            <Select value={linkPath} onValueChange={setLinkPath}>
              <SelectTrigger size="sm" className="w-56" aria-label="Workbook">
                <SelectValue
                  placeholder={workbooks.length ? 'Workbook' : 'No workbooks in this vault'}
                />
              </SelectTrigger>
              <SelectContent>
                {workbooks.map((path) => (
                  <SelectItem key={path} value={path}>
                    {path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              aria-label="Range"
              className="h-8 w-36"
              value={linkRange}
              placeholder="Sheet1!A1:C5"
              onChange={(event) => setLinkRange(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!linkPath || loading}
              onClick={() => void load()}
            >
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {source ? 'Read again' : 'Read range'}
            </Button>
            {source && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setSource(null)}>
                <Unlink className="size-3.5" />
                Unlink
              </Button>
            )}
          </div>
          {source && (
            <p className="text-[11px] text-muted-foreground">
              Linked to {source.path} · {source.range}
            </p>
          )}
          {message && (
            <p className="text-[11px] text-muted-foreground" role="status">
              {message}
            </p>
          )}
        </div>

        <div className="max-h-72 overflow-auto rounded-md border border-border/60">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="p-1" />
                {grid.names.map((name, column) => (
                  <th key={column} className="p-1">
                    <div className="flex items-center gap-1">
                      <Input
                        aria-label={`Series ${column + 1} name`}
                        className="h-7 min-w-20 text-xs font-semibold"
                        value={name}
                        onChange={(event) =>
                          setGrid((current) => ({
                            ...current,
                            names: current.names.map((entry, at) =>
                              at === column ? event.target.value : entry,
                            ),
                          }))
                        }
                      />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove series ${column + 1}`}
                        disabled={grid.names.length <= 1}
                        onClick={() =>
                          setGrid((current) => ({
                            ...current,
                            names: current.names.filter((_, at) => at !== column),
                            values: current.values.map((row) =>
                              row.filter((_, at) => at !== column),
                            ),
                          }))
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.categories.map((category, row) => (
                <tr key={row}>
                  <td className="p-1">
                    <div className="flex items-center gap-1">
                      <Input
                        aria-label={`Category ${row + 1}`}
                        className="h-7 min-w-20 text-xs"
                        value={category}
                        onChange={(event) =>
                          setGrid((current) => ({
                            ...current,
                            categories: current.categories.map((entry, at) =>
                              at === row ? event.target.value : entry,
                            ),
                          }))
                        }
                      />
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove category ${row + 1}`}
                        disabled={grid.categories.length <= 1}
                        onClick={() =>
                          setGrid((current) => ({
                            ...current,
                            categories: current.categories.filter((_, at) => at !== row),
                            values: current.values.filter((_, at) => at !== row),
                          }))
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </td>
                  {grid.names.map((_, column) => (
                    <td key={column} className="p-1">
                      <Input
                        aria-label={`Value ${row + 1}, ${column + 1}`}
                        className="h-7 min-w-16 text-right text-xs tabular-nums"
                        inputMode="decimal"
                        value={grid.values[row]?.[column] ?? ''}
                        onChange={(event) => setValue(row, column, event.target.value)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={grid.categories.length >= DECK_LIMITS.chartPointsPerSeries}
            onClick={() =>
              setGrid((current) => ({
                ...current,
                categories: [...current.categories, `Item ${current.categories.length + 1}`],
                values: [...current.values, current.names.map(() => '0')],
              }))
            }
          >
            <Plus className="size-3.5" /> Category
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={grid.names.length >= DECK_LIMITS.chartSeries}
            onClick={() =>
              setGrid((current) => ({
                ...current,
                names: [...current.names, `Series ${current.names.length + 1}`],
                values: current.values.map((row) => [...row, '0']),
              }))
            }
          >
            <Plus className="size-3.5" /> Series
          </Button>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={apply}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
