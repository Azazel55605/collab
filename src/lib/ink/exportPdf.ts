export interface InkPdfImagePage {
  jpeg: Uint8Array;
  pixelWidth: number;
  pixelHeight: number;
  pointWidth: number;
  pointHeight: number;
}

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

function pdfNumber(value: number): string {
  return Math.max(1, value)
    .toFixed(3)
    .replace(/\.?0+$/, '');
}

/** Builds a bounded PDF whose pages each contain one JPEG export image. */
export function buildInkPdf(pages: readonly InkPdfImagePage[]): Uint8Array {
  if (pages.length === 0) throw new Error('A PDF export requires at least one page.');
  if (pages.length > 1_000) throw new Error('A PDF export cannot contain more than 1,000 pages.');

  const objectParts = new Map<number, Uint8Array>();
  const pageObjectIds: number[] = [];
  let nextId = 3;
  for (const page of pages) {
    const pageId = nextId;
    const contentId = nextId + 1;
    const imageId = nextId + 2;
    nextId += 3;
    pageObjectIds.push(pageId);
    const pointWidth = pdfNumber(page.pointWidth);
    const pointHeight = pdfNumber(page.pointHeight);
    objectParts.set(
      pageId,
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pointWidth} ${pointHeight}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
    const content = ascii(`q\n${pointWidth} 0 0 ${pointHeight} 0 0 cm\n/Im0 Do\nQ\n`);
    objectParts.set(
      contentId,
      concatBytes([
        ascii(`<< /Length ${content.length} >>\nstream\n`),
        content,
        ascii('endstream'),
      ]),
    );
    objectParts.set(
      imageId,
      concatBytes([
        ascii(
          `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
        ),
        page.jpeg,
        ascii('\nendstream'),
      ]),
    );
  }

  objectParts.set(1, ascii('<< /Type /Catalog /Pages 2 0 R >>'));
  objectParts.set(
    2,
    ascii(
      `<< /Type /Pages /Count ${pageObjectIds.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] >>`,
    ),
  );

  const chunks: Uint8Array[] = [ascii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  const offsets = new Array<number>(nextId).fill(0);
  let length = chunks[0].length;
  for (let id = 1; id < nextId; id += 1) {
    const content = objectParts.get(id);
    if (!content) throw new Error(`PDF object ${id} is missing.`);
    offsets[id] = length;
    const object = concatBytes([ascii(`${id} 0 obj\n`), content, ascii('\nendobj\n')]);
    chunks.push(object);
    length += object.length;
  }
  const xrefOffset = length;
  const xref = [
    `xref\n0 ${nextId}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${nextId} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join('');
  chunks.push(ascii(xref));
  return concatBytes(chunks);
}
