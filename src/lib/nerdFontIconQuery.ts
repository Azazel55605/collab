import type { NerdFontIconEntry } from './nerdFontIcons';

export function formatNerdFontHexCode(hexCode: number) {
  return `U+${hexCode.toString(16).toUpperCase()}`;
}

export function groupNerdFontIcons(entries: NerdFontIconEntry[]) {
  const grouped = new Map<string, NerdFontIconEntry[]>();
  for (const entry of entries) {
    const current = grouped.get(entry.categoryLabel);
    if (current) current.push(entry);
    else grouped.set(entry.categoryLabel, [entry]);
  }
  return Array.from(grouped.entries());
}

export function isNerdFontIconQuery(query: string) {
  return /^(?:icon|icons|glyph|glyphs|symbol|symbols|nf)\b/i.test(query.trim());
}

export function completeNerdFontIconQuery(query: string) {
  const trimmed = query.trimStart();
  if (!trimmed) return null;
  const tokenMatch = trimmed.match(/^(\S+)(?:\s|$)/);
  if (!tokenMatch) return null;
  const token = tokenMatch[1].toLowerCase();
  const aliases = ['icon', 'icons', 'glyph', 'glyphs', 'symbol', 'symbols', 'nf'];
  const matches = aliases.filter((value) => value.startsWith(token));
  if (matches.length !== 1) return null;
  const rest = trimmed.slice(token.length);
  if (rest.trim().length > 0 || /\s$/.test(trimmed)) return null;
  return 'icon ';
}
