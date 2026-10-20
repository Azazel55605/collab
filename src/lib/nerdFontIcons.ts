import mappings from '../generated/nerd-font-mappings.json';

export interface NerdFontIconEntry {
  id: string;
  glyph: string;
  hexCode: number;
  categoryKey: string;
  categoryLabel: string;
  nameLabel: string;
  searchText: string;
  idLower: string;
  nameLower: string;
  categoryLower: string;
  nameWords: string[];
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
  if (entry.idLower === query || entry.nameLower === query) return 0;
  if (entry.nameLower.startsWith(query)) return 1;
  if (entry.idLower.startsWith(query)) return 2;
  if (entry.categoryLower.startsWith(query)) return 3;

  const nameWordIndex = entry.nameWords.findIndex((word) => word.startsWith(query));
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
      idLower: id.toLowerCase(),
      nameLower: nameLabel.toLowerCase(),
      categoryLower: categoryLabel.toLowerCase(),
      nameWords: nameLabel.toLowerCase().split(/\s+/).filter(Boolean),
    };
  })
  .sort(
    (left, right) =>
      left.categoryLabel.localeCompare(right.categoryLabel) ||
      left.nameLabel.localeCompare(right.nameLabel) ||
      left.id.localeCompare(right.id),
  );

export {
  formatNerdFontHexCode,
  groupNerdFontIcons,
  isNerdFontIconQuery,
  completeNerdFontIconQuery,
} from './nerdFontIconQuery';

const SEARCH_CACHE = new Map<string, NerdFontIconEntry[]>();

export function searchNerdFontIcons(rawQuery: string, limit = 240) {
  const query = rawQuery
    .trim()
    .replace(/^(?:icons?|glyphs?|symbols?|nf)\b\s*/i, '')
    .toLowerCase();
  if (!query) return NERD_FONT_ICONS.slice(0, limit);
  const cacheKey = `${limit}:${query}`;
  const cached = SEARCH_CACHE.get(cacheKey);
  if (cached) return cached;

  const buckets = new Map<number, NerdFontIconEntry[]>();
  for (const entry of NERD_FONT_ICONS) {
    const score = scoreEntry(entry, query);
    if (score == null) continue;
    const bucket = buckets.get(score);
    if (bucket) bucket.push(entry);
    else buckets.set(score, [entry]);
  }

  const results: NerdFontIconEntry[] = [];
  const sortedScores = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const score of sortedScores) {
    const entries = buckets.get(score);
    if (!entries) continue;
    for (const entry of entries) {
      results.push(entry);
      if (results.length >= limit) {
        SEARCH_CACHE.set(cacheKey, results);
        return results;
      }
    }
  }

  SEARCH_CACHE.set(cacheKey, results);
  return results;
}
