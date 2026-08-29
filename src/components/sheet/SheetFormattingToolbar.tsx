import { type ComponentProps, type ReactNode, useEffect, useState } from 'react';

import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  ClipboardCopy,
  ClipboardPaste,
  Eraser,
  IndentDecrease,
  IndentIncrease,
  Italic,
  MessageSquare,
  PaintBucket,
  PanelsTopLeft,
  Scissors,
  Strikethrough,
  Underline,
  WrapText,
} from 'lucide-react';

import type { SheetPasteMode } from '../../lib/sheet/clipboard';
import type { SheetNumberFormat, SheetNumberFormatKind, SheetStyle } from '../../types/sheet';
import { Button } from '../ui/button';
import { ColorPicker } from '../ui/color-picker';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Textarea } from '../ui/textarea';

interface Props {
  style: SheetStyle;
  disabled?: boolean;
  onPatch: (patch: Partial<SheetStyle>) => void;
  onClear: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: (mode: SheetPasteMode) => void;
  note?: string;
  onNoteChange: (note: string | null) => void;
}

const FORMAT_LABELS: Record<SheetNumberFormatKind, string> = {
  general: 'General',
  number: 'Number',
  percent: 'Percent',
  currency: 'Currency',
  date: 'Date',
  time: 'Time',
  datetime: 'Date and time',
  text: 'Plain text',
  custom: 'Custom',
};

function ToolButton({ pressed, ...props }: ComponentProps<typeof Button> & { pressed?: boolean }) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant={pressed ? 'secondary' : 'ghost'}
      aria-pressed={pressed}
      {...props}
    />
  );
}

function ColorMenu({
  label,
  value,
  icon,
  disabled,
  onChange,
}: {
  label: string;
  value?: string;
  icon: ReactNode;
  disabled?: boolean;
  onChange: (color: string | undefined) => void;
}) {
  return (
    <ColorPicker
      label={label}
      value={value ?? '#111827'}
      disabled={disabled}
      align="start"
      onValueChange={(color) => onChange(color)}
      trigger={
        <ToolButton aria-label={label} title={label} disabled={disabled}>
          {icon}
          <span
            className="absolute bottom-0.5 h-0.5 w-4"
            style={{ backgroundColor: value ?? 'currentColor' }}
          />
        </ToolButton>
      }
    />
  );
}

export default function SheetFormattingToolbar({
  style,
  disabled,
  onPatch,
  onClear,
  onCopy,
  onCut,
  onPaste,
  note,
  onNoteChange,
}: Props) {
  const [customPattern, setCustomPattern] = useState(style.numberFormat?.pattern ?? '0.00');
  const [noteDraft, setNoteDraft] = useState(note ?? '');
  useEffect(() => setNoteDraft(note ?? ''), [note]);
  const numberFormat: SheetNumberFormat = style.numberFormat ?? { kind: 'general' };
  const updateNumberFormat = (patch: Partial<SheetNumberFormat>) => {
    onPatch({ numberFormat: { ...numberFormat, ...patch } });
  };

  return (
    <div
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 bg-muted/15 px-2 py-1 scrollbar-none"
      role="toolbar"
      aria-label="Cell formatting"
    >
      <ToolButton aria-label="Copy cells" title="Copy cells" onClick={onCopy}>
        <ClipboardCopy />
      </ToolButton>
      <ToolButton aria-label="Cut cells" title="Cut cells" disabled={disabled} onClick={onCut}>
        <Scissors />
      </ToolButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ToolButton aria-label="Paste cells" title="Paste cells" disabled={disabled}>
            <ClipboardPaste />
          </ToolButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={() => onPaste('all')}>Paste all</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onPaste('values')}>Paste values only</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onPaste('formulas')}>
            Paste formulas only
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onPaste('formatting')}>
            Paste formatting only
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="mx-1 h-5 w-px bg-border" />
      <Select
        value={style.fontFamily ?? 'sans-serif'}
        disabled={disabled}
        onValueChange={(fontFamily) => onPatch({ fontFamily })}
      >
        <SelectTrigger size="sm" className="w-32" aria-label="Font family">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="sans-serif">Sans serif</SelectItem>
          <SelectItem value="Georgia, serif">Serif</SelectItem>
          <SelectItem value="JetBrains Mono, monospace">Monospace</SelectItem>
        </SelectContent>
      </Select>
      <Select
        value={String(style.fontSize ?? 13)}
        disabled={disabled}
        onValueChange={(fontSize) => onPatch({ fontSize: Number(fontSize) })}
      >
        <SelectTrigger size="sm" className="w-16" aria-label="Font size">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {[10, 11, 12, 13, 14, 16, 18, 20, 24, 32].map((size) => (
            <SelectItem key={size} value={String(size)}>
              {size}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="mx-1 h-5 w-px bg-border" />
      <ToolButton
        aria-label="Bold"
        title="Bold"
        pressed={style.bold}
        disabled={disabled}
        onClick={() => onPatch({ bold: !style.bold })}
      >
        <Bold />
      </ToolButton>
      <ToolButton
        aria-label="Italic"
        title="Italic"
        pressed={style.italic}
        disabled={disabled}
        onClick={() => onPatch({ italic: !style.italic })}
      >
        <Italic />
      </ToolButton>
      <ToolButton
        aria-label="Underline"
        title="Underline"
        pressed={style.underline}
        disabled={disabled}
        onClick={() => onPatch({ underline: !style.underline })}
      >
        <Underline />
      </ToolButton>
      <ToolButton
        aria-label="Strikethrough"
        title="Strikethrough"
        pressed={style.strikethrough}
        disabled={disabled}
        onClick={() => onPatch({ strikethrough: !style.strikethrough })}
      >
        <Strikethrough />
      </ToolButton>
      <ColorMenu
        label="Text color"
        value={style.color}
        icon={<Baseline />}
        disabled={disabled}
        onChange={(color) => onPatch({ color })}
      />
      <ColorMenu
        label="Fill color"
        value={style.backgroundColor}
        icon={<PaintBucket />}
        disabled={disabled}
        onChange={(backgroundColor) => onPatch({ backgroundColor })}
      />

      <div className="mx-1 h-5 w-px bg-border" />
      <ToolButton
        aria-label="Align left"
        title="Align left"
        pressed={style.horizontalAlign === 'left'}
        disabled={disabled}
        onClick={() => onPatch({ horizontalAlign: 'left' })}
      >
        <AlignLeft />
      </ToolButton>
      <ToolButton
        aria-label="Align center"
        title="Align center"
        pressed={style.horizontalAlign === 'center'}
        disabled={disabled}
        onClick={() => onPatch({ horizontalAlign: 'center' })}
      >
        <AlignCenter />
      </ToolButton>
      <ToolButton
        aria-label="Align right"
        title="Align right"
        pressed={style.horizontalAlign === 'right'}
        disabled={disabled}
        onClick={() => onPatch({ horizontalAlign: 'right' })}
      >
        <AlignRight />
      </ToolButton>
      <ToolButton
        aria-label="Wrap text"
        title="Wrap text"
        pressed={style.wrap}
        disabled={disabled}
        onClick={() => onPatch({ wrap: !style.wrap })}
      >
        <WrapText />
      </ToolButton>
      <ToolButton
        aria-label="Decrease indent"
        title="Decrease indent"
        disabled={disabled || !style.indent}
        onClick={() => onPatch({ indent: Math.max(0, (style.indent ?? 0) - 1) })}
      >
        <IndentDecrease />
      </ToolButton>
      <ToolButton
        aria-label="Increase indent"
        title="Increase indent"
        disabled={disabled}
        onClick={() => onPatch({ indent: Math.min(20, (style.indent ?? 0) + 1) })}
      >
        <IndentIncrease />
      </ToolButton>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ToolButton aria-label="Cell borders" title="Cell borders" disabled={disabled}>
            <PanelsTopLeft />
          </ToolButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onSelect={() =>
              onPatch({
                borders: {
                  top: { style: 'thin' },
                  right: { style: 'thin' },
                  bottom: { style: 'thin' },
                  left: { style: 'thin' },
                },
              })
            }
          >
            All borders
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onPatch({ borders: { bottom: { style: 'thin' } } })}>
            Bottom border
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onPatch({ borders: {} })}>No borders</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="mx-1 h-5 w-px bg-border" />
      <Select
        value={numberFormat.kind}
        disabled={disabled}
        onValueChange={(kind) => updateNumberFormat({ kind: kind as SheetNumberFormatKind })}
      >
        <SelectTrigger size="sm" className="w-32" aria-label="Number format">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(FORMAT_LABELS).map(([kind, label]) => (
            <SelectItem key={kind} value={kind}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {numberFormat.kind === 'currency' && (
        <Select
          value={numberFormat.currencyCode ?? 'EUR'}
          disabled={disabled}
          onValueChange={(currencyCode) => updateNumberFormat({ currencyCode })}
        >
          <SelectTrigger size="sm" className="w-20" aria-label="Currency">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {['EUR', 'USD', 'GBP', 'JPY'].map((code) => (
              <SelectItem key={code} value={code}>
                {code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {['number', 'percent', 'currency'].includes(numberFormat.kind) && (
        <div className="flex items-center rounded-md border border-border/60">
          <ToolButton
            aria-label="Decrease decimals"
            title="Decrease decimals"
            disabled={disabled}
            onClick={() =>
              updateNumberFormat({ decimals: Math.max(0, (numberFormat.decimals ?? 2) - 1) })
            }
          >
            .0
          </ToolButton>
          <ToolButton
            aria-label="Increase decimals"
            title="Increase decimals"
            disabled={disabled}
            onClick={() =>
              updateNumberFormat({ decimals: Math.min(12, (numberFormat.decimals ?? 2) + 1) })
            }
          >
            .00
          </ToolButton>
        </div>
      )}
      {numberFormat.kind === 'custom' && (
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" size="sm" variant="outline" disabled={disabled}>
              Pattern
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64">
            <label className="text-xs font-medium" htmlFor="sheet-custom-format">
              Custom number pattern
            </label>
            <div className="flex gap-2">
              <Input
                id="sheet-custom-format"
                value={customPattern}
                onChange={(event) => setCustomPattern(event.target.value)}
                className="h-8 font-mono text-xs"
              />
              <Button size="sm" onClick={() => updateNumberFormat({ pattern: customPattern })}>
                Apply
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      )}

      <div className="mx-1 h-5 w-px bg-border" />
      <Popover>
        <PopoverTrigger asChild>
          <ToolButton
            aria-label={note ? 'Edit cell note' : 'Add cell note'}
            title={note ? 'Edit cell note' : 'Add cell note'}
            pressed={Boolean(note)}
            disabled={disabled}
          >
            <MessageSquare />
          </ToolButton>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72">
          <label className="text-xs font-medium" htmlFor="sheet-cell-note">
            Cell note
          </label>
          <Textarea
            id="sheet-cell-note"
            value={noteDraft}
            maxLength={32768}
            placeholder="Add context without changing the cell value"
            onChange={(event) => setNoteDraft(event.target.value)}
          />
          <div className="mt-2 flex justify-end gap-2">
            {note && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setNoteDraft('');
                  onNoteChange(null);
                }}
              >
                Remove
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              aria-label="Save cell note"
              onClick={() => onNoteChange(noteDraft.trim() || null)}
            >
              Save
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <ToolButton
        aria-label="Clear formatting"
        title="Clear formatting"
        disabled={disabled}
        onClick={onClear}
      >
        <Eraser />
      </ToolButton>
    </div>
  );
}
