/**
 * Resolved items → PresentationML shapes, pictures, connectors, tables,
 * chart frames, and groups.
 *
 * Geometry comes straight from the resolved frame in exact EMU (127 per deck
 * unit), with rotation in 60,000ths of a degree. Groups are real
 * `<p:grpSp>`s with an identity child transform, because their children's
 * frames are already resolved to slide coordinates.
 */
import type { DeckElement, DeckElementContainer, DeckLink } from '../../../../types/deck';
import { OOXML_PRESET } from '../../geometry';
import type {
  ResolvedFill,
  ResolvedItem,
  ResolvedLine,
  ResolvedShapeItem,
  ResolvedTableItem,
} from '../../resolve';
import type { DeckTextMeasurer } from '../../textLayout';
import { layoutText } from '../../textLayout';
import type { DeckExportReportBuilder } from '../exportReport';

import { solidFill, textBodyXml } from './text';
import type { TextWriteContext } from './text';
import { attr, emu, int } from './xml';

/** An image ready for the package: raster bytes, plus the SVG when there is one. */
export interface ExportImage {
  /** `data:image/png;base64,...` (or jpeg/gif): what every viewer draws. */
  raster: string;
  /** The original SVG, for viewers that prefer vector (PowerPoint 2016+). */
  svg?: string;
}

/** What drawing needs from the part being written. */
export interface PartWriter {
  report: DeckExportReportBuilder;
  measurer: DeckTextMeasurer;
  /** The slide (or layout, or master) id, for report entries. */
  ownerId: string;
  nextShapeId(): number;
  /** Relationship id for an image, or null when it is unavailable. */
  image(path: string): { raster: string; svg?: string } | null;
  /** Relationship id for a chart part written for this item. */
  chart(item: Extract<ResolvedItem, { kind: 'chart' }>): string;
  link(link: DeckLink): { id: string; action?: string } | null;
  /** The placeholder reference (`<p:ph>`) for an item, or ''. */
  placeholder(item: ResolvedItem): string;
}

const DASH: Record<ResolvedLine['dash'], string> = {
  solid: 'solid',
  dash: 'dash',
  dot: 'sysDot',
  dashDot: 'dashDot',
};

const ARROW = {
  none: 'none',
  triangle: 'triangle',
  open: 'arrow',
  oval: 'oval',
  diamond: 'diamond',
} as const;

function xfrm(frame: ResolvedItem['frame'], tag = 'a:xfrm'): string {
  const attrs = [
    frame.rotation ? ` rot="${int((frame.rotation / 100) * 60_000)}"` : '',
    frame.flipH ? ' flipH="1"' : '',
    frame.flipV ? ' flipV="1"' : '',
  ].join('');
  return (
    `<${tag}${attrs}><a:off x="${emu(frame.x)}" y="${emu(frame.y)}"/>` +
    `<a:ext cx="${Math.max(0, emu(frame.width))}" cy="${Math.max(0, emu(frame.height))}"/></${tag}>`
  );
}

function fillXml(fill: ResolvedFill, opacity: number): string {
  return fill.kind === 'solid' ? solidFill(fill.color, opacity) : '<a:noFill/>';
}

function lineXml(
  line: ResolvedLine | null,
  opacity: number,
  ends?: { head: keyof typeof ARROW; tail: keyof typeof ARROW },
): string {
  if (!line) return '<a:ln><a:noFill/></a:ln>';
  const arrow = (tag: string, kind: keyof typeof ARROW) =>
    kind === 'none' ? '' : `<a:${tag} type="${ARROW[kind]}" w="med" len="med"/>`;
  return (
    `<a:ln w="${emu(line.width)}">${solidFill(line.color, opacity)}<a:prstDash val="${DASH[line.dash]}"/>` +
    `<a:round/>${ends ? arrow('headEnd', ends.head) + arrow('tailEnd', ends.tail) : ''}</a:ln>`
  );
}

function nameAttrs(id: number, item: ResolvedItem, extra = ''): string {
  return `<p:cNvPr id="${id}" name="${attr(item.name ?? item.id)}"${item.altText ? ` descr="${attr(item.altText)}"` : ''}>${extra}</p:cNvPr>`;
}

function textContext(writer: PartWriter, item: ResolvedItem): TextWriteContext {
  return {
    report: writer.report,
    slideId: writer.ownerId,
    elementId: item.id,
    opacity: item.opacity,
    link: writer.link,
    slideNumberField: item.placeholder === 'slideNumber',
  };
}

function shapeXml(writer: PartWriter, item: ResolvedShapeItem): string {
  const id = writer.nextShapeId();
  const body = item.text;
  let scale = 1;
  if (body?.autoFit === 'shrink') {
    scale = layoutText(body, item.frame.width, item.frame.height, writer.measurer).scale;
  }
  const isTextBox = item.elementType === 'text' && !item.placeholder;
  return (
    `<p:sp><p:nvSpPr>${nameAttrs(id, item)}<p:cNvSpPr${isTextBox ? ' txBox="1"' : ''}/><p:nvPr>${writer.placeholder(item)}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${xfrm(item.frame)}<a:prstGeom prst="${OOXML_PRESET[item.geometry]}"><a:avLst/></a:prstGeom>` +
    `${fillXml(item.fill, item.opacity)}${lineXml(item.line, item.opacity)}</p:spPr>` +
    (body ? textBodyXml(body, textContext(writer, item), 'p:txBody', scale) : '') +
    '</p:sp>'
  );
}

function lineItemXml(writer: PartWriter, item: Extract<ResolvedItem, { kind: 'line' }>): string {
  const id = writer.nextShapeId();
  const { from, to } = item;
  // A connector's box runs top-left to bottom-right; flips give the other diagonals.
  const frame = {
    ...item.frame,
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
    rotation: 0,
    flipH: to.x < from.x,
    flipV: to.y < from.y,
  };
  return (
    `<p:cxnSp><p:nvCxnSpPr>${nameAttrs(id, item)}<p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
    `<p:spPr>${xfrm(frame)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>` +
    `${lineXml(item.line, item.opacity, { head: item.startArrow, tail: item.endArrow })}</p:spPr></p:cxnSp>`
  );
}

function blipXml(rel: { raster: string; svg?: string }, opacity: number): string {
  const alpha = opacity < 1 ? `<a:alphaModFix amt="${int(opacity * 100_000)}"/>` : '';
  const svg = rel.svg
    ? `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${rel.svg}"/></a:ext></a:extLst>`
    : '';
  return `<a:blip r:embed="${rel.raster}">${alpha}${svg}</a:blip>`;
}

function missingImageXml(writer: PartWriter, item: ResolvedItem, path: string): string {
  writer.report.missingAsset(path);
  writer.report.add({
    severity: 'missing',
    code: 'missing-image',
    message: `The image ${path} was not available and was exported as a placeholder.`,
    slideId: writer.ownerId,
    elementId: item.id,
  });
  const id = writer.nextShapeId();
  return (
    `<p:sp><p:nvSpPr>${nameAttrs(id, item)}<p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm(item.frame)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    '<a:solidFill><a:srgbClr val="F3F4F6"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="9CA3AF"/></a:solidFill><a:prstDash val="dash"/></a:ln></p:spPr></p:sp>'
  );
}

function pictureXml(writer: PartWriter, item: Extract<ResolvedItem, { kind: 'image' }>): string {
  const rel = writer.image(item.asset.path);
  if (!rel) return missingImageXml(writer, item, item.asset.path);
  const id = writer.nextShapeId();
  const crop = item.crop;
  const srcRect =
    crop.left || crop.top || crop.right || crop.bottom
      ? `<a:srcRect l="${int(crop.left * 100)}" t="${int(crop.top * 100)}" r="${int(crop.right * 100)}" b="${int(crop.bottom * 100)}"/>`
      : '<a:srcRect/>';
  return (
    `<p:pic><p:nvPicPr>${nameAttrs(id, item)}<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr>${writer.placeholder(item)}</p:nvPr></p:nvPicPr>` +
    `<p:blipFill>${blipXml(rel, item.opacity)}${srcRect}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrm(item.frame)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${item.line ? lineXml(item.line, item.opacity) : ''}</p:spPr></p:pic>`
  );
}

function embedXml(writer: PartWriter, item: Extract<ResolvedItem, { kind: 'embed' }>): string {
  writer.report.add({
    severity: 'flattened',
    code: 'embed-preview',
    message: `The linked ${item.source.path} was exported as its preview picture.`,
    slideId: writer.ownerId,
    elementId: item.id,
  });
  const rel = item.preview ? writer.image(item.preview.path) : null;
  if (!rel) return missingImageXml(writer, item, item.preview?.path ?? item.source.path);
  const id = writer.nextShapeId();
  return (
    `<p:pic><p:nvPicPr>${nameAttrs(id, item)}<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill>${blipXml(rel, item.opacity)}<a:srcRect/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrm(item.frame)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  );
}

function borderXml(tag: string, border: ResolvedLine | null, opacity: number): string {
  if (!border) return `<a:${tag} w="0"><a:noFill/></a:${tag}>`;
  return `<a:${tag} w="${emu(border.width)}">${solidFill(border.color, opacity)}<a:prstDash val="${DASH[border.dash]}"/></a:${tag}>`;
}

function tableXml(writer: PartWriter, item: ResolvedTableItem): string {
  const id = writer.nextShapeId();
  if (item.frame.rotation) {
    writer.report.add({
      severity: 'approximated',
      code: 'table-rotation',
      message: 'PowerPoint tables cannot rotate; the table was exported upright.',
      slideId: writer.ownerId,
      elementId: item.id,
    });
  }
  const context = textContext(writer, item);
  const cellAt = new Map(item.cells.map((cell) => [`${cell.rowId}:${cell.columnId}`, cell]));
  // Which grid positions are covered by a merged cell, and by which.
  const covered = new Map<string, { hMerge: boolean; vMerge: boolean }>();
  for (const cell of item.cells) {
    const row = item.rowIds.indexOf(cell.rowId);
    const column = item.columnIds.indexOf(cell.columnId);
    for (let r = 0; r < cell.rowSpan; r += 1) {
      for (let c = 0; c < cell.colSpan; c += 1) {
        if (r === 0 && c === 0) continue;
        const key = `${item.rowIds[row + r]}:${item.columnIds[column + c]}`;
        covered.set(key, { hMerge: c > 0, vMerge: r > 0 });
      }
    }
  }
  const rows = item.rowIds
    .map((rowId, rowIndex) => {
      const cells = item.columnIds
        .map((columnId) => {
          const key = `${rowId}:${columnId}`;
          const merge = covered.get(key);
          const cell = cellAt.get(key);
          const borders = ['lnL', 'lnR', 'lnT', 'lnB']
            .map((tag) => borderXml(tag, item.border, item.opacity))
            .join('');
          if (merge || !cell) {
            return (
              `<a:tc${merge?.hMerge ? ' hMerge="1"' : ''}${merge?.vMerge ? ' vMerge="1"' : ''}>` +
              `<a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p></a:txBody><a:tcPr>${borders}</a:tcPr></a:tc>`
            );
          }
          const [left, top, right, bottom] = cell.text.insets;
          const anchor = { top: 't', middle: 'ctr', bottom: 'b' }[cell.text.verticalAlign];
          return (
            `<a:tc${cell.colSpan > 1 ? ` gridSpan="${cell.colSpan}"` : ''}${cell.rowSpan > 1 ? ` rowSpan="${cell.rowSpan}"` : ''}>` +
            textBodyXml(cell.text, context, 'a:txBody') +
            `<a:tcPr marL="${emu(left)}" marR="${emu(right)}" marT="${emu(top)}" marB="${emu(bottom)}" anchor="${anchor}">` +
            `${borders}${fillXml(cell.fill, item.opacity)}</a:tcPr></a:tc>`
          );
        })
        .join('');
      return `<a:tr h="${emu(item.rowHeights[rowIndex] ?? 0)}">${cells}</a:tr>`;
    })
    .join('');
  const grid = item.columnWidths.map((width) => `<a:gridCol w="${emu(width)}"/>`).join('');
  const frame = { ...item.frame, rotation: 0, flipH: false, flipV: false };
  return (
    `<p:graphicFrame><p:nvGraphicFramePr>${nameAttrs(id, item)}<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `${xfrm(frame, 'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
    `<a:tbl><a:tblPr${item.headerRow ? ' firstRow="1"' : ''}/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl>` +
    '</a:graphicData></a:graphic></p:graphicFrame>'
  );
}

function chartFrameXml(writer: PartWriter, item: Extract<ResolvedItem, { kind: 'chart' }>): string {
  const id = writer.nextShapeId();
  const rel = writer.chart(item);
  if (item.frame.rotation) {
    writer.report.add({
      severity: 'approximated',
      code: 'chart-rotation',
      message: 'PowerPoint charts cannot rotate; the chart was exported upright.',
      slideId: writer.ownerId,
      elementId: item.id,
    });
  }
  const frame = { ...item.frame, rotation: 0, flipH: false, flipV: false };
  return (
    `<p:graphicFrame><p:nvGraphicFramePr>${nameAttrs(id, item)}<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `${xfrm(frame, 'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
    `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rel}"/>` +
    '</a:graphicData></a:graphic></p:graphicFrame>'
  );
}

/** One resolved item as its PresentationML element. */
export function itemXml(writer: PartWriter, item: ResolvedItem): string {
  switch (item.kind) {
    case 'shape':
      return shapeXml(writer, item);
    case 'line':
      return lineItemXml(writer, item);
    case 'image':
      return pictureXml(writer, item);
    case 'table':
      return tableXml(writer, item);
    case 'chart':
      return chartFrameXml(writer, item);
    case 'embed':
      return embedXml(writer, item);
  }
}

/** The axis-aligned box around frames, for a group's transform. */
function bounds(frames: Array<ResolvedItem['frame']>) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const frame of frames) {
    minX = Math.min(minX, frame.x);
    minY = Math.min(minY, frame.y);
    maxX = Math.max(maxX, frame.x + frame.width);
    maxY = Math.max(maxY, frame.y + frame.height);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * A container's elements in paint order, with groups as real groups. Items
 * are looked up by id in the resolved scene (which flattens groups); an
 * element the scene does not draw (an empty placeholder in playback) is
 * skipped unless `include` says otherwise.
 */
export function containerXml(
  writer: PartWriter,
  container: DeckElementContainer,
  items: ReadonlyMap<string, ResolvedItem>,
): string {
  const write = (element: DeckElement): { xml: string; frames: Array<ResolvedItem['frame']> } => {
    if (element.type !== 'group') {
      const item = items.get(element.id);
      if (!item) return { xml: '', frames: [] };
      writer.report.exported();
      return { xml: itemXml(writer, item), frames: [item.frame] };
    }
    const children = element.childIds
      .map((childId) => container.elements[childId])
      .filter((child): child is DeckElement => Boolean(child))
      .map((child) => write(child));
    const frames = children.flatMap((child) => child.frames);
    const body = children.map((child) => child.xml).join('');
    if (!body) return { xml: '', frames: [] };
    const id = writer.nextShapeId();
    const box = bounds(frames);
    const ext = `<a:off x="${emu(box.x)}" y="${emu(box.y)}"/><a:ext cx="${emu(box.width)}" cy="${emu(box.height)}"/>`;
    const childExt = `<a:chOff x="${emu(box.x)}" y="${emu(box.y)}"/><a:chExt cx="${emu(box.width)}" cy="${emu(box.height)}"/>`;
    return {
      xml:
        `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="${attr(element.name ?? element.id)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr><a:xfrm>${ext}${childExt}</a:xfrm></p:grpSpPr>${body}</p:grpSp>`,
      frames,
    };
  };
  return container.elementOrder
    .map((id) => container.elements[id])
    .filter((element): element is DeckElement => Boolean(element))
    .map((element) => write(element).xml)
    .join('');
}
