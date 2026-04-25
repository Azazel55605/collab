import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
} from '@codemirror/view';

import type { ColorPreviewFormat } from '../../store/uiStore';

class ColorSwatchWidget extends WidgetType {
  constructor(private readonly color: string) {
    super();
  }

  eq(other: ColorSwatchWidget) {
    return this.color === other.color;
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-color-preview-swatch';
    span.setAttribute('aria-hidden', 'true');
    span.style.backgroundColor = this.color;
    span.style.borderColor = this.color;
    return span;
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
      candidates.push({ from: lineFrom + index, to: lineFrom + index + match[0].length, parsed });
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
            Decoration.widget({ widget: new ColorSwatchWidget(match.parsed.css), side: -1 }),
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
