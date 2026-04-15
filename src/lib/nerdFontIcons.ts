import mappings from '../generated/nerd-font-mappings.json';

export interface NerdFontIconEntry {
  id: string;
  glyph: string;
  hexCode: number;
  categoryKey: string;
  categoryLabel: string;
  nameLabel: string;
  searchText: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  cod: 'VS Code',
  custom: 'Custom',
  dev: 'Devicons',
  fa: 'Font Awesome',
  fae: 'Font Awesome Extension',
  iec: 'IEC Power',
  indent: 'Indent',
  linux: 'Linux',
  md: 'Material Design',
  oct: 'Octicons',
  pl: 'Powerline',
  ple: 'Powerline Extra',
  pom: 'Pomicons',
  seti: 'Seti',
  weather: 'Weather',
};

function titleCaseToken(token: string) {
  return token
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildCategoryLabel(categoryKey: string) {
  return CATEGORY_LABELS[categoryKey] ?? titleCaseToken(categoryKey);
}

function buildNameLabel(id: string) {
  const [, , ...nameTokens] = id.split('-');
  return titleCaseToken(nameTokens.join(' '));
}

function buildSearchText(id: string, categoryLabel: string, nameLabel: string) {
  return `${id} ${categoryLabel} ${nameLabel} ${id.replace(/[-_]/g, ' ')}`.toLowerCase();
}

function scoreEntry(entry: NerdFontIconEntry, query: string) {
  const exactName = entry.nameLabel.toLowerCase();
  const exactId = entry.id.toLowerCase();
  const category = entry.categoryLabel.toLowerCase();

  if (exactId === query || exactName === query) return 0;
  if (exactName.startsWith(query)) return 1;
  if (exactId.startsWith(query)) return 2;
  if (category.startsWith(query)) return 3;

  const nameWordIndex = exactName.split(/\s+/).findIndex((word) => word.startsWith(query));
  if (nameWordIndex >= 0) return 4 + nameWordIndex;

  if (entry.searchText.includes(query)) return 12;
  return null;
}

export const NERD_FONT_ICONS: NerdFontIconEntry[] = (Object.entries(mappings) as [string, number][])
  .map(([id, hexCode]) => {
    const [, categoryKey = 'custom'] = id.split('-');
    const categoryLabel = buildCategoryLabel(categoryKey);
    const nameLabel = buildNameLabel(id);
    return {
      id,
      glyph: String.fromCodePoint(hexCode),
      hexCode,
      categoryKey,
      categoryLabel,
      nameLabel,
      searchText: buildSearchText(id, categoryLabel, nameLabel),
    };
  })
  .sort((left, right) => (
    left.categoryLabel.localeCompare(right.categoryLabel) ||
    left.nameLabel.localeCompare(right.nameLabel) ||
    left.id.localeCompare(right.id)
  ));

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

export function searchNerdFontIcons(rawQuery: string, limit = 240) {
  const query = rawQuery.trim().replace(/^(?:icon|icons|glyph|glyphs|symbol|symbols|nf)\s*/i, '').toLowerCase();
  if (!query) return NERD_FONT_ICONS.slice(0, limit);

  return NERD_FONT_ICONS
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter((result): result is { entry: NerdFontIconEntry; score: number } => result.score != null)
    .sort((left, right) => (
      left.score - right.score ||
      left.entry.categoryLabel.localeCompare(right.entry.categoryLabel) ||
      left.entry.nameLabel.localeCompare(right.entry.nameLabel) ||
      left.entry.id.localeCompare(right.entry.id)
    ))
    .slice(0, limit)
    .map((result) => result.entry);
}
