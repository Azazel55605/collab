const sourceLanguages = {
  txt: '',
  json: 'json',
  py: 'python',
  c: 'c',
  h: 'c',
  cs: 'csharp',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  html: 'html',
  css: 'css',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  rs: 'rust',
  go: 'go',
  java: 'java',
  sh: 'bash',
  sql: 'sql',
} as const;

export const SOURCE_FILE_EXTENSIONS = Object.keys(sourceLanguages);

export function sourceLanguageForPath(path: string): string | undefined {
  const parts = path.split('/');
  const name = parts[parts.length - 1]?.toLowerCase() ?? '';
  if (parts.some((part) => part.startsWith('.')) || /\.pdf(?:-sidecar)?\.json$/.test(name)) {
    return undefined;
  }
  const extension = name.match(/\.([^.]+)$/)?.[1];
  return extension && Object.prototype.hasOwnProperty.call(sourceLanguages, extension)
    ? sourceLanguages[extension as keyof typeof sourceLanguages]
    : undefined;
}

export function isSqlSourcePath(path: string): boolean {
  return sourceLanguageForPath(path) === 'sql';
}

export function decodeSourceBuffer(raw: string) {
  const bom = raw.startsWith('\uFEFF');
  const crlf = raw.includes('\r\n');
  return {
    text: (bom ? raw.slice(1) : raw).replace(/\r\n/g, '\n'),
    bom,
    crlf,
  };
}

export function encodeSourceBuffer(text: string, format: { bom: boolean; crlf: boolean }) {
  return (format.bom ? '\uFEFF' : '') + (format.crlf ? text.replace(/\n/g, '\r\n') : text);
}

export const MAX_SOURCE_IMPORT_BYTES = 16 * 1024 * 1024;
export const MAX_SOURCE_EDIT_BYTES = 1024 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export function decodeSourceUpload(bytes: Uint8Array): string {
  if (bytes.length > MAX_SOURCE_IMPORT_BYTES)
    throw new Error('Source imports are limited to 16 MiB.');
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (hasBinaryControls(content)) throw new Error('This file contains binary control bytes.');
  return content;
}

function hasBinaryControls(content: string): boolean {
  // ASCII tabs, LF, form feeds, and CR are valid source text.
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(content);
}

export function readHostedSourceBuffer(content: string, version: string): SourceRead {
  const bytes = encoder.encode(content);
  if (hasBinaryControls(content)) {
    return {
      content: null,
      version: null,
      preview: null,
      reason: 'This file contains binary control bytes.',
    };
  }
  const lines = decodeSourceBuffer(content).text.split('\n');
  const onlyCrlf = content.includes('\r\n') && !/(^|[^\r])\n/.test(content);
  const unsupported = /\r(?!\n)/.test(content) || (content.includes('\r\n') && !onlyCrlf);
  const reason = unsupported
    ? 'This file uses mixed or unsupported line endings.'
    : bytes.length > MAX_SOURCE_EDIT_BYTES ||
        lines.length > 50_000 ||
        lines.some((line) => encoder.encode(line).length > 16 * 1024)
      ? "This file exceeds the source editor's 1 MiB, 50,000 line, or 16 KiB line limit."
      : null;
  if (!reason) return { content, version, preview: null, reason: null };
  const preview = new TextDecoder('utf-8', { fatal: true })
    .decode(bytes.subarray(0, boundedUtf8End(bytes, MAX_PREVIEW_BYTES)))
    .split('\n', 200)
    .join('\n');
  return { content: null, version: null, preview, reason };
}

function boundedUtf8End(bytes: Uint8Array, limit: number): number {
  let end = Math.min(bytes.length, limit);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return end;
}

export interface SourceRead {
  content: string | null;
  version: string | null;
  preview: string | null;
  reason: string | null;
  canCreateEditableCopy?: boolean;
}

export interface SourceSave {
  version: string;
  offlineQueued?: boolean;
  conflict: { content: string; version: string } | null;
}
