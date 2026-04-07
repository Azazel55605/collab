const IMAGE_EXT_RE = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i;
const ABSOLUTE_URL_RE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/');
}

function normalizeRelativePath(path: string): string {
  const parts = normalizeSeparators(path).split('/');
  const out: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }

  return out.join('/');
}

export function isLikelyImagePath(path: string): boolean {
  const cleanPath = path.split(/[?#]/, 1)[0];
  return IMAGE_EXT_RE.test(cleanPath);
}

export type NoteAssetTarget =
  | { kind: 'direct'; value: string }
  | { kind: 'vault'; value: string };

export function resolveNoteAssetTarget(
  assetPath: string,
  noteRelativePath: string,
): NoteAssetTarget | null {
  const trimmed = assetPath.trim();
  if (!trimmed) return null;
  if (ABSOLUTE_URL_RE.test(trimmed) || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
    return { kind: 'direct', value: trimmed };
  }

  const [rawPath, suffix = ''] = trimmed.match(/^([^?#]*)(.*)$/)?.slice(1) ?? [trimmed, ''];
  const noteDir = noteRelativePath.includes('/')
    ? noteRelativePath.split('/').slice(0, -1).join('/')
    : '';
  const relativeToVault = rawPath.startsWith('/')
    ? normalizeRelativePath(rawPath)
    : normalizeRelativePath(noteDir ? `${noteDir}/${rawPath}` : rawPath);

  return {
    kind: 'vault',
    value: `${relativeToVault}${suffix}`,
  };
}
