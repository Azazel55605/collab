import { scaleBand, scaleLinear } from 'd3';

import type {
  SheetChart,
  SheetChartKind,
  SheetRange,
  SheetWorksheet,
} from '../../types/sheet';
import type { SheetFormulaValueMap } from '../../types/sheetFormula';
import { sheetFormulaResultKey } from '../../types/sheetFormula';
import { createSheetChartId, createSheetChartSeriesId } from './document';
import { formatCellDisplay, numericValueOf } from './cellValue';
import { getCell } from './operations';
import { normalizeRange, type SheetSelection } from './selection';

export interface SheetChartPoint {
  category: string;
  value: number;
  x?: number;
}

export interface SheetChartDataset {
  id: string;
  name: string;
  color: string;
  points: SheetChartPoint[];
}

export interface SheetGroupedSummary {
  group: string;
  count: number;
  sum: number;
  average: number | null;
  min: number | null;
  max: number | null;
}

const CHART_COLORS = ['#8b5cf6', '#06b6d4', '#22c55e', '#f59e0b', '#f43f5e', '#3b82f6'];
const MAX_ANALYSIS_ROWS = 10_000;

export function stableRangeFromSelection(
  worksheet: SheetWorksheet,
  selection: SheetSelection,
): SheetRange | null {
  const rectangle = normalizeRange(selection.ranges[0] ?? {
    anchor: selection.active,
    focus: selection.active,
  });
  const startRowId = worksheet.rowOrder[rectangle.top];
  const endRowId = worksheet.rowOrder[rectangle.bottom];
  const startColumnId = worksheet.columnOrder[rectangle.left];
  const endColumnId = worksheet.columnOrder[rectangle.right];
  return startRowId && endRowId && startColumnId && endColumnId
    ? { startRowId, endRowId, startColumnId, endColumnId }
    : null;
}

function rangeIndexes(worksheet: SheetWorksheet, range: SheetRange) {
  const top = worksheet.rowOrder.indexOf(range.startRowId);
  const bottom = worksheet.rowOrder.indexOf(range.endRowId);
  const left = worksheet.columnOrder.indexOf(range.startColumnId);
  const right = worksheet.columnOrder.indexOf(range.endColumnId);
  if (top < 0 || bottom < 0 || left < 0 || right < 0) return null;
  return {
    top: Math.min(top, bottom),
    bottom: Math.max(top, bottom),
    left: Math.min(left, right),
    right: Math.max(left, right),
  };
}

function computedValue(
  worksheet: SheetWorksheet,
  row: number,
  column: number,
  computedValues?: SheetFormulaValueMap,
) {
  const rowId = worksheet.rowOrder[row];
  const columnId = worksheet.columnOrder[column];
  return rowId && columnId
    ? computedValues?.get(sheetFormulaResultKey(worksheet.id, rowId, columnId))
    : undefined;
}

function safeChartColor(value: string | undefined, fallback: string) {
  return value && /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%+-]+\))$/i.test(value.trim())
    ? value.trim()
    : fallback;
}

function cellLabel(
  worksheet: SheetWorksheet,
  row: number,
  column: number,
  computedValues?: SheetFormulaValueMap,
) {
  const cell = getCell(worksheet, { row, column });
  return formatCellDisplay(cell, computedValue(worksheet, row, column, computedValues), {});
}

export function createChartFromSelection(
  worksheet: SheetWorksheet,
  selection: SheetSelection,
  kind: SheetChartKind,
  title?: string,
): SheetChart {
  const range = stableRangeFromSelection(worksheet, selection);
  if (!range) throw new Error('Select a valid range before creating a chart.');
  const indexes = rangeIndexes(worksheet, range);
  if (!indexes) throw new Error('The selected chart range no longer exists.');
  const hasCategoryColumn = indexes.right > indexes.left;
  const firstSeriesColumn = hasCategoryColumn ? indexes.left + 1 : indexes.left;
  const series = Array.from(
    { length: indexes.right - firstSeriesColumn + 1 },
    (_, offset) => {
      const column = firstSeriesColumn + offset;
      const columnId = worksheet.columnOrder[column];
      const header = getCell(worksheet, { row: indexes.top, column });
      return {
        id: createSheetChartSeriesId(),
        name: typeof header?.value === 'string' && header.value.trim()
          ? header.value.trim()
          : `Series ${offset + 1}`,
        valuesRange: {
          startRowId: worksheet.rowOrder[indexes.top],
          endRowId: worksheet.rowOrder[indexes.bottom],
          startColumnId: columnId,
          endColumnId: columnId,
        },
        ...(hasCategoryColumn ? {
          categoriesRange: {
            startRowId: worksheet.rowOrder[indexes.top],
            endRowId: worksheet.rowOrder[indexes.bottom],
            startColumnId: worksheet.columnOrder[indexes.left],
            endColumnId: worksheet.columnOrder[indexes.left],
          },
        } : {}),
        color: CHART_COLORS[offset % CHART_COLORS.length],
      };
    },
  );
  return {
    id: createSheetChartId(),
    kind,
    ...(title?.trim() ? { title: title.trim() } : {}),
    series,
    anchor: {
      rowId: worksheet.rowOrder[indexes.top],
      columnId: worksheet.columnOrder[indexes.left],
      width: kind === 'sparkline' ? 260 : 520,
      height: kind === 'sparkline' ? 100 : 300,
    },
  };
}

export function chartDatasets(
  worksheet: SheetWorksheet,
  chart: SheetChart,
  computedValues?: SheetFormulaValueMap,
): SheetChartDataset[] {
  return chart.series.flatMap((series, seriesIndex) => {
    const values = rangeIndexes(worksheet, series.valuesRange);
    if (!values) return [];
    const categories = series.categoriesRange
      ? rangeIndexes(worksheet, series.categoriesRange)
      : null;
    const points: SheetChartPoint[] = [];
    const count = Math.min(MAX_ANALYSIS_ROWS, values.bottom - values.top + 1);
    for (let offset = 0; offset < count; offset += 1) {
      const row = values.top + offset;
      const raw = getCell(worksheet, { row, column: values.left });
      const numeric = numericValueOf(
        raw,
        computedValue(worksheet, row, values.left, computedValues),
      );
      if (numeric === null || !Number.isFinite(numeric)) continue;
      const category = categories
        ? cellLabel(worksheet, categories.top + offset, categories.left, computedValues)
        : String(offset + 1);
      const x = chart.kind === 'scatter' && categories
        ? numericValueOf(
          getCell(worksheet, { row: categories.top + offset, column: categories.left }),
          computedValue(worksheet, categories.top + offset, categories.left, computedValues),
        ) ?? offset + 1
        : undefined;
      points.push({ category: category || String(offset + 1), value: numeric, x });
    }
    return [{
      id: series.id,
      name: series.name || `Series ${seriesIndex + 1}`,
      color: safeChartColor(series.color, CHART_COLORS[seriesIndex % CHART_COLORS.length]),
      points,
    }];
  });
}

export function chartAccessibilitySummary(
  worksheet: SheetWorksheet,
  chart: SheetChart,
  computedValues?: SheetFormulaValueMap,
) {
  if (chart.description?.trim()) return chart.description.trim();
  const datasets = chartDatasets(worksheet, chart, computedValues);
  const points = datasets.flatMap((dataset) => dataset.points);
  if (points.length === 0) return `${chart.title || 'Chart'} has no numeric data.`;
  const values = points.map((point) => point.value);
  return `${chart.title || `${chart.kind} chart`}: ${datasets.length} series and ${points.length} values. Minimum ${Math.min(...values)}, maximum ${Math.max(...values)}.`;
}

function escapeXml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character] ?? character);
}

export function buildSheetChartSvg(
  worksheet: SheetWorksheet,
  chart: SheetChart,
  computedValues?: SheetFormulaValueMap,
): string {
  const width = Math.max(120, chart.anchor.width);
  const height = Math.max(80, chart.anchor.height);
  const datasets = chartDatasets(worksheet, chart, computedValues);
  const all = datasets.flatMap((dataset) => dataset.points.map((point) => point.value));
  const summary = chartAccessibilitySummary(worksheet, chart, computedValues);
  const margin = chart.kind === 'sparkline'
    ? { top: 10, right: 10, bottom: 10, left: 10 }
    : { top: chart.title ? 38 : 18, right: 20, bottom: 38, left: 48 };
  const innerWidth = Math.max(1, width - margin.left - margin.right);
  const innerHeight = Math.max(1, height - margin.top - margin.bottom);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const y = scaleLinear().domain([min, max === min ? min + 1 : max]).nice().range([innerHeight, 0]);
  const categories = [...new Set(datasets.flatMap((dataset) => dataset.points.map((point) => point.category)))];
  const x = scaleBand<string>().domain(categories).range([0, innerWidth]).padding(0.18);
  const categoryY = scaleBand<string>().domain(categories).range([0, innerHeight]).padding(0.18);
  let content = '';

  if (chart.kind === 'pie') {
    const values = datasets[0]?.points ?? [];
    const total = values.reduce((sum, point) => sum + Math.max(0, point.value), 0) || 1;
    let angle = -Math.PI / 2;
    const radius = Math.min(innerWidth, innerHeight) / 2;
    const cx = margin.left + innerWidth / 2;
    const cy = margin.top + innerHeight / 2;
    content = values.map((point, index) => {
      const next = angle + (Math.max(0, point.value) / total) * Math.PI * 2;
      const large = next - angle > Math.PI ? 1 : 0;
      const x1 = cx + Math.cos(angle) * radius;
      const y1 = cy + Math.sin(angle) * radius;
      const x2 = cx + Math.cos(next) * radius;
      const y2 = cy + Math.sin(next) * radius;
      const path = `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z" fill="${CHART_COLORS[index % CHART_COLORS.length]}"><title>${escapeXml(point.category)}: ${point.value}</title></path>`;
      angle = next;
      return path;
    }).join('');
  } else if (chart.kind === 'column' || chart.kind === 'bar') {
    const groupWidth = Math.max(1, x.bandwidth());
    content = datasets.flatMap((dataset, seriesIndex) => dataset.points.map((point) => {
      const slot = groupWidth / Math.max(1, datasets.length);
      const px = margin.left + (x(point.category) ?? 0) + seriesIndex * slot;
      const py = margin.top + y(Math.max(0, point.value));
      const baseline = margin.top + y(Math.min(0, point.value));
      if (chart.kind === 'bar') {
        const horizontal = scaleLinear().domain([min, max === min ? min + 1 : max]).range([0, innerWidth]);
        const origin = horizontal(0);
        const value = horizontal(point.value);
        const barSlot = Math.max(1, categoryY.bandwidth()) / Math.max(1, datasets.length);
        return `<rect x="${margin.left + Math.min(origin, value)}" y="${margin.top + (categoryY(point.category) ?? 0) + seriesIndex * barSlot}" width="${Math.abs(value - origin)}" height="${Math.max(2, barSlot - 2)}" fill="${dataset.color}"><title>${escapeXml(point.category)}: ${point.value}</title></rect>`;
      }
      return `<rect x="${px}" y="${Math.min(py, baseline)}" width="${Math.max(2, slot - 2)}" height="${Math.max(1, Math.abs(baseline - py))}" fill="${dataset.color}"><title>${escapeXml(point.category)}: ${point.value}</title></rect>`;
    })).join('');
  } else {
    content = datasets.map((dataset) => {
      const points = dataset.points.map((point) => {
        const px = chart.kind === 'scatter'
          ? scaleLinear()
            .domain([
              Math.min(...dataset.points.map((candidate) => candidate.x ?? 0)),
              Math.max(...dataset.points.map((candidate) => candidate.x ?? 0)) || 1,
            ])
            .range([0, innerWidth])(point.x ?? 0)
          : (x(point.category) ?? 0) + x.bandwidth() / 2;
        return [margin.left + px, margin.top + y(point.value)] as const;
      });
      const path = points.map(([px, py], index) => `${index === 0 ? 'M' : 'L'} ${px} ${py}`).join(' ');
      if (chart.kind === 'area') {
        const baseline = margin.top + y(0);
        const first = points[0];
      const last = points[points.length - 1];
        return first && last
          ? `<path d="${path} L ${last[0]} ${baseline} L ${first[0]} ${baseline} Z" fill="${dataset.color}" fill-opacity=".22"/><path d="${path}" fill="none" stroke="${dataset.color}" stroke-width="2"/>`
          : '';
      }
      const dots = chart.kind === 'scatter'
        ? points.map(([px, py]) => `<circle cx="${px}" cy="${py}" r="3.5" fill="${dataset.color}"/>`).join('')
        : '';
      return `<path d="${path}" fill="none" stroke="${dataset.color}" stroke-width="${chart.kind === 'sparkline' ? 2.5 : 2}"/>${dots}`;
    }).join('');
  }

  const title = chart.title
    ? `<text x="${width / 2}" y="22" text-anchor="middle" font-size="14" font-weight="600">${escapeXml(chart.title)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(summary)}"><title>${escapeXml(summary)}</title><rect width="100%" height="100%" rx="6" fill="#ffffff"/>${title}${content}</svg>`;
}

export function groupedSheetSummary(
  worksheet: SheetWorksheet,
  range: SheetRange,
  groupColumnId: string,
  valueColumnId: string,
  computedValues?: SheetFormulaValueMap,
): SheetGroupedSummary[] {
  const indexes = rangeIndexes(worksheet, range);
  const groupColumn = worksheet.columnOrder.indexOf(groupColumnId);
  const valueColumn = worksheet.columnOrder.indexOf(valueColumnId);
  if (!indexes || groupColumn < indexes.left || groupColumn > indexes.right
    || valueColumn < indexes.left || valueColumn > indexes.right) return [];
  const groups = new Map<string, number[]>();
  for (let row = indexes.top; row <= Math.min(indexes.bottom, indexes.top + MAX_ANALYSIS_ROWS - 1); row += 1) {
    const group = cellLabel(worksheet, row, groupColumn, computedValues) || '(blank)';
    const value = numericValueOf(
      getCell(worksheet, { row, column: valueColumn }),
      computedValue(worksheet, row, valueColumn, computedValues),
    );
    const values = groups.get(group) ?? [];
    if (value !== null && Number.isFinite(value)) values.push(value);
    groups.set(group, values);
  }
  return [...groups.entries()].map(([group, values]) => ({
    group,
    count: values.length,
    sum: values.reduce((sum, value) => sum + value, 0),
    average: values.length > 0
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null,
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
  }));
}

export function pivotSheetSummary(
  worksheet: SheetWorksheet,
  range: SheetRange,
  rowColumnId: string,
  columnColumnId: string,
  valueColumnId: string,
  computedValues?: SheetFormulaValueMap,
) {
  const indexes = rangeIndexes(worksheet, range);
  const rowColumn = worksheet.columnOrder.indexOf(rowColumnId);
  const columnColumn = worksheet.columnOrder.indexOf(columnColumnId);
  const valueColumn = worksheet.columnOrder.indexOf(valueColumnId);
  if (!indexes || [rowColumn, columnColumn, valueColumn].some((index) => index < indexes.left || index > indexes.right)) {
    return { rows: [], columns: [], values: new Map<string, number>() };
  }
  const rows = new Set<string>();
  const columns = new Set<string>();
  const values = new Map<string, number>();
  for (let row = indexes.top; row <= Math.min(indexes.bottom, indexes.top + MAX_ANALYSIS_ROWS - 1); row += 1) {
    const rowLabel = cellLabel(worksheet, row, rowColumn, computedValues) || '(blank)';
    const columnLabel = cellLabel(worksheet, row, columnColumn, computedValues) || '(blank)';
    const numeric = numericValueOf(
      getCell(worksheet, { row, column: valueColumn }),
      computedValue(worksheet, row, valueColumn, computedValues),
    );
    rows.add(rowLabel);
    columns.add(columnLabel);
    if (numeric !== null && Number.isFinite(numeric)) {
      const key = `${rowLabel}\u0000${columnLabel}`;
      values.set(key, (values.get(key) ?? 0) + numeric);
    }
  }
  return { rows: [...rows], columns: [...columns], values };
}
