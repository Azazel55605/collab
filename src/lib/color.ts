const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export interface HsvaColor {
  h: number;
  s: number;
  v: number;
  a: number;
}

export function clampColorChannel(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeHex(value: string, allowAlpha: boolean): string | null {
  const match = value.trim().match(HEX_COLOR);
  if (!match) return null;
  const source = match[1].toLowerCase();
  const expanded =
    source.length <= 4
      ? [...source].map((character) => `${character}${character}`).join('')
      : source;
  const rgb = expanded.slice(0, 6);
  const alpha = expanded.slice(6, 8);
  return `#${rgb}${allowAlpha && alpha && alpha !== 'ff' ? alpha : ''}`;
}

export function hexToHsva(value: string): HsvaColor {
  const normalized = normalizeHex(value, true) ?? '#000000';
  const red = Number.parseInt(normalized.slice(1, 3), 16) / 255;
  const green = Number.parseInt(normalized.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(normalized.slice(5, 7), 16) / 255;
  const alpha = normalized.length === 9 ? Number.parseInt(normalized.slice(7, 9), 16) / 255 : 1;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (max === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return {
    h: hue,
    s: max === 0 ? 0 : (delta / max) * 100,
    v: max * 100,
    a: alpha,
  };
}

export function hsvaToHex(color: HsvaColor, allowAlpha: boolean): string {
  const hue = ((color.h % 360) + 360) % 360;
  const saturation = clampColorChannel(color.s, 0, 100) / 100;
  const value = clampColorChannel(color.v, 0, 100) / 100;
  const chroma = value * saturation;
  const section = hue / 60;
  const secondary = chroma * (1 - Math.abs((section % 2) - 1));
  const [red1, green1, blue1] =
    section < 1
      ? [chroma, secondary, 0]
      : section < 2
        ? [secondary, chroma, 0]
        : section < 3
          ? [0, chroma, secondary]
          : section < 4
            ? [0, secondary, chroma]
            : section < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const match = value - chroma;
  const channel = (component: number) =>
    Math.round((component + match) * 255)
      .toString(16)
      .padStart(2, '0');
  const alpha = Math.round(clampColorChannel(color.a, 0, 1) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${channel(red1)}${channel(green1)}${channel(blue1)}${allowAlpha && alpha !== 'ff' ? alpha : ''}`;
}
