import { useEffect, useMemo, useState } from 'react';

import { Check, Filter, RotateCcw } from 'lucide-react';

import type { SheetTableColumnColors } from '../../lib/sheet/dataTools';
import { cn } from '../../lib/utils';
import type { SheetColumnFilter, SheetTableColumn } from '../../types/sheet';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { DatePicker } from '../ui/date-picker';
import { Input } from '../ui/input';
import { Popover, PopoverTrigger } from '../ui/popover';
import {
  PopoverPanel,
  PopoverPanelBody,
  PopoverPanelFooter,
  PopoverPanelHeader,
} from '../ui/popover-patterns';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

type FilterValue = string | number | boolean | null;
type FilterMode = 'values' | 'text' | 'number' | 'date' | 'color';
type ColorKind = 'background' | 'text';

function valueKey(value: FilterValue): string {
  return `${typeof value}:${String(value)}`;
}

function valueLabel(value: FilterValue): string {
  if (value === null || value === '') return '(Blank)';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

function initialMode(filter?: SheetColumnFilter): FilterMode {
  if (filter?.textContains) return 'text';
  if (filter?.numberMin !== undefined || filter?.numberMax !== undefined) return 'number';
  if (filter?.dateFrom || filter?.dateTo) return 'date';
  if (filter?.backgroundColors || filter?.textColors) return 'color';
  return 'values';
}

interface Props {
  disabled?: boolean;
  column: SheetTableColumn;
  values: FilterValue[];
  colors: SheetTableColumnColors;
  filter?: SheetColumnFilter;
  onApply: (filter: SheetColumnFilter | null) => void;
}

export default function SheetFilterPopover({
  disabled,
  column,
  values,
  colors,
  filter,
  onApply,
}: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<FilterMode>(() => initialMode(filter));
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set((filter?.includeValues ?? values).map(valueKey)),
  );
  const [hideBlanks, setHideBlanks] = useState(filter?.hideBlanks ?? false);
  const [textContains, setTextContains] = useState(filter?.textContains ?? '');
  const [numberMin, setNumberMin] = useState(filter?.numberMin?.toString() ?? '');
  const [numberMax, setNumberMax] = useState(filter?.numberMax?.toString() ?? '');
  const [dateFrom, setDateFrom] = useState(filter?.dateFrom ?? '');
  const [dateTo, setDateTo] = useState(filter?.dateTo ?? '');
  const [colorKind, setColorKind] = useState<ColorKind>(filter?.textColors ? 'text' : 'background');
  const [selectedColors, setSelectedColors] = useState<Set<string>>(
    () => new Set(filter?.textColors ?? filter?.backgroundColors ?? []),
  );

  useEffect(() => {
    setMode(initialMode(filter));
    setSelected(new Set((filter?.includeValues ?? values).map(valueKey)));
    setHideBlanks(filter?.hideBlanks ?? false);
    setTextContains(filter?.textContains ?? '');
    setNumberMin(filter?.numberMin?.toString() ?? '');
    setNumberMax(filter?.numberMax?.toString() ?? '');
    setDateFrom(filter?.dateFrom ?? '');
    setDateTo(filter?.dateTo ?? '');
    setColorKind(filter?.textColors ? 'text' : 'background');
    setSelectedColors(new Set(filter?.textColors ?? filter?.backgroundColors ?? []));
  }, [filter, values]);

  const shown = useMemo(
    () =>
      values.filter((value) =>
        valueLabel(value).toLocaleLowerCase().includes(search.toLocaleLowerCase()),
      ),
    [search, values],
  );
  const availableColors = colorKind === 'background' ? colors.backgroundColors : colors.textColors;
  const active = Boolean(filter);

  const apply = () => {
    const next: SheetColumnFilter = { columnId: column.columnId };
    if (hideBlanks) next.hideBlanks = true;
    if (mode === 'values') {
      const includeValues = values.filter((value) => selected.has(valueKey(value)));
      if (includeValues.length !== values.length) next.includeValues = includeValues;
    } else if (mode === 'text' && textContains.trim()) {
      next.textContains = textContains.trim();
    } else if (mode === 'number') {
      if (numberMin.trim() && Number.isFinite(Number(numberMin)))
        next.numberMin = Number(numberMin);
      if (numberMax.trim() && Number.isFinite(Number(numberMax)))
        next.numberMax = Number(numberMax);
    } else if (mode === 'date') {
      if (dateFrom) next.dateFrom = dateFrom;
      if (dateTo) next.dateTo = dateTo;
    } else if (mode === 'color' && selectedColors.size > 0) {
      if (colorKind === 'background') next.backgroundColors = [...selectedColors];
      else next.textColors = [...selectedColors];
    }
    onApply(Object.keys(next).length === 1 ? null : next);
  };

  const modes: [FilterMode, string][] = [
    ['values', 'Values'],
    ['text', 'Text'],
    ['number', 'Number'],
    ['date', 'Date'],
    ['color', 'Colour'],
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={active ? 'secondary' : 'ghost'}
          disabled={disabled}
          aria-label={`Filter ${column.name}`}
        >
          <Filter />
          Filter
        </Button>
      </PopoverTrigger>
      <PopoverPanel align="start" className="w-80">
        <PopoverPanelHeader
          title={`Filter ${column.name}`}
          meta={active ? 'Filtered' : undefined}
        />
        <div
          className="flex flex-wrap gap-1 px-3 pb-2.5"
          role="radiogroup"
          aria-label="Filter type"
        >
          {modes.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                'h-6 rounded-full px-2.5 text-[11.5px] transition-colors',
                mode === value
                  ? 'bg-primary/15 font-medium text-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <PopoverPanelBody className="gap-2">
          {mode === 'values' && (
            <>
              <Input
                value={search}
                placeholder="Search values"
                aria-label="Search filter values"
                onChange={(event) => setSearch(event.target.value)}
              />
              <div className="-mx-1 max-h-52 overflow-y-auto overscroll-contain">
                <label className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px] text-muted-foreground hover:bg-muted/60">
                  <Checkbox
                    checked={
                      shown.length > 0 && shown.every((value) => selected.has(valueKey(value)))
                    }
                    onCheckedChange={(checked) =>
                      setSelected((current) => {
                        const next = new Set(current);
                        for (const value of shown) {
                          if (checked === true) next.add(valueKey(value));
                          else next.delete(valueKey(value));
                        }
                        return next;
                      })
                    }
                  />
                  Select all shown
                </label>
                {shown.map((value) => {
                  const key = valueKey(value);
                  return (
                    <label
                      key={key}
                      className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[12.5px] hover:bg-muted/60"
                    >
                      <Checkbox
                        checked={selected.has(key)}
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (checked === true) next.add(key);
                            else next.delete(key);
                            return next;
                          })
                        }
                      />
                      <span className="truncate">{valueLabel(value)}</span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
          {mode === 'text' && (
            <Input
              value={textContains}
              aria-label="Text contains"
              placeholder="Text to match"
              onChange={(event) => setTextContains(event.target.value)}
            />
          )}
          {mode === 'number' && (
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="number"
                value={numberMin}
                aria-label="Minimum number"
                placeholder="Minimum"
                onChange={(event) => setNumberMin(event.target.value)}
              />
              <Input
                type="number"
                value={numberMax}
                aria-label="Maximum number"
                placeholder="Maximum"
                onChange={(event) => setNumberMax(event.target.value)}
              />
            </div>
          )}
          {mode === 'date' && (
            <div className="grid grid-cols-2 gap-2">
              <DatePicker label="From" value={dateFrom} onChange={setDateFrom} />
              <DatePicker
                label="To"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={setDateTo}
              />
            </div>
          )}
          {mode === 'color' && (
            <div className="space-y-2">
              <Select
                value={colorKind}
                onValueChange={(value) => {
                  setColorKind(value as ColorKind);
                  setSelectedColors(new Set());
                }}
              >
                <SelectTrigger className="w-full" aria-label="Color source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="background">Fill color</SelectItem>
                  <SelectItem value="text">Text color</SelectItem>
                </SelectContent>
              </Select>
              <div className="grid grid-cols-6 gap-2">
                {availableColors.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className="relative size-8 rounded-md border border-border"
                    style={{ backgroundColor: color }}
                    aria-label={`${selectedColors.has(color) ? 'Remove' : 'Keep'} ${color}`}
                    onClick={() =>
                      setSelectedColors((current) => {
                        const next = new Set(current);
                        if (next.has(color)) next.delete(color);
                        else next.add(color);
                        return next;
                      })
                    }
                  >
                    {selectedColors.has(color) && (
                      <Check className="absolute inset-1.5 size-4 rounded bg-background/80 text-foreground" />
                    )}
                  </button>
                ))}
              </div>
              {availableColors.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  No explicit colors in this column.
                </div>
              )}
            </div>
          )}
        </PopoverPanelBody>
        <label className="mx-3 mb-3 flex items-center gap-2 text-[12.5px]">
          <Checkbox
            checked={hideBlanks}
            onCheckedChange={(checked) => setHideBlanks(checked === true)}
          />
          Hide blank cells
        </label>
        <PopoverPanelFooter
          start={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!active}
              onClick={() => {
                onApply(null);
                setOpen(false);
              }}
            >
              <RotateCcw />
              Clear filter
            </Button>
          }
        >
          <Button
            type="button"
            size="sm"
            onClick={() => {
              apply();
              setOpen(false);
            }}
          >
            Apply
          </Button>
        </PopoverPanelFooter>
      </PopoverPanel>
    </Popover>
  );
}
