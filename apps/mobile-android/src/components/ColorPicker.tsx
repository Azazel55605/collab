import { Check, Pipette } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import {
  clampColorChannel,
  hexToHsva,
  hsvaToHex,
  normalizeHex,
  type HsvaColor,
} from '../../../../src/lib/color';

const PRESETS = [
  '#ffffff', '#e5e7eb', '#94a3b8', '#1f2933',
  '#7c3aed', '#2563eb', '#0e7490', '#1a7f37',
  '#b7791f', '#ea580c', '#c0392b', '#be185d',
];

export function ColorPicker({
  label,
  value,
  disabled,
  onValueChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState(() => hexToHsva(value));
  const [draft, setDraft] = useState(() => hsvaToHex(hexToHsva(value), false));
  const planeRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const next = hexToHsva(value);
    setColor(next);
    setDraft(hsvaToHex(next, false));
  }, [value]);

  const emit = (next: HsvaColor) => {
    const hex = hsvaToHex(next, false);
    setColor(next);
    setDraft(hex);
    onValueChange(hex);
  };

  const updatePlane = (clientX: number, clientY: number) => {
    const bounds = planeRef.current?.getBoundingClientRect();
    if (!bounds) return;
    emit({
      ...color,
      s: clampColorChannel(((clientX - bounds.left) / bounds.width) * 100, 0, 100),
      v: clampColorChannel(100 - ((clientY - bounds.top) / bounds.height) * 100, 0, 100),
    });
  };

  const updateHue = (clientX: number) => {
    const bounds = hueRef.current?.getBoundingClientRect();
    if (!bounds) return;
    emit({ ...color, h: clampColorChannel(((clientX - bounds.left) / bounds.width) * 360, 0, 360) });
  };

  const adjust = (event: KeyboardEvent, channel: 'plane' | 'hue') => {
    const step = event.shiftKey ? 10 : 1;
    let next = color;
    if (channel === 'hue') {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = { ...color, h: color.h - step };
      else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = { ...color, h: color.h + step };
      else return;
    } else if (event.key === 'ArrowLeft') next = { ...color, s: clampColorChannel(color.s - step, 0, 100) };
    else if (event.key === 'ArrowRight') next = { ...color, s: clampColorChannel(color.s + step, 0, 100) };
    else if (event.key === 'ArrowUp') next = { ...color, v: clampColorChannel(color.v + step, 0, 100) };
    else if (event.key === 'ArrowDown') next = { ...color, v: clampColorChannel(color.v - step, 0, 100) };
    else return;
    event.preventDefault();
    emit(next);
  };

  const selected = hsvaToHex(color, false);
  const commitDraft = () => {
    const normalized = normalizeHex(draft, false);
    if (!normalized) {
      setDraft(selected);
      return;
    }
    emit(hexToHsva(normalized));
  };

  return (
    <div className="mobile-color-picker">
      <button
        type="button"
        className="mobile-color-trigger"
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="mobile-color-preview" style={{ backgroundColor: selected }} />
        <code>{selected}</code>
        <Pipette size={17} aria-hidden />
      </button>
      {open ? (
        <div className="mobile-color-panel" aria-label={`${label} picker`}>
          <div
            ref={planeRef}
            className="mobile-color-plane"
            role="slider"
            tabIndex={0}
            aria-label={`${label} saturation and brightness`}
            aria-valuenow={Math.round(color.s)}
            aria-valuetext={`${Math.round(color.s)}% saturation, ${Math.round(color.v)}% brightness`}
            style={{
              backgroundColor: `hsl(${color.h} 100% 50%)`,
              backgroundImage: 'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              updatePlane(event.clientX, event.clientY);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) updatePlane(event.clientX, event.clientY);
            }}
            onKeyDown={(event) => adjust(event, 'plane')}
          >
            <span style={{ left: `${color.s}%`, top: `${100 - color.v}%`, backgroundColor: selected }} />
          </div>
          <div
            ref={hueRef}
            className="mobile-color-hue"
            role="slider"
            tabIndex={0}
            aria-label={`${label} hue`}
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(color.h)}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              updateHue(event.clientX);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) updateHue(event.clientX);
            }}
            onKeyDown={(event) => adjust(event, 'hue')}
          >
            <span style={{ left: `${(color.h / 360) * 100}%` }} />
          </div>
          <div className="mobile-color-hex">
            <span>#</span>
            <input
              aria-label={`${label} hex`}
              value={draft.replace(/^#/, '')}
              maxLength={6}
              spellCheck={false}
              onChange={(event) => setDraft(`#${event.target.value.replace(/^#/, '')}`)}
              onBlur={commitDraft}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitDraft();
              }}
            />
          </div>
          <div className="mobile-color-presets" role="radiogroup" aria-label={`${label} presets`}>
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                role="radio"
                aria-checked={selected === preset}
                aria-label={`${label} ${preset}`}
                style={{ backgroundColor: preset }}
                onClick={() => emit(hexToHsva(preset))}
              >
                {selected === preset ? <Check size={14} aria-hidden /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
