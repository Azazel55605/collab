import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
} from '@codemirror/view';
import { toast } from 'sonner';

import type { ColorPreviewFormat } from '../../store/uiStore';

type ClipboardColorFormat = 'original' | 'hex' | 'rgb' | 'hsl';

const COLOR_COPY_FORMAT_LABELS: Record<ClipboardColorFormat, string> = {
  original: 'Original',
  hex: 'Hex',
  rgb: 'RGB',
  hsl: 'HSL',
};

let activeColorPreviewPopover: HTMLDivElement | null = null;
let removeColorPreviewPopoverListeners: (() => void) | null = null;
let colorPreviewCloseTimer: number | null = null;

function cancelScheduledColorPreviewClose() {
  if (colorPreviewCloseTimer != null) {
    window.clearTimeout(colorPreviewCloseTimer);
    colorPreviewCloseTimer = null;
  }
}

function scheduleColorPreviewClose() {
  cancelScheduledColorPreviewClose();
  colorPreviewCloseTimer = window.setTimeout(() => {
    colorPreviewCloseTimer = null;
    closeColorPreviewPopover();
  }, 140);
}

class ColorSwatchWidget extends WidgetType {
  constructor(
    private readonly original: string,
    private readonly parsed: ParsedColor,
  ) {
    super();
  }

  eq(other: ColorSwatchWidget) {
    return this.original === other.original && this.parsed.css === other.parsed.css;
  }

  ignoreEvent() {
    return false;
  }

  toDOM() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-color-preview-swatch';
    button.setAttribute('aria-label', `Copy color ${this.original}`);
    button.title = `Copy ${this.original}`;
    button.style.backgroundColor = this.parsed.css;
    button.style.borderColor = this.parsed.css;
    button.addEventListener('mouseenter', () => {
      openColorPreviewPopover(button, this.original, this.parsed);
    });
    button.addEventListener('focus', () => {
      openColorPreviewPopover(button, this.original, this.parsed);
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void copyColorValue(this.original, 'Original');
    });
    return button;
  }
}

type ParsedColor = {
  css: string;
  r: number;
  g: number;
  b: number;
  a: number;
};

type ColorPreviewMatch = {
  from: number;
  to: number;
  source: string;
  parsed: ParsedColor;
};

const COLOR_FORMAT_REGEXES: Record<ColorPreviewFormat, RegExp> = {
  hex: /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g,
  rgb: /\brgba?\(\s*[^()\n]{1,96}\)/gi,
  hsl: /\bhsla?\(\s*[^()\n]{1,96}\)/gi,
  oklch: /\boklch\(\s*[^()\n]{1,96}\)/gi,
  oklab: /\boklab\(\s*[^()\n]{1,96}\)/gi,
};

export function tryParseColor(value: string): ParsedColor | null {
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && !CSS.supports('color', value)) {
    return null;
  }
  const probe = document.createElement('span');
  probe.style.color = value;
  const css = probe.style.color;
  if (!css) return null;
  const rgba = css.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgba) return { css, r: 127, g: 127, b: 127, a: 1 };
  const parts = rgba[1].split(',').map((part) => part.trim());
  if (parts.length < 3) return null;
  const [r, g, b] = parts.slice(0, 3).map((part) => Number.parseFloat(part));
  const a = parts[3] != null ? Number.parseFloat(parts[3]) : 1;
  if ([r, g, b, a].some((part) => Number.isNaN(part))) return null;
  return { css, r, g, b, a };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function channelToHex(value: number) {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
}

function alphaToHex(value: number) {
  return clamp(Math.round(value * 255), 0, 255).toString(16).padStart(2, '0');
}

export function formatColorForClipboard(
  parsed: ParsedColor,
  format: ClipboardColorFormat,
  original: string,
) {
  if (format === 'original') return original;
  if (format === 'hex') {
    const base = `#${channelToHex(parsed.r)}${channelToHex(parsed.g)}${channelToHex(parsed.b)}`;
    return parsed.a >= 0.999 ? base : `${base}${alphaToHex(parsed.a)}`;
  }
  if (format === 'rgb') {
    return parsed.a >= 0.999
      ? `rgb(${Math.round(parsed.r)}, ${Math.round(parsed.g)}, ${Math.round(parsed.b)})`
      : `rgba(${Math.round(parsed.r)}, ${Math.round(parsed.g)}, ${Math.round(parsed.b)}, ${Number(parsed.a.toFixed(3))})`;
  }

  const r = parsed.r / 255;
  const g = parsed.g / 255;
  const b = parsed.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  let saturation = 0;

  if (delta > 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    switch (max) {
      case r:
        hue = ((g - b) / delta) % 6;
        break;
      case g:
        hue = (b - r) / delta + 2;
        break;
      default:
        hue = (r - g) / delta + 4;
        break;
    }
    hue *= 60;
    if (hue < 0) hue += 360;
  }

  const h = Math.round(hue);
  const s = Math.round(saturation * 100);
  const l = Math.round(lightness * 100);
  return parsed.a >= 0.999
    ? `hsl(${h}deg ${s}% ${l}%)`
    : `hsl(${h}deg ${s}% ${l}% / ${Number(parsed.a.toFixed(3))})`;
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('Clipboard unavailable');
  }
}

async function copyColorValue(value: string, label: string) {
  try {
    await copyTextToClipboard(value);
    toast.success(`${label} color copied`, { description: value });
  } catch (error) {
    toast.error('Could not copy color', {
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

function closeColorPreviewPopover() {
  cancelScheduledColorPreviewClose();
  activeColorPreviewPopover?.remove();
  activeColorPreviewPopover = null;
  removeColorPreviewPopoverListeners?.();
  removeColorPreviewPopoverListeners = null;
}

function buildColorPreviewAction(
  label: string,
  value: string,
  onSelect: () => void,
) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.style.display = 'flex';
  button.style.alignItems = 'center';
  button.style.justifyContent = 'space-between';
  button.style.gap = '12px';
  button.style.width = '100%';
  button.style.padding = '6px 8px';
  button.style.border = '0';
  button.style.borderRadius = '8px';
  button.style.background = 'transparent';
  button.style.color = 'var(--popover-foreground)';
  button.style.font = '12px/1.35 var(--app-font-sans, system-ui)';
  button.style.cursor = 'pointer';
  button.style.textAlign = 'left';

  const valueEl = document.createElement('span');
  valueEl.textContent = value;
  valueEl.style.color = 'var(--muted-foreground)';
  valueEl.style.fontFamily = 'var(--app-font-mono, monospace)';
  valueEl.style.fontSize = '11px';

  button.appendChild(valueEl);
  button.addEventListener('mouseenter', () => {
    button.style.background = 'color-mix(in oklch, var(--primary) 12%, transparent)';
  });
  button.addEventListener('mouseleave', () => {
    button.style.background = 'transparent';
  });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect();
  });
  return button;
}

function openColorPreviewPopover(
  anchor: HTMLElement,
  original: string,
  parsed: ParsedColor,
) {
  cancelScheduledColorPreviewClose();
  if (activeColorPreviewPopover && activeColorPreviewPopover.dataset.colorPreviewSource === original) {
    return;
  }
  closeColorPreviewPopover();

  const popover = document.createElement('div');
  popover.dataset.colorPreviewPopover = 'true';
  popover.dataset.colorPreviewSource = original;
  popover.style.position = 'fixed';
  popover.style.zIndex = '80';
  popover.style.minWidth = '220px';
  popover.style.padding = '8px';
  popover.style.borderRadius = '12px';
  popover.style.border = '1px solid color-mix(in oklch, var(--border) 70%, transparent)';
  popover.style.background = 'color-mix(in oklch, var(--popover) 96%, transparent)';
  popover.style.boxShadow = '0 18px 42px rgba(0,0,0,0.3)';
  popover.style.backdropFilter = 'blur(12px)';
  popover.style.display = 'flex';
  popover.style.flexDirection = 'column';
  popover.style.gap = '4px';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '8px';
  header.style.padding = '2px 4px 6px';

  const swatch = document.createElement('span');
  swatch.style.width = '12px';
  swatch.style.height = '12px';
  swatch.style.borderRadius = '4px';
  swatch.style.flex = '0 0 auto';
  swatch.style.backgroundColor = parsed.css;
  swatch.style.border = `1px solid ${parsed.css}`;
  swatch.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.08), 0 1px 2px rgba(0,0,0,0.24)';

  const title = document.createElement('div');
  title.textContent = 'Copy color as…';
  title.style.font = '600 12px/1.3 var(--app-font-sans, system-ui)';
  title.style.color = 'var(--popover-foreground)';

  header.append(swatch, title);
  popover.appendChild(header);

  const formats: ClipboardColorFormat[] = ['original', 'hex', 'rgb', 'hsl'];
  for (const format of formats) {
    const value = formatColorForClipboard(parsed, format, original);
    const button = buildColorPreviewAction(COLOR_COPY_FORMAT_LABELS[format], value, () => {
      void copyColorValue(value, COLOR_COPY_FORMAT_LABELS[format]);
      closeColorPreviewPopover();
    });
    popover.appendChild(button);
  }

  document.body.appendChild(popover);
  const anchorRect = anchor.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const top = clamp(anchorRect.bottom + 8, 8, window.innerHeight - popoverRect.height - 8);
  const left = clamp(anchorRect.left, 8, window.innerWidth - popoverRect.width - 8);
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;

  const closeOnPointerDown = (event: MouseEvent) => {
    const target = event.target as Node | null;
    if (target && (popover.contains(target) || anchor.contains(target))) return;
    closeColorPreviewPopover();
  };
  const closeOnEscape = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeColorPreviewPopover();
  };
  const closeOnWindowChange = () => closeColorPreviewPopover();
  const keepOpen = () => cancelScheduledColorPreviewClose();
  const maybeClose = (event: MouseEvent) => {
    const related = event.relatedTarget as Node | null;
    if (related && (popover.contains(related) || anchor.contains(related))) return;
    scheduleColorPreviewClose();
  };

  document.addEventListener('mousedown', closeOnPointerDown, true);
  document.addEventListener('keydown', closeOnEscape, true);
  window.addEventListener('resize', closeOnWindowChange);
  window.addEventListener('scroll', closeOnWindowChange, true);
  anchor.addEventListener('mouseenter', keepOpen);
  popover.addEventListener('mouseenter', keepOpen);
  anchor.addEventListener('mouseleave', maybeClose);
  popover.addEventListener('mouseleave', maybeClose);

  removeColorPreviewPopoverListeners = () => {
    document.removeEventListener('mousedown', closeOnPointerDown, true);
    document.removeEventListener('keydown', closeOnEscape, true);
    window.removeEventListener('resize', closeOnWindowChange);
    window.removeEventListener('scroll', closeOnWindowChange, true);
    anchor.removeEventListener('mouseenter', keepOpen);
    popover.removeEventListener('mouseenter', keepOpen);
    anchor.removeEventListener('mouseleave', maybeClose);
    popover.removeEventListener('mouseleave', maybeClose);
  };
  activeColorPreviewPopover = popover;
}

function channelToLinear(value: number) {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function getReadableForeground(parsed: ParsedColor) {
  const luminance =
    0.2126 * channelToLinear(parsed.r) +
    0.7152 * channelToLinear(parsed.g) +
    0.0722 * channelToLinear(parsed.b);
  return luminance > 0.5 ? 'rgba(12, 14, 20, 0.92)' : 'rgba(255, 255, 255, 0.96)';
}

export function findColorPreviewMatches(
  text: string,
  lineFrom: number,
  enabledFormats: Record<ColorPreviewFormat, boolean>,
): ColorPreviewMatch[] {
  const candidates: ColorPreviewMatch[] = [];

  for (const [format, regex] of Object.entries(COLOR_FORMAT_REGEXES) as [ColorPreviewFormat, RegExp][]) {
    if (!enabledFormats[format]) continue;
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      const index = match.index ?? -1;
      if (index < 0) continue;
      const parsed = tryParseColor(match[0]);
      if (!parsed) continue;
      candidates.push({
        from: lineFrom + index,
        to: lineFrom + index + match[0].length,
        source: match[0],
        parsed,
      });
    }
  }

  candidates.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from));
  const accepted: ColorPreviewMatch[] = [];
  let lastEnd = -1;
  for (const candidate of candidates) {
    if (candidate.from < lastEnd) continue;
    accepted.push(candidate);
    lastEnd = candidate.to;
  }
  return accepted;
}

function colorPreviewDecorations(
  view: EditorView,
  options: {
    enabled: boolean;
    showSwatch: boolean;
    tintText: boolean;
    formats: Record<ColorPreviewFormat, boolean>;
  },
): DecorationSet {
  if (!options.enabled || (!options.showSwatch && !options.tintText)) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    let linePos = from;
    while (linePos <= to) {
      const line = view.state.doc.lineAt(linePos);
      const matches = findColorPreviewMatches(line.text, line.from, options.formats);
      for (const match of matches) {
        const fg = getReadableForeground(match.parsed);
        if (options.showSwatch) {
          builder.add(
            match.from,
            match.from,
            Decoration.widget({
              widget: new ColorSwatchWidget(match.source, match.parsed),
              side: -1,
            }),
          );
        }
        if (options.tintText) {
          builder.add(
            match.from,
            match.to,
            Decoration.mark({
              class: 'cm-color-preview-token',
              attributes: {
                style: [
                  `background-color: rgba(${match.parsed.r}, ${match.parsed.g}, ${match.parsed.b}, 0.18)`,
                  `border-color: rgba(${match.parsed.r}, ${match.parsed.g}, ${match.parsed.b}, 0.42)`,
                  `color: ${fg}`,
                ].join('; '),
              },
            }),
          );
        }
      }
      linePos = line.to + 1;
    }
  }
  return builder.finish();
}

export function createColorPreviewExtension(options: {
  enabled: boolean;
  showSwatch: boolean;
  tintText: boolean;
  formats: Record<ColorPreviewFormat, boolean>;
}) {
  if (!options.enabled || (!options.showSwatch && !options.tintText)) return [];

  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = colorPreviewDecorations(view, options);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.decorations = colorPreviewDecorations(update.view, options);
      }
    }
  }, {
    decorations: (value) => value.decorations,
  });
}
