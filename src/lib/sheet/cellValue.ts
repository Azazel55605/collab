/**
 * Type-aware cell input parsing and display formatting.
 *
 * Storage rules from the Phase 0 contract:
 * - a leading `=` makes the entry a formula, and the source text is stored as-is
 * - dates, times, and datetimes are stored as ISO-8601 strings with an explicit
 *   `valueType`, never as serial numbers
 * - anything not confidently recognized stays text, so a value the user typed is
 *   never quietly reinterpreted
 *
 * Date parsing is deliberately conservative (ISO-like forms only). Locale-aware
 * entry belongs with the number-format work in Phase 4, where the app's
 * date/time settings are already in play.
 */

import type {
  SheetCell,
  SheetNumberFormat,
  SheetStyle,
  SheetValueType,
} from '../../types/sheet';
import type { SheetFormulaComputedValue } from '../../types/sheetFormula';

const BOOLEAN_TRUE = /^true$/i;
const BOOLEAN_FALSE = /^false$/i;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
/** Plain decimal numbers, with optional sign, thousands separators, and exponent. */
const NUMBER = /^[+-]?(\d{1,3}(,\d{3})+|\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const PERCENT = /^([+-]?\d*\.?\d+)\s*%$/;

function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isValidTime(hour: number, minute: number, second: number): boolean {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/**
 * Converts raw editor input into the cell that should be stored. Returns `null`
 * when the input is empty, meaning the cell should be removed from the sparse
 * map rather than stored blank.
 */
export function parseCellInput(input: string): SheetCell | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('=')) {
    // Formula source is authoritative and is stored verbatim, including its
    // original spacing — the user's text is what round-trips.
    return { formula: input.trim() };
  }

  if (BOOLEAN_TRUE.test(trimmed)) return { value: true, valueType: 'boolean' };
  if (BOOLEAN_FALSE.test(trimmed)) return { value: false, valueType: 'boolean' };

  const dateTime = DATE_TIME.exec(trimmed);
  if (dateTime) {
    const [, year, month, day, hour, minute, second = '0'] = dateTime;
    if (isValidDate(+year, +month, +day) && isValidTime(+hour, +minute, +second)) {
      return {
        value: `${year}-${month}-${day}T${pad(+hour)}:${minute}:${pad(+second)}`,
        valueType: 'datetime',
      };
    }
  }

  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    if (isValidDate(+year, +month, +day)) {
      return { value: `${year}-${month}-${day}`, valueType: 'date' };
    }
  }

  const timeOnly = TIME_ONLY.exec(trimmed);
  if (timeOnly) {
    const [, hour, minute, second = '0'] = timeOnly;
    if (isValidTime(+hour, +minute, +second)) {
      return { value: `${pad(+hour)}:${minute}:${pad(+second)}`, valueType: 'time' };
    }
  }

  const percent = PERCENT.exec(trimmed);
  if (percent) {
    const parsed = Number(percent[1]);
    if (Number.isFinite(parsed)) {
      // Percent entry stores the underlying fraction; display formatting is a
      // Phase 4 concern, so the typed text is preserved as the display hint.
      return { value: parsed / 100, valueType: 'number' };
    }
  }

  if (NUMBER.test(trimmed) && /\d/.test(trimmed)) {
    const parsed = Number(trimmed.replace(/,/g, ''));
    if (Number.isFinite(parsed)) return { value: parsed, valueType: 'number' };
  }

  return { value: input, valueType: 'text' };
}

/** The text shown in a cell when it is not being edited. */
export interface SheetDisplayFormatOptions {
  locale?: string;
  dateFormat?: 'MMM_D_YYYY' | 'D_MMM_YYYY' | 'YYYY_MM_DD' | 'MM_DD_YYYY' | 'DD_MM_YYYY';
  timeFormat?: 'system' | '12-hour' | '24-hour';
}

function formatDateValue(value: string, format: SheetDisplayFormatOptions['dateFormat']): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match || !format) return value;
  const [, year, month, day] = match;
  const monthName = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
  if (format === 'MMM_D_YYYY') return `${monthName} ${Number(day)}, ${year}`;
  if (format === 'D_MMM_YYYY') return `${Number(day)} ${monthName} ${year}`;
  if (format === 'MM_DD_YYYY') return `${month}/${day}/${year}`;
  if (format === 'DD_MM_YYYY') return `${day}/${month}/${year}`;
  return `${year}-${month}-${day}`;
}

function formatTimeValue(value: string, options: SheetDisplayFormatOptions): string {
  const time = /(?:T|^)(\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  if (!time) return value;
  const date = new Date(2026, 0, 1, Number(time[1]), Number(time[2]), Number(time[3] ?? 0));
  return new Intl.DateTimeFormat(options.locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: options.timeFormat === 'system' || !options.timeFormat
      ? undefined
      : options.timeFormat === '12-hour',
  }).format(date);
}

function formatCustomNumber(value: number, pattern: string, locale?: string): string {
  const numeric = /[#0][#0,]*(?:\.([#0]+))?/.exec(pattern);
  if (!numeric) return formatNumber(value);
  const decimals = numeric[1]?.length ?? 0;
  const rendered = new Intl.NumberFormat(locale, {
    minimumFractionDigits: numeric[1]?.replace(/#/g, '').length ?? 0,
    maximumFractionDigits: decimals,
    useGrouping: numeric[0].includes(','),
  }).format(value);
  return `${pattern.slice(0, numeric.index)}${rendered}${pattern.slice(numeric.index + numeric[0].length)}`;
}

export function formatNumberWithStyle(
  value: number,
  numberFormat: SheetNumberFormat | undefined,
  options: SheetDisplayFormatOptions = {},
): string {
  if (!numberFormat || numberFormat.kind === 'general') return formatNumber(value);
  const decimals = Math.max(0, Math.min(12, numberFormat.decimals ?? 2));
  if (numberFormat.kind === 'percent') {
    return new Intl.NumberFormat(options.locale, {
      style: 'percent',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  }
  if (numberFormat.kind === 'currency') {
    return new Intl.NumberFormat(options.locale, {
      style: 'currency',
      currency: numberFormat.currencyCode ?? 'EUR',
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  }
  if (numberFormat.kind === 'custom' && numberFormat.pattern) {
    return formatCustomNumber(value, numberFormat.pattern, options.locale);
  }
  if (numberFormat.kind === 'number') {
    return new Intl.NumberFormat(options.locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: numberFormat.useThousandsSeparator ?? false,
    }).format(value);
  }
  return formatNumber(value);
}

export function formatComputedValue(
  value: SheetFormulaComputedValue | undefined,
  style?: SheetStyle,
  options: SheetDisplayFormatOptions = {},
): string {
  if (!value || value.type === 'blank') return '';
  if (value.type === 'number') return formatNumberWithStyle(value.value, style?.numberFormat, options);
  if (value.type === 'boolean') return value.value ? 'TRUE' : 'FALSE';
  return value.value;
}

export function formatCellDisplay(
  cell: SheetCell | undefined,
  computed?: SheetFormulaComputedValue,
  style?: SheetStyle,
  options: SheetDisplayFormatOptions = {},
): string {
  if (!cell) return '';
  if (cell.formula) return computed ? formatComputedValue(computed, style, options) : '…';
  if (cell.value === undefined || cell.value === null) return '';
  if (typeof cell.value === 'boolean') return cell.value ? 'TRUE' : 'FALSE';
  if (typeof cell.value === 'number') {
    return formatNumberWithStyle(cell.value, style?.numberFormat, options);
  }
  if (typeof cell.value === 'string') {
    if (style?.numberFormat?.kind === 'date' || cell.valueType === 'date') {
      return formatDateValue(cell.value, options.dateFormat);
    }
    if (style?.numberFormat?.kind === 'time' || cell.valueType === 'time') {
      return formatTimeValue(cell.value, options);
    }
    if (style?.numberFormat?.kind === 'datetime' || cell.valueType === 'datetime') {
      if (!options.dateFormat && !options.timeFormat && style?.numberFormat?.kind !== 'datetime') {
        return cell.value;
      }
      const date = formatDateValue(cell.value, options.dateFormat);
      return `${date} ${formatTimeValue(cell.value, options)}`;
    }
  }
  return String(cell.value);
}

/** The text shown in the editor and formula bar when a cell is opened. */
export function formatCellEditText(cell: SheetCell | undefined): string {
  if (!cell) return '';
  if (cell.formula) return cell.formula;
  if (cell.value === undefined || cell.value === null) return '';
  if (typeof cell.value === 'boolean') return cell.value ? 'TRUE' : 'FALSE';
  return String(cell.value);
}

/**
 * Default numeric rendering: enough precision to be useful, without the noise
 * of binary floating point (`0.1 + 0.2`). Explicit number formats arrive in
 * Phase 4 and take precedence over this.
 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const rounded = Number(value.toPrecision(12));
  return String(rounded);
}

/** Alignment convention: numbers and dates right, booleans centered, text left. */
export function cellAlignment(
  cell: SheetCell | undefined,
  computed?: SheetFormulaComputedValue,
): 'left' | 'center' | 'right' {
  if (!cell) return 'left';
  if (cell.formula) {
    if (computed?.type === 'boolean') return 'center';
    if (computed?.type === 'text') return 'left';
    return 'right';
  }
  if (typeof cell.value === 'boolean') return 'center';
  if (typeof cell.value === 'number') return 'right';
  const numericTypes: SheetValueType[] = ['number', 'date', 'time', 'datetime'];
  if (cell.valueType && numericTypes.includes(cell.valueType)) return 'right';
  return 'left';
}

/** The numeric value of a cell for status-bar summaries, if it has one. */
export function numericValueOf(
  cell: SheetCell | undefined,
  computed?: SheetFormulaComputedValue,
): number | null {
  if (!cell) return null;
  if (cell.formula) {
    return computed?.type === 'number' && Number.isFinite(computed.value)
      ? computed.value
      : null;
  }
  if (typeof cell.value === 'number' && Number.isFinite(cell.value)) return cell.value;
  return null;
}
