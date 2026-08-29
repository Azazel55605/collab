import * as React from 'react';

import { Check, Pipette } from 'lucide-react';

import { clampColorChannel, hexToHsva, type HsvaColor, hsvaToHex, normalizeHex } from '@/lib/color';
import { cn } from '@/lib/utils';

import { Button } from './button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from './field';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from './input-group';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from './popover';
import { Slider } from './slider';

const DEFAULT_COLORS = [
  '#ffffff',
  '#e5e7eb',
  '#94a3b8',
  '#1f2933',
  '#7c3aed',
  '#2563eb',
  '#0e7490',
  '#1a7f37',
  '#b7791f',
  '#ea580c',
  '#c0392b',
  '#be185d',
];

interface ColorPickerProps {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  colors?: string[];
  allowAlpha?: boolean;
  className?: string;
  align?: 'start' | 'center' | 'end';
  trigger?: React.ReactElement;
}

function colorChannels(color: HsvaColor): { red: number; green: number; blue: number } {
  const hex = hsvaToHex({ ...color, a: 1 }, false);
  return {
    red: Number.parseInt(hex.slice(1, 3), 16),
    green: Number.parseInt(hex.slice(3, 5), 16),
    blue: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function checkerboardBackground(): string {
  return [
    'linear-gradient(45deg, var(--muted) 25%, transparent 25%)',
    'linear-gradient(-45deg, var(--muted) 25%, transparent 25%)',
    'linear-gradient(45deg, transparent 75%, var(--muted) 75%)',
    'linear-gradient(-45deg, transparent 75%, var(--muted) 75%)',
  ].join(',');
}

function ColorPicker({
  value,
  onValueChange,
  disabled = false,
  label,
  colors = DEFAULT_COLORS,
  allowAlpha = false,
  className,
  align = 'end',
  trigger,
}: ColorPickerProps) {
  const initial = React.useMemo(() => hexToHsva(value), [value]);
  const [open, setOpen] = React.useState(false);
  const [color, setColor] = React.useState(initial);
  const [draft, setDraft] = React.useState(() => hsvaToHex(initial, allowAlpha));
  const planeRef = React.useRef<HTMLDivElement | null>(null);
  const inputId = React.useId();

  React.useEffect(() => {
    const next = hexToHsva(value);
    setColor(next);
    setDraft(hsvaToHex(next, allowAlpha));
  }, [allowAlpha, value]);

  const emit = React.useCallback(
    (next: HsvaColor) => {
      const normalized = hsvaToHex(next, allowAlpha);
      setColor(next);
      setDraft(normalized);
      onValueChange(normalized);
    },
    [allowAlpha, onValueChange],
  );

  const commitDraft = React.useCallback(() => {
    const normalized = normalizeHex(draft, allowAlpha);
    if (!normalized) {
      setDraft(hsvaToHex(color, allowAlpha));
      return;
    }
    const next = hexToHsva(normalized);
    setColor(next);
    setDraft(normalized);
    onValueChange(normalized);
  }, [allowAlpha, color, draft, onValueChange]);

  const updatePlane = React.useCallback(
    (clientX: number, clientY: number) => {
      const bounds = planeRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
      emit({
        ...color,
        s: clampColorChannel(((clientX - bounds.left) / bounds.width) * 100, 0, 100),
        v: clampColorChannel(100 - ((clientY - bounds.top) / bounds.height) * 100, 0, 100),
      });
    },
    [color, emit],
  );

  const selectedHex = hsvaToHex(color, allowAlpha);
  const opaqueHex = hsvaToHex({ ...color, a: 1 }, false);
  const channels = colorChannels(color);
  const useDarkCheck =
    (channels.red * 299 + channels.green * 587 + channels.blue * 114) / 1000 > 150;
  const alphaPercent = Math.round(color.a * 100);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-label={label}
            className={cn('h-8 justify-start px-2', className)}
          >
            <span
              aria-hidden
              className="relative size-4 overflow-hidden rounded-sm border border-foreground/20 shadow-inner"
              style={{ backgroundImage: checkerboardBackground(), backgroundSize: '8px 8px' }}
            >
              <span className="absolute inset-0" style={{ backgroundColor: selectedHex }} />
            </span>
            <span className="font-mono text-[10px] uppercase text-muted-foreground">
              {selectedHex}
            </span>
            <Pipette data-icon="inline-end" className="ml-auto text-muted-foreground" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-72 gap-3 p-3">
        <PopoverHeader>
          <PopoverTitle>{label}</PopoverTitle>
          <PopoverDescription>Choose any hue, saturation, and brightness.</PopoverDescription>
        </PopoverHeader>

        <div
          ref={planeRef}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={`${label} saturation and brightness`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(color.s)}
          aria-valuetext={`${Math.round(color.s)}% saturation, ${Math.round(color.v)}% brightness`}
          className="relative h-36 w-full touch-none overflow-hidden rounded-lg border border-foreground/10 shadow-inner outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          style={{
            backgroundColor: `hsl(${color.h} 100% 50%)`,
            backgroundImage:
              'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
          }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            updatePlane(event.clientX, event.clientY);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              updatePlane(event.clientX, event.clientY);
            }
          }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 10 : 1;
            let next = color;
            if (event.key === 'ArrowLeft')
              next = { ...color, s: clampColorChannel(color.s - step, 0, 100) };
            else if (event.key === 'ArrowRight')
              next = { ...color, s: clampColorChannel(color.s + step, 0, 100) };
            else if (event.key === 'ArrowUp')
              next = { ...color, v: clampColorChannel(color.v + step, 0, 100) };
            else if (event.key === 'ArrowDown')
              next = { ...color, v: clampColorChannel(color.v - step, 0, 100) };
            else if (event.key === 'Home') next = { ...color, s: 0, v: 100 };
            else if (event.key === 'End') next = { ...color, s: 100, v: 0 };
            else return;
            event.preventDefault();
            emit(next);
          }}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_1px_4px_rgb(0_0_0/65%)]"
            style={{ left: `${color.s}%`, top: `${100 - color.v}%`, backgroundColor: opaqueHex }}
          />
        </div>

        <FieldGroup className="gap-3">
          <Field className="gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor={`${inputId}-hue`} className="text-xs">
                Hue
              </FieldLabel>
              <span className="font-mono text-[10px] text-muted-foreground">
                {Math.round(color.h)}°
              </span>
            </div>
            <Slider
              id={`${inputId}-hue`}
              aria-label={`${label} hue`}
              value={[color.h]}
              min={0}
              max={360}
              step={1}
              onValueChange={([hue]) => emit({ ...color, h: hue })}
              className="[&_[data-slot=slider-track]]:bg-[linear-gradient(to_right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)] [&_[data-slot=slider-range]]:bg-transparent"
            />
          </Field>

          {allowAlpha ? (
            <Field className="gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor={`${inputId}-alpha`} className="text-xs">
                  Opacity
                </FieldLabel>
                <span className="font-mono text-[10px] text-muted-foreground">{alphaPercent}%</span>
              </div>
              <div
                className="rounded-full"
                style={{ backgroundImage: checkerboardBackground(), backgroundSize: '8px 8px' }}
              >
                <Slider
                  id={`${inputId}-alpha`}
                  aria-label={`${label} opacity`}
                  value={[alphaPercent]}
                  min={0}
                  max={100}
                  step={1}
                  onValueChange={([alpha]) => emit({ ...color, a: alpha / 100 })}
                  className="[&_[data-slot=slider-track]]:bg-[linear-gradient(to_right,transparent,var(--picker-color))] [&_[data-slot=slider-range]]:bg-transparent"
                  style={{ '--picker-color': opaqueHex } as React.CSSProperties}
                />
              </div>
            </Field>
          ) : null}
        </FieldGroup>

        <Field className="gap-1.5">
          <FieldLabel htmlFor={`${inputId}-hex`} className="text-xs">
            Hex value
          </FieldLabel>
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-foreground/10 shadow-sm"
              style={{ backgroundColor: selectedHex, color: useDarkCheck ? '#111827' : '#ffffff' }}
            >
              <Check />
            </span>
            <InputGroup>
              <InputGroupAddon>
                <InputGroupText>#</InputGroupText>
              </InputGroupAddon>
              <InputGroupInput
                id={`${inputId}-hex`}
                value={draft.replace(/^#/, '')}
                aria-label={`${label} hex`}
                aria-invalid={!normalizeHex(draft, allowAlpha)}
                spellCheck={false}
                className="font-mono text-xs uppercase"
                maxLength={allowAlpha ? 8 : 6}
                onChange={(event) => setDraft(`#${event.target.value.replace(/^#/, '')}`)}
                onBlur={commitDraft}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitDraft();
                  }
                }}
              />
            </InputGroup>
            <Button type="button" size="sm" variant="secondary" onClick={commitDraft}>
              Apply
            </Button>
          </div>
          <FieldDescription className="text-[10px]">
            RGB {channels.red}, {channels.green}, {channels.blue}
            {allowAlpha ? ` · ${alphaPercent}%` : ''}
          </FieldDescription>
        </Field>

        {colors.length > 0 ? (
          <ColorPresets
            label={label}
            colors={colors}
            value={selectedHex}
            onChange={emit}
            allowAlpha={allowAlpha}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function ColorPresets({
  label,
  colors,
  value,
  allowAlpha,
  onChange,
}: {
  label: string;
  colors: string[];
  value: string;
  allowAlpha: boolean;
  onChange: (color: HsvaColor) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium">Presets</span>
      <div className="grid grid-cols-8 gap-1.5" role="radiogroup" aria-label={`${label} palette`}>
        {colors.map((preset) => {
          const normalized = normalizeHex(preset, allowAlpha);
          if (!normalized) return null;
          const selected = normalized.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={preset}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${label} ${preset}`}
              onClick={() => onChange(hexToHsva(normalized))}
              className="relative size-7 rounded-md border border-foreground/15 shadow-sm outline-none transition-transform app-motion-fast hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring"
              style={{ backgroundColor: normalized }}
            >
              {selected ? (
                <Check className="absolute inset-0 m-auto text-white drop-shadow-[0_1px_2px_rgb(0_0_0/90%)]" />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { ColorPicker, hexToHsva, hsvaToHex, normalizeHex };
export type { ColorPickerProps, HsvaColor };
