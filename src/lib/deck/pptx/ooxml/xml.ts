/**
 * Small, strict helpers for writing OOXML by hand.
 *
 * Every string from a document goes through `text`/`attr`, which escape it and
 * drop the characters XML 1.0 cannot carry. Numbers are written as integers
 * (OOXML coordinates are integral EMU, angles 60,000ths of a degree, and so on).
 */
import { unitsToEmu } from '../../units';

export const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  p14: 'http://schemas.microsoft.com/office/powerpoint/2010/main',
  asvg: 'http://schemas.microsoft.com/office/drawing/2016/SVG/main',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
} as const;

export const REL = {
  officeDocument:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  coreProps:
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extendedProps:
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  notesMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  chart: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
  package: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package',
  presProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps',
  viewProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps',
  tableStyles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles',
} as const;

export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

/** Escapes character data. */
export function text(value: string): string {
  return value
    .replace(INVALID, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escapes an attribute value (always written in double quotes). */
export function attr(value: string): string {
  return text(value).replace(/"/g, '&quot;');
}

export function emu(units: number): number {
  return Math.round(unitsToEmu(units));
}

/** An integer for OOXML, never `-0` or `NaN`. */
export function int(value: number): string {
  const rounded = Math.round(Number.isFinite(value) ? value : 0);
  return String(rounded === 0 ? 0 : rounded);
}

/** A deterministic `{XXXXXXXX-XXXX-...}` GUID from a string (FNV-1a based). */
export function guid(seed: string): string {
  const words: string[] = [];
  for (let round = 0; round < 4; round += 1) {
    let hash = 0x811c9dc5 ^ round;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    words.push(hash.toString(16).toUpperCase().padStart(8, '0'));
  }
  const hex = words.join('');
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}}`;
}

/** One `.rels` part. */
export class Relationships {
  private readonly entries: Array<{ id: string; type: string; target: string; external: boolean }> =
    [];

  add(type: string, target: string, external = false): string {
    const existing = this.entries.find(
      (entry) => entry.type === type && entry.target === target && entry.external === external,
    );
    if (existing) return existing.id;
    const id = `rId${this.entries.length + 1}`;
    this.entries.push({ id, type, target, external });
    return id;
  }

  toXml(): string {
    return (
      `${XML_HEADER}<Relationships xmlns="${NS.rel}">` +
      this.entries
        .map(
          (entry) =>
            `<Relationship Id="${entry.id}" Type="${entry.type}" Target="${attr(entry.target)}"${entry.external ? ' TargetMode="External"' : ''}/>`,
        )
        .join('') +
      '</Relationships>'
    );
  }
}
