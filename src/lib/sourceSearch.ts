import { decodeSourceBuffer, MAX_SOURCE_EDIT_BYTES, sourceLanguageForPath } from './sourceFiles';
import type { VaultClient } from './vaultClient';
import { flattenVaultFiles } from './vaultLinks';

const MAX_FILES = 200;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RESULTS = 100;
const MAX_QUERY_LENGTH = 200;

export interface SourceSearchResult {
  relativePath: string;
  line: number;
  excerpt: string;
}

export function sourceSearchMatch(query: string): RegExp | null {
  const needle = query.trim();
  return needle.length >= 2 && needle.length <= MAX_QUERY_LENGTH
    ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
    : null;
}

export async function searchSourceFiles(client: VaultClient, query: string, signal: AbortSignal) {
  const matcher = sourceSearchMatch(query);
  const results: SourceSearchResult[] = [];
  if (!matcher || !client.readSourceFile || signal.aborted) return { results, partial: false };

  const files = flattenVaultFiles(await client.listFiles()).filter(
    (file) => sourceLanguageForPath(file.relativePath) !== undefined,
  );
  const encoder = new TextEncoder();
  let bytes = 0;
  let partial = false;
  for (const [index, file] of files.entries()) {
    if (signal.aborted) break;
    if (index >= MAX_FILES || results.length >= MAX_RESULTS) {
      partial = true;
      break;
    }
    if (file.size > MAX_SOURCE_EDIT_BYTES + 32 || bytes + file.size > MAX_BYTES) {
      partial = true;
      continue;
    }

    // Use the usual vault adapter for locked, encrypted, hosted, and cached files.
    const source = await client.readSourceFile(file.relativePath).catch(() => null);
    if (signal.aborted) break;
    if (source?.content == null) {
      partial = true;
      continue;
    }
    bytes += encoder.encode(source.content).length;
    if (bytes > MAX_BYTES) {
      partial = true;
      break;
    }
    const lines = decodeSourceBuffer(source.content).text.split('\n');
    for (const [index, text] of lines.entries()) {
      const match = matcher.exec(text);
      if (!match) continue;
      if (results.length === MAX_RESULTS) return { results, partial: true };
      const start = Math.max(0, match.index - 60);
      const end = Math.min(text.length, match.index + match[0].length + 100);
      results.push({
        relativePath: file.relativePath,
        line: index + 1,
        excerpt: (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : ''),
      });
    }
  }
  return { results, partial };
}
