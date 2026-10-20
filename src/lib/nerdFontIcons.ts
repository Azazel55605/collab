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
const CACHE_LIMIT = 64;
const CACHE_RESULT_LIMIT = 8192;
let cachedReferences = 0;
let postings: Map<string, Uint32Array> | undefined;
let preparing: Promise<void> | undefined;
/** Build in small background slices so the first typed query never pays one long index task. */
export function prepareIconSearchIndex(): Promise<void> {
  if (postings) return Promise.resolve();
  if (preparing) return preparing;
  preparing = new Promise((resolve) => {
    const building = new Map<string, number[]>();
    let position = 0;
    const slice = () => {
      const end = Math.min(position + 100, NERD_FONT_ICONS.length);
      for (; position < end; position++) {
        const entry = NERD_FONT_ICONS[position];
        const grams = new Set<string>();
        for (let i = 0; i < entry.searchText.length; i++) {
          grams.add(entry.searchText[i]);
          if (i + 3 <= entry.searchText.length) grams.add(entry.searchText.slice(i, i + 3));
        }
        for (const gram of grams) {
          const list = building.get(gram);
          if (list) list.push(position);
          else building.set(gram, [position]);
        }
      }
      if (position < NERD_FONT_ICONS.length) setTimeout(slice, 0);
      else {
        postings = new Map([...building].map(([gram, values]) => [gram, Uint32Array.from(values)]));
        resolve();
      }
    };
    setTimeout(slice, 0);
  });
  return preparing;
}
export function iconSearchStats() {
  return {
    entries: SEARCH_CACHE.size,
    references: cachedReferences,
    indexBytes: postings
      ? [...postings.values()].reduce((sum, values) => sum + values.byteLength, 0)
      : 0,
  };
}
export function searchNerdFontIcons(rawQuery: string, limit = 240) {
  limit = Number.isFinite(limit) ? Math.max(0, Math.min(1000, Math.floor(limit))) : 240;
  if (!limit) return [];
  const query = rawQuery
    .trim()
    .replace(/^(?:icons?|glyphs?|symbols?|nf)\b\s*/i, '')
    .toLowerCase();
  if (!query) return NERD_FONT_ICONS.slice(0, limit);
  if (query.length > 512) return [];
  const cacheKey = `${limit}:${query}`;
  const cached = SEARCH_CACHE.get(cacheKey);
  if (cached) {
    SEARCH_CACHE.delete(cacheKey);
    SEARCH_CACHE.set(cacheKey, cached);
    return cached;
  }
  void prepareIconSearchIndex();
  const index = postings;
  let candidates: Uint32Array | undefined;
  const size = query.length >= 3 ? 3 : 1;
  for (let offset = 0; index && offset <= query.length - size; offset++) {
    const list = index.get(query.slice(offset, offset + size));
    if (!list) {
      candidates = new Uint32Array();
      break;
    }
    if (!candidates || list.length < candidates.length) candidates = list;
  }
  const buckets = new Map<number, NerdFontIconEntry[]>();
  for (const position of candidates ?? NERD_FONT_ICONS.keys()) {
    const entry = NERD_FONT_ICONS[position];
    const score = scoreEntry(entry, query);
    if (score === null) continue;
    const bucket = buckets.get(score);
    if (!bucket) buckets.set(score, [entry]);
    else if (bucket.length < limit) bucket.push(entry);
  }
  const results = [...buckets.keys()]
    .sort((a, b) => a - b)
    .flatMap((score) => buckets.get(score)!)
    .slice(0, limit);
  SEARCH_CACHE.set(cacheKey, results);
  cachedReferences += results.length;
  while (SEARCH_CACHE.size > CACHE_LIMIT || cachedReferences > CACHE_RESULT_LIMIT) {
    const first = SEARCH_CACHE.keys().next().value!;
    cachedReferences -= SEARCH_CACHE.get(first)!.length;
    SEARCH_CACHE.delete(first);
  }
  return results;
}
