/**
 * The presentation PDF writer.
 *
 * Each page is one raster image of the slide (or handout page) — so the PDF
 * matches the editor pixel for pixel whatever fonts the reader has — with an
 * invisible text layer over it, so the PDF's text can be searched, selected,
 * copied, and read by assistive technology. Links become link annotations.
 *
 * This is the Phase 5 answer to the contract's open decision (vector PDF or
 * raster with a text layer): raster with a text layer. A vector writer would
 * need font embedding and subsetting for every script a deck can hold; the
 * raster path already draws whatever the platform can draw.
 *
 * The text layer uses one composite font with `Identity-H` encoding, no
 * glyph program (the text is never painted: render mode 3), and a `ToUnicode`
 * map from its codes to the characters, which is what readers extract. Codes
 * are assigned per document, one per distinct character, so any Unicode text
 * (astral characters included) maps back exactly.
 */

/** A run of invisible text. Coordinates are points, origin top-left, y down. */
export interface DeckPdfTextRun {
  text: string;
  /**
   * Text space → page points `[a, b, c, d, e, f]`, top-left origin, y down.
   * The run's baseline starts at text-space (0, 0) and runs along +x.
   */
  matrix: [number, number, number, number, number, number];
  /** Font size and drawn width, in text-space units. */
  size: number;
  width: number;
}

export interface DeckPdfLink {
  /** Axis-aligned area in points, origin top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
  target: { kind: 'uri'; uri: string } | { kind: 'page'; pageIndex: number };
}

export interface DeckPdfPage {
  /** Page size in points. */
  width: number;
  height: number;
  jpeg: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
  text?: DeckPdfTextRun[];
  links?: DeckPdfLink[];
}

export interface DeckPdfOptions {
  title?: string;
}

export const DECK_PDF_MAX_PAGES = 2_000;
/** Glyph advance of the text-layer font, in 1/1000 em. */
const ADVANCE = 500;

const encoder = new TextEncoder();

function ascii(value: string): Uint8Array {
  return encoder.encode(value);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const fixed = value.toFixed(3).replace(/\.?0+$/, '');
  return fixed === '-0' ? '0' : fixed;
}

function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/** A PDF text string as UTF-16BE hex with a byte-order mark. */
function textString(value: string): string {
  let out = '<FEFF';
  for (let index = 0; index < value.length; index += 1) out += hex4(value.charCodeAt(index));
  return `${out}>`;
}

/** URIs are 7-bit in PDF; anything else is percent-encoded, and parentheses escaped. */
function uriString(uri: string): string {
  const safe = encodeURI(decodeSafe(uri)).replace(/[()\\]/g, (char) => `\\${char}`);
  return `(${safe})`;
}

function decodeSafe(uri: string): string {
  try {
    return decodeURI(uri);
  } catch {
    return uri;
  }
}

class CodeTable {
  private readonly codes = new Map<string, number>();
  readonly chars: string[] = [];

  encode(text: string): { hex: string; count: number } {
    let hex = '';
    let count = 0;
    for (const char of text) {
      let code = this.codes.get(char);
      if (code === undefined) {
        // Code 0 is left unused; 0xFFFF is the most one font can address.
        if (this.chars.length >= 0xfffe) continue;
        code = this.chars.length + 1;
        this.codes.set(char, code);
        this.chars.push(char);
      }
      hex += hex4(code);
      count += 1;
    }
    return { hex, count };
  }

  toUnicode(): string {
    const lines = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /Adobe-Identity-UCS def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<0000> <FFFF>',
      'endcodespacerange',
    ];
    for (let start = 0; start < this.chars.length; start += 100) {
      const block = this.chars.slice(start, start + 100);
      lines.push(`${block.length} beginbfchar`);
      block.forEach((char, offset) => {
        let target = '';
        for (let index = 0; index < char.length; index += 1) target += hex4(char.charCodeAt(index));
        lines.push(`<${hex4(start + offset + 1)}> <${target}>`);
      });
      lines.push('endbfchar');
    }
    lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
    return lines.join('\n');
  }
}

function streamObject(dictionary: string, content: Uint8Array): Uint8Array {
  return concatBytes([
    ascii(`<< ${dictionary}/Length ${content.length} >>\nstream\n`),
    content,
    ascii('\nendstream'),
  ]);
}

/** Builds the PDF. Every page must have an image; text and links are optional. */
export function buildDeckPdf(
  pages: readonly DeckPdfPage[],
  options: DeckPdfOptions = {},
): Uint8Array {
  if (pages.length === 0) throw new Error('A PDF export requires at least one page.');
  if (pages.length > DECK_PDF_MAX_PAGES) {
    throw new Error(`A PDF export cannot contain more than ${DECK_PDF_MAX_PAGES} pages.`);
  }

  const objects = new Map<number, Uint8Array>();
  // 1 catalog, 2 pages, 3 info, 4 font, 5 CID font, 6 descriptor, 7 ToUnicode.
  let nextId = 8;
  const pageIds = pages.map(() => {
    const id = nextId;
    nextId += 3; // page, content, image
    return id;
  });
  const codes = new CodeTable();
  const usesText = pages.some((page) => page.text?.length);

  pages.forEach((page, pageIndex) => {
    const pageId = pageIds[pageIndex];
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const width = Math.max(1, page.width);
    const height = Math.max(1, page.height);

    const content: string[] = [`q\n${num(width)} 0 0 ${num(height)} 0 0 cm\n/Im0 Do\nQ`];
    const runs = page.text ?? [];
    if (runs.length) {
      content.push('BT\n3 Tr\n/F0 1 Tf');
      for (const run of runs) {
        const { hex, count } = codes.encode(run.text);
        if (count === 0 || run.size <= 0) continue;
        const [a, b, c, d, e, f] = run.matrix;
        // Top-left, y-down → PDF's bottom-left, y-up; and text-space y up.
        const kx = run.width > 0 ? run.width / ((count * ADVANCE) / 1_000) : run.size;
        const ky = run.size;
        const tm = [a * kx, -b * kx, -c * ky, d * ky, e, height - f];
        content.push(`${tm.map(num).join(' ')} Tm\n<${hex}> Tj`);
      }
      content.push('ET');
    }
    objects.set(contentId, streamObject('', ascii(`${content.join('\n')}\n`)));
    objects.set(
      imageId,
      streamObject(
        `/Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode `,
        page.jpeg,
      ),
    );

    const annots = (page.links ?? [])
      .map((link) => {
        const rect = [link.x, height - link.y - link.height, link.x + link.width, height - link.y]
          .map(num)
          .join(' ');
        let action: string;
        if (link.target.kind === 'uri') {
          action = `/A << /S /URI /URI ${uriString(link.target.uri)} >>`;
        } else {
          const target = pageIds[link.target.pageIndex];
          if (target === undefined) return null;
          action = `/Dest [${target} 0 R /Fit]`;
        }
        return `<< /Type /Annot /Subtype /Link /Rect [${rect}] /Border [0 0 0] ${action} >>`;
      })
      .filter((entry): entry is string => entry !== null);

    const resources = `/Resources << /XObject << /Im0 ${imageId} 0 R >>${runs.length ? ' /Font << /F0 4 0 R >>' : ''} >>`;
    objects.set(
      pageId,
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] ${resources} /Contents ${contentId} 0 R` +
          `${annots.length ? ` /Annots [${annots.join(' ')}]` : ''} >>`,
      ),
    );
  });

  objects.set(1, ascii('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.set(
    2,
    ascii(
      `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
    ),
  );
  objects.set(
    3,
    ascii(
      `<< /Producer ${textString('Collab')}${options.title ? ` /Title ${textString(options.title)}` : ''} >>`,
    ),
  );
  if (usesText) {
    objects.set(
      4,
      ascii(
        '<< /Type /Font /Subtype /Type0 /BaseFont /CollabTextLayer /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 7 0 R >>',
      ),
    );
    objects.set(
      5,
      ascii(
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CollabTextLayer /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /DW ${ADVANCE} /CIDToGIDMap /Identity >>`,
      ),
    );
    objects.set(
      6,
      ascii(
        '<< /Type /FontDescriptor /FontName /CollabTextLayer /Flags 4 /FontBBox [0 -200 500 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
      ),
    );
    objects.set(7, streamObject('', ascii(codes.toUnicode())));
  } else {
    // Keep object numbers dense; unused slots hold null objects.
    for (const id of [4, 5, 6, 7]) objects.set(id, ascii('null'));
  }

  const chunks: Uint8Array[] = [ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  const offsets = new Array<number>(nextId).fill(0);
  let length = chunks[0].length;
  for (let id = 1; id < nextId; id += 1) {
    const body = objects.get(id);
    if (!body) throw new Error(`PDF object ${id} is missing.`);
    offsets[id] = length;
    const object = concatBytes([ascii(`${id} 0 obj\n`), body, ascii('\nendobj\n')]);
    chunks.push(object);
    length += object.length;
  }
  const xref = [
    `xref\n0 ${nextId}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${nextId} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${length}\n%%EOF\n`,
  ].join('');
  chunks.push(ascii(xref));
  return concatBytes(chunks);
}
