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
import { documentTopBarGroupClass } from '../layout/DocumentTopBar';
import { Button } from '../ui/button';
import { ColorPicker } from '../ui/color-picker';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Popover, PopoverTrigger } from '../ui/popover';
import { PopoverField, PopoverForm, PopoverPanel } from '../ui/popover-patterns';
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
  const [patternOpen, setPatternOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  useEffect(() => setNoteDraft(note ?? ''), [note]);
  const numberFormat: SheetNumberFormat = style.numberFormat ?? { kind: 'general' };
  const updateNumberFormat = (patch: Partial<SheetNumberFormat>) => {
    onPatch({ numberFormat: { ...numberFormat, ...patch } });
  };

  return (
    // Rendered inside the document tool strip: each group folds into "More" as a unit.
    <>
      <div className={documentTopBarGroupClass} role="group" aria-label="Clipboard">
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
            <DropdownMenuItem onSelect={() => onPaste('values')}>
              Paste values only
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onPaste('formulas')}>
              Paste formulas only
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onPaste('formatting')}>
              Paste formatting only
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className={documentTopBarGroupClass} role="group" aria-label="Font">
        <Select
          value={style.fontFamily ?? 'sans-serif'}
          disabled={disabled}
          onValueChange={(fontFamily) => onPatch({ fontFamily })}
        >
          <SelectTrigger variant="ghost" size="sm" className="w-32" aria-label="Font family">
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
          <SelectTrigger variant="ghost" size="sm" className="w-16" aria-label="Font size">
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
      </div>
      <div className={documentTopBarGroupClass} role="group" aria-label="Text style">
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
      </div>
      <div className={documentTopBarGroupClass} role="group" aria-label="Alignment">
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
            <DropdownMenuItem onSelect={() => onPatch({ borders: {} })}>
              No borders
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className={documentTopBarGroupClass} role="group" aria-label="Number format">
        <Select
          value={numberFormat.kind}
          disabled={disabled}
          onValueChange={(kind) => updateNumberFormat({ kind: kind as SheetNumberFormatKind })}
        >
          <SelectTrigger variant="ghost" size="sm" className="w-32" aria-label="Number format">
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
            <SelectTrigger variant="ghost" size="sm" className="w-20" aria-label="Currency">
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
          <div className="flex items-center">
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
          <Popover open={patternOpen} onOpenChange={setPatternOpen}>
            <PopoverTrigger asChild>
              <Button type="button" size="sm" variant="outline" disabled={disabled}>
                Pattern
              </Button>
            </PopoverTrigger>
            <PopoverPanel align="start" className="w-72">
              <PopoverForm
                title="Custom number format"
                submitLabel="Apply"
                submitDisabled={!customPattern.trim()}
                onCancel={() => setPatternOpen(false)}
                onSubmit={() => {
                  updateNumberFormat({ pattern: customPattern });
                  setPatternOpen(false);
                }}
              >
                <PopoverField label="Pattern" htmlFor="sheet-custom-format">
                  <Input
                    id="sheet-custom-format"
                    autoFocus
                    value={customPattern}
                    onChange={(event) => setCustomPattern(event.target.value)}
                    placeholder='#,##0.00 "€"'
                    className="font-mono text-xs"
                  />
                </PopoverField>
                <p className="text-xs text-muted-foreground">
                  0 digit · # optional digit · , thousands · &quot;text&quot; literal
                </p>
              </PopoverForm>
            </PopoverPanel>
          </Popover>
        )}
      </div>
      <div className={documentTopBarGroupClass} role="group" aria-label="Notes">
        <Popover
          open={noteOpen}
          onOpenChange={(next) => {
            setNoteOpen(next);
            if (next) setNoteDraft(note ?? '');
          }}
        >
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
          <PopoverPanel align="start" className="w-80">
            <PopoverForm
              title="Cell note"
              meta="Shown on hover"
              submitLabel="Save note"
              onCancel={() => setNoteOpen(false)}
              onSubmit={() => {
                onNoteChange(noteDraft.trim() || null);
                setNoteOpen(false);
              }}
              start={
                note ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => {
                      setNoteDraft('');
                      onNoteChange(null);
                      setNoteOpen(false);
                    }}
                  >
                    Remove
                  </Button>
                ) : undefined
              }
            >
              <Textarea
                aria-label="Cell note"
                autoFocus
                rows={4}
                value={noteDraft}
                maxLength={32768}
                placeholder="Add context without changing the cell value"
                onChange={(event) => setNoteDraft(event.target.value)}
                onKeyDown={(event) => {
                  // Ctrl+Enter saves; plain Enter adds a line.
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
            </PopoverForm>
          </PopoverPanel>
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
    </>
  );
}
