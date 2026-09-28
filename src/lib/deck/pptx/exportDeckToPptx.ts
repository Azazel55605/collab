/**
 * `.deck` → `.pptx` export through an isolated PptxGenJS adapter.
 *
 * The boundary rules this module exists to enforce:
 *
 * - PptxGenJS types never leave `src/lib/deck/pptx/`. The editor, the
 *   collaboration layer, and `.deck` itself know nothing about it.
 * - The library is imported lazily, so it costs nothing until someone exports.
 * - Export consumes the shared `ResolvedSlide`, exactly as the SVG renderer
 *   does, so PowerPoint receives the same geometry, colours, and fonts the
 *   editor shows. Units convert only through `units.ts` (deck units → inches,
 *   which PptxGenJS turns into EMU; every deck unit is exactly 127 EMU).
 * - Anything not written faithfully is recorded in the export report.
 *
 * Phase 0 scope: masters and layouts are flattened into each slide rather than
 * mapped onto PowerPoint masters. Mapping them is Phase 7, and the report says
 * so on every export until then.
 */
import type PptxGenJS from 'pptxgenjs';

import type { DeckDocument } from '../../../types/deck';
import { OOXML_PRESET } from '../geometry';
import { resolveDeck } from '../resolve';
import type { ResolvedFill, ResolvedItem, ResolvedLine, ResolvedSlide } from '../resolve';
import { rotationToDegrees, unitsToInches, unitsToPoints } from '../units';

import { DeckExportReportBuilder } from './exportReport';
import type { DeckExportReport } from './exportReport';
import { hex, mapTextBody, plainNotes, transparency } from './mapText';
import type { TextMapContext } from './mapText';

export interface DeckPptxExportOptions {
  /** Inline image data keyed by vault path: `data:image/png;base64,...`. */
  assets?: Record<string, string>;
  /** Only these slides, in deck order. Defaults to every slide. */
  slideIds?: string[];
}

export interface DeckPptxExportResult {
  bytes: Uint8Array;
  report: DeckExportReport;
}

type Pptx = InstanceType<typeof PptxGenJS>;
type Slide = PptxGenJS.Slide;

const DASH: Record<ResolvedLine['dash'], NonNullable<PptxGenJS.ShapeLineProps['dashType']>> = {
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

function position(frame: ResolvedItem['frame']) {
  return {
    x: unitsToInches(frame.x),
    y: unitsToInches(frame.y),
    w: unitsToInches(frame.width),
    h: unitsToInches(frame.height),
    ...(frame.rotation ? { rotate: rotationToDegrees(frame.rotation) } : {}),
    ...(frame.flipH ? { flipH: true } : {}),
    ...(frame.flipV ? { flipV: true } : {}),
  };
}

function fillProps(fill: ResolvedFill, opacity: number): PptxGenJS.ShapeFillProps | undefined {
  if (fill.kind !== 'solid') return undefined;
  const alpha = transparency(fill.color.alpha, opacity);
  return { color: hex(fill.color), ...(alpha !== undefined ? { transparency: alpha } : {}) };
}

function lineProps(
  line: ResolvedLine | null,
  opacity: number,
): PptxGenJS.ShapeLineProps | undefined {
  if (!line) return undefined;
  const alpha = transparency(line.color.alpha, opacity);
  return {
    color: hex(line.color),
    width: unitsToPoints(line.width),
    dashType: DASH[line.dash],
    ...(alpha !== undefined ? { transparency: alpha } : {}),
  };
}

/** PptxGenJS orders a margin array [left, right, bottom, top], contrary to its docs. */
function margin(insets: [number, number, number, number]): [number, number, number, number] {
  const [left, top, right, bottom] = insets.map(unitsToPoints) as [number, number, number, number];
  return [left, right, bottom, top];
}

function exportItem(
  pptx: Pptx,
  slide: Slide,
  item: ResolvedItem,
  resolved: ResolvedSlide,
  options: DeckPptxExportOptions,
  report: DeckExportReportBuilder,
  slideNumbers: Map<string, number>,
): void {
  const context: TextMapContext = {
    report,
    slideId: resolved.slideId,
    elementId: item.id,
    slideNumbers,
    opacity: item.opacity,
  };
  const note = (
    severity: 'approximated' | 'flattened' | 'omitted' | 'missing',
    code: string,
    message: string,
  ) => report.add({ severity, code, message, slideId: resolved.slideId, elementId: item.id });

  switch (item.kind) {
    case 'shape': {
      const shapeName = OOXML_PRESET[item.geometry] as PptxGenJS.SHAPE_NAME;
      const common = {
        ...position(item.frame),
        shape: shapeName,
        objectName: item.name ?? item.id,
        ...(item.altText ? { altText: item.altText } : {}),
        fill: fillProps(item.fill, item.opacity),
        line: lineProps(item.line, item.opacity),
      };
      if (item.fill.kind === 'image')
        note('omitted', 'image-fill', 'Image fills are not exported yet.');
      if (item.placeholder === 'slideNumber') {
        note(
          'approximated',
          'slide-number-static',
          'The slide number was exported as fixed text, not a live field.',
        );
      }
      if (item.text && item.text.paragraphs.some((paragraph) => paragraph.runs.length > 0)) {
        slide.addText(mapTextBody(item.text, context), {
          ...common,
          margin: margin(item.text.insets),
          valign: item.text.verticalAlign,
          wrap: item.text.wrap,
          ...(item.text.autoFit === 'shrink' ? { fit: 'shrink' } : {}),
          ...(item.text.autoFit === 'grow' ? { fit: 'resize' } : {}),
        });
      } else {
        slide.addShape(shapeName, common);
      }
      break;
    }
    case 'line': {
      const { from, to } = item;
      slide.addShape(pptx.ShapeType.line, {
        x: unitsToInches(Math.min(from.x, to.x)),
        y: unitsToInches(Math.min(from.y, to.y)),
        w: unitsToInches(Math.abs(to.x - from.x)),
        h: unitsToInches(Math.abs(to.y - from.y)),
        // OOXML lines run top-left to bottom-right; flips express the other diagonals.
        ...(to.x < from.x ? { flipH: true } : {}),
        ...(to.y < from.y ? { flipV: true } : {}),
        objectName: item.name ?? item.id,
        line: {
          ...lineProps(item.line, item.opacity),
          beginArrowType: ARROW[item.startArrow],
          endArrowType: ARROW[item.endArrow],
        },
      });
      break;
    }
    case 'image': {
      const data = options.assets?.[item.asset.path];
      if (!data || !/^data:image\/(png|jpeg|gif|svg\+xml);base64,/i.test(data)) {
        report.missingAsset(item.asset.path);
        note(
          'missing',
          'missing-image',
          `The image ${item.asset.path} was not available and was exported as a placeholder.`,
        );
        slide.addShape(pptx.ShapeType.rect, {
          ...position(item.frame),
          fill: { color: 'F3F4F6' },
          line: { color: '9CA3AF', width: 1, dashType: 'dash' },
        });
        break;
      }
      // PptxGenJS crops by drawing the full image at (w, h) and showing the box
      // (x, y, w, h) of it. Size the full image so the visible part fills the frame.
      const { crop, frame } = item;
      const visibleX = (1_000 - crop.left - crop.right) / 1_000;
      const visibleY = (1_000 - crop.top - crop.bottom) / 1_000;
      const fullW = unitsToInches(frame.width) / visibleX;
      const fullH = unitsToInches(frame.height) / visibleY;
      const cropped = crop.left || crop.top || crop.right || crop.bottom;
      slide.addImage({
        ...position(frame),
        data: data.replace(/^data:/, ''),
        objectName: item.name ?? item.id,
        ...(item.altText ? { altText: item.altText } : {}),
        ...(item.opacity < 1 ? { transparency: Math.round((1 - item.opacity) * 100) } : {}),
        ...(cropped
          ? {
              w: fullW,
              h: fullH,
              sizing: {
                type: 'crop',
                x: (fullW * crop.left) / 1_000,
                y: (fullH * crop.top) / 1_000,
                w: unitsToInches(frame.width),
                h: unitsToInches(frame.height),
              },
            }
          : {}),
      });
      if (item.line) note('omitted', 'image-border', 'Image borders are not exported yet.');
      break;
    }
    case 'table': {
      const rows: PptxGenJS.TableRow[] = item.rowIds.map((rowId) =>
        item.cells
          .filter((cell) => cell.rowId === rowId)
          .map((cell) => ({
            text: mapTextBody(cell.text, context),
            options: {
              ...(cell.rowSpan > 1 ? { rowspan: cell.rowSpan } : {}),
              ...(cell.colSpan > 1 ? { colspan: cell.colSpan } : {}),
              fill: fillProps(cell.fill, item.opacity),
              margin: margin(cell.text.insets),
              valign: cell.text.verticalAlign,
            },
          })),
      );
      slide.addTable(rows, {
        x: unitsToInches(item.frame.x),
        y: unitsToInches(item.frame.y),
        w: unitsToInches(item.frame.width),
        colW: item.columnWidths.map(unitsToInches),
        rowH: item.rowHeights.map(unitsToInches),
        ...(item.border
          ? {
              border: {
                type: 'solid',
                color: hex(item.border.color),
                pt: unitsToPoints(item.border.width),
              },
            }
          : {}),
      });
      if (item.frame.rotation)
        note(
          'approximated',
          'table-rotation',
          'PowerPoint tables cannot rotate; the table was exported upright.',
        );
      break;
    }
    case 'chart': {
      const type =
        item.chartKind === 'column' || item.chartKind === 'bar'
          ? pptx.ChartType.bar
          : pptx.ChartType[item.chartKind];
      slide.addChart(
        type,
        item.series.map((series) => ({
          name: series.name,
          labels: item.categories,
          values: series.values,
        })),
        {
          ...position(item.frame),
          ...(item.chartKind === 'column'
            ? { barDir: 'col' }
            : item.chartKind === 'bar'
              ? { barDir: 'bar' }
              : {}),
          chartColors: item.series.map((series) => hex(series.color)),
          showLegend: item.showLegend,
          ...(item.title ? { showTitle: true, title: item.title } : {}),
        },
      );
      note(
        'approximated',
        'chart-styling',
        'Chart data and colours are exported; axis and label styling uses PowerPoint defaults.',
      );
      break;
    }
    case 'embed':
      note('omitted', 'embed', `The linked ${item.source.path} preview is not exported yet.`);
      return;
  }
  report.exported();
}

/** Exports a deck to `.pptx` bytes plus a report of everything not written faithfully. */
export async function exportDeckToPptx(
  deck: DeckDocument,
  options: DeckPptxExportOptions = {},
): Promise<DeckPptxExportResult> {
  const { default: PptxGenJSClass } = await import('pptxgenjs');
  const pptx: Pptx = new PptxGenJSClass();
  const report = new DeckExportReportBuilder();

  pptx.defineLayout({
    name: 'COLLAB_DECK',
    width: unitsToInches(deck.size.width),
    height: unitsToInches(deck.size.height),
  });
  pptx.layout = 'COLLAB_DECK';
  pptx.title = deck.name;
  pptx.company = 'Collab';

  const wanted = options.slideIds ? new Set(options.slideIds) : null;
  const slides = resolveDeck(deck).filter((slide) => !wanted || wanted.has(slide.slideId));
  const slideNumbers = new Map(slides.map((slide, index) => [slide.slideId, index + 1]));

  report.addOnce({
    severity: 'flattened',
    code: 'masters-flattened',
    message:
      'Masters and layouts were applied to each slide rather than exported as PowerPoint masters.',
  });

  const sectionStarts = new Map(
    (deck.sections ?? []).map((section) => [section.firstSlideId, section.name]),
  );
  let currentSection: string | undefined;

  for (const resolved of slides) {
    const sectionTitle = sectionStarts.get(resolved.slideId);
    if (sectionTitle !== undefined) {
      pptx.addSection({ title: sectionTitle });
      currentSection = sectionTitle;
    }
    const slide = pptx.addSlide(currentSection ? { sectionTitle: currentSection } : undefined);
    if (resolved.hidden) slide.hidden = true;

    if (resolved.background.kind === 'solid') {
      const alpha = transparency(resolved.background.color.alpha);
      slide.background = {
        color: hex(resolved.background.color),
        ...(alpha !== undefined ? { transparency: alpha } : {}),
      };
    } else if (resolved.background.kind === 'image') {
      const data = options.assets?.[resolved.background.asset.path];
      if (data) slide.background = { data: data.replace(/^data:/, '') };
      else report.missingAsset(resolved.background.asset.path);
    }

    for (const item of resolved.items) {
      exportItem(pptx, slide, item, resolved, options, report, slideNumbers);
    }

    if (resolved.notes) {
      slide.addNotes(plainNotes(resolved.notes));
      const styled = resolved.notes.paragraphs.some((paragraph) =>
        paragraph.runs.some(
          (run) => run.kind === 'text' && (run.style.bold || run.style.italic || run.link),
        ),
      );
      if (styled) {
        report.add({
          severity: 'flattened',
          code: 'notes-plain',
          message: 'Speaker note formatting was exported as plain text.',
          slideId: resolved.slideId,
        });
      }
    }

    const source = deck.slides[resolved.slideId];
    if (source.transition && source.transition.kind !== 'none') {
      report.add({
        severity: 'omitted',
        code: 'transition',
        message: 'Slide transitions are not exported yet.',
        slideId: resolved.slideId,
      });
    }
    if (source.animations?.length) {
      report.add({
        severity: 'omitted',
        code: 'animation',
        message: 'Animations are not exported yet.',
        slideId: resolved.slideId,
      });
    }
    const groups = Object.values(source.elements).filter((element) => element.type === 'group');
    for (const group of groups) {
      report.add({
        severity: 'flattened',
        code: 'group-flattened',
        message: 'Grouped objects were exported individually.',
        slideId: resolved.slideId,
        elementId: group.id,
      });
    }
  }

  const output = (await pptx.write({ outputType: 'uint8array', compression: true })) as Uint8Array;
  return { bytes: await repairParagraphProperties(output), report: report.build(slides.length) };
}

const PARAGRAPH = /<a:p>([\s\S]*?)<\/a:p>/g;
const PARAGRAPH_PROPERTIES = /<a:pPr\b[^>]*\/>|<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>/g;

/**
 * Keeps only the first `<a:pPr>` of each paragraph, as its first child.
 *
 * PptxGenJS 4.0.1 writes a `<a:pPr>` before every run of a multi-run
 * paragraph. OOXML allows one, first. LibreOffice applies the last — usually
 * `buNone` with no margin, which silently drops the bullet and indent — and
 * PowerPoint may offer to repair the file. Found by the Phase 0 LibreOffice
 * render; see the contract.
 */
export function repairParagraphXml(xml: string): string {
  return xml.replace(PARAGRAPH, (whole, inner: string) => {
    const properties = inner.match(PARAGRAPH_PROPERTIES);
    if (!properties || (properties.length === 1 && inner.startsWith(properties[0]))) return whole;
    return `<a:p>${properties[0]}${inner.replace(PARAGRAPH_PROPERTIES, '')}</a:p>`;
  });
}

async function repairParagraphProperties(bytes: Uint8Array): Promise<Uint8Array> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const parts = Object.keys(zip.files).filter((name) =>
    /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(name),
  );
  for (const name of parts) {
    const xml = await zip.file(name)!.async('string');
    const repaired = repairParagraphXml(xml);
    if (repaired !== xml) zip.file(name, repaired);
  }
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
}
