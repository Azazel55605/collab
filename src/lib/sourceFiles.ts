const sourceLanguages = {
  txt: '',
  json: 'json',
  py: 'python',
  c: 'c',
  h: 'c',
  cs: 'csharp',
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

export interface SourceRead {
  content: string | null;
  version: string | null;
  preview: string | null;
  reason: string | null;
}

export interface SourceSave {
  version: string;
  conflict: { content: string; version: string } | null;
}
