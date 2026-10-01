/**
 * `.deck` → `.pptx`: a first-party Office Open XML writer.
 *
 * Phase 0 proved export through PptxGenJS; Phase 7 replaced it, as the
 * contract allowed, because PptxGenJS cannot express what a compatible export
 * needs: placeholders keep their own position only in its masters, its
 * master artwork is limited to a few object kinds, and it has no groups, no
 * theme colours, no fields, and plain-text notes only. This writer owns the
 * whole package:
 *
 * - every master and layout becomes a PowerPoint slide master and layout,
 *   with its artwork, background, and placeholders, so PowerPoint's layout
 *   gallery and "Reset slide" work, and slides link their placeholders to
 *   their layout's;
 * - the deck theme becomes the file's theme (all twelve colours, both fonts);
 * - slide content is written with fully resolved formatting, so what
 *   PowerPoint shows never depends on inheritance it might read differently;
 * - groups stay groups, slide numbers are fields, notes keep formatting,
 *   charts are native and editable, SVG images carry a PNG fallback;
 * - sections, hidden slides, links, alt text, and names are kept.
 *
 * It reads the shared resolved scene, as the SVG and PDF output do, and runs
 * without a DOM, so it can run in a worker. Nothing written approximately is
 * left unsaid: see the report.
 */
import JSZip from 'jszip';

import type {
  DeckDocument,
  DeckElement,
  DeckElementContainer,
  DeckLink,
  DeckPlaceholderType,
} from '../../../types/deck';
import { DeckExportCancelledError } from '../exportPdf';
import { findPlaceholder, resolveDesign, resolveSlide } from '../resolve';
import type { ResolvedItem, ResolvedSlide } from '../resolve';
import { createApproximateMeasurer } from '../textLayout';
import type { DeckTextMeasurer } from '../textLayout';

import { DeckExportReportBuilder } from './exportReport';
import type { DeckExportReport } from './exportReport';
import { chartWorkbookParts, chartXml } from './ooxml/chart';
import { containerXml } from './ooxml/drawing';
import type { PartWriter } from './ooxml/drawing';
import { runProperties, solidFill, textBodyXml } from './ooxml/text';
import { themeXml } from './ooxml/theme';
import { attr, emu, guid, NS, REL, Relationships, text, XML_HEADER } from './ooxml/xml';

export interface DeckPptxExportOptions {
  /** Inline image data keyed by vault path: `data:image/png;base64,...`. */
  assets?: Record<string, string>;
  /** PNG renderings of SVG assets, keyed by vault path, for viewers without SVG. */
  svgFallbacks?: Record<string, string>;
  /** Only these slides, in deck order. Defaults to every slide. */
  slideIds?: string[];
  /** Measures text for shrink-to-fit. Defaults to an approximation (no DOM). */
  measurer?: DeckTextMeasurer;
  /** Font families this machine lacks, with the family Collab drew instead. */
  missingFonts?: Record<string, string>;
  onProgress?: (completed: number, total: number) => void;
  isCancelled?: () => boolean;
}

export interface DeckPptxExportResult {
  bytes: Uint8Array;
  report: DeckExportReport;
}

const PH_TYPE: Record<DeckPlaceholderType, string> = {
  title: 'title',
  subtitle: 'subTitle',
  body: 'body',
  content: 'body',
  picture: 'pic',
  date: 'dt',
  footer: 'ftr',
  slideNumber: 'sldNum',
};

const CT = {
  presentation:
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  layout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  master: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  notesMaster: 'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml',
  notesSlide: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  presProps: 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
  viewProps: 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml',
  tableStyles: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
} as const;

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const SLIDE_ROOT = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"`;
const EMPTY_GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function dataUrlParts(dataUrl: string): { extension: string; bytes: Uint8Array } | null {
  const match = /^data:image\/(png|jpeg|jpg|gif|svg\+xml);base64,(.*)$/is.exec(dataUrl);
  if (!match) return null;
  const extension = match[1].toLowerCase() === 'svg+xml' ? 'svg' : match[1].toLowerCase();
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { extension: extension === 'jpg' ? 'jpeg' : extension, bytes };
}

/** Placeholder ids for one container: title has none, every other one a stable index. */
function placeholderIndexes(
  container: DeckElementContainer,
): Map<string, { type: string; idx: number | null }> {
  const map = new Map<string, { type: string; idx: number | null }>();
  let next = 10;
  for (const id of [...container.elementOrder, ...Object.keys(container.elements)]) {
    const element = container.elements[id];
    if (!element?.placeholder || map.has(id)) continue;
    const type = PH_TYPE[element.placeholder.type] ?? 'body';
    map.set(id, { type, idx: type === 'title' ? null : next++ });
  }
  return map;
}

function phXml(entry: { type: string; idx: number | null }, prompt = false): string {
  return `<p:ph type="${entry.type}"${entry.idx !== null ? ` idx="${entry.idx}"` : ''}${prompt ? ' hasCustomPrompt="1"' : ''}/>`;
}

function backgroundXml(
  slide: ResolvedSlide,
  image: (path: string) => { raster: string } | null,
): string {
  const fill = slide.background;
  if (fill.kind === 'solid') {
    return `<p:bg><p:bgPr>${solidFill(fill.color)}<a:effectLst/></p:bgPr></p:bg>`;
  }
  if (fill.kind === 'image') {
    const rel = image(fill.asset.path);
    if (!rel) return '';
    return `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${rel.raster}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
  }
  return '';
}

function itemsOf(scene: ResolvedSlide, origin: ResolvedItem['origin']): Map<string, ResolvedItem> {
  return new Map(
    scene.items.filter((item) => item.origin === origin).map((item) => [item.id, item]),
  );
}

/** Exports a deck to `.pptx` bytes plus a report of everything not written faithfully. */
export async function exportDeckToPptx(
  deck: DeckDocument,
  options: DeckPptxExportOptions = {},
): Promise<DeckPptxExportResult> {
  const report = new DeckExportReportBuilder();
  const measurer = options.measurer ?? createApproximateMeasurer();
  const files = new Map<string, string | Uint8Array>();
  const overrides = new Map<string, string>();
  const extensions = new Set<string>(['png']);
  const part = (name: string, content: string | Uint8Array, type?: string) => {
    files.set(name, content);
    if (type) overrides.set(`/${name}`, type);
  };
  const cancelled = () => {
    if (options.isCancelled?.()) throw new DeckExportCancelledError();
  };

  const wanted = options.slideIds ? new Set(options.slideIds) : null;
  const slideOrder = deck.slideOrder.filter((id) => !wanted || wanted.has(id));
  const slideNumber = new Map(slideOrder.map((id, index) => [id, index + 1]));

  /* Media, shared by every part ------------------------------------------ */
  const media = new Map<string, { raster: string; svg?: string }>();
  let mediaCount = 0;
  const addMedia = (dataUrl: string): string | null => {
    const parts = dataUrlParts(dataUrl);
    if (!parts) return null;
    mediaCount += 1;
    const name = `ppt/media/image${mediaCount}.${parts.extension}`;
    extensions.add(parts.extension);
    files.set(name, parts.bytes);
    return name;
  };
  const mediaFor = (path: string): { raster: string; svg?: string } | null => {
    const cached = media.get(path);
    if (cached) return cached;
    const data = options.assets?.[path];
    if (!data) return null;
    const isSvg = /^data:image\/svg\+xml/i.test(data);
    let entry: { raster: string; svg?: string } | null = null;
    if (isSvg) {
      const fallback = options.svgFallbacks?.[path];
      const svgPart = addMedia(data);
      const rasterPart = fallback ? addMedia(fallback) : null;
      if (svgPart && rasterPart) entry = { raster: rasterPart, svg: svgPart };
      else if (svgPart) {
        entry = { raster: svgPart };
        report.addOnce({
          severity: 'approximated',
          code: 'svg-no-fallback',
          message:
            'An SVG image was exported without a picture fallback; older PowerPoint versions cannot show it.',
        });
      }
    } else {
      const rasterPart = addMedia(data);
      if (rasterPart) entry = { raster: rasterPart };
    }
    if (entry) media.set(path, entry);
    return entry;
  };

  /* A part writer: one per slide, layout, or master --------------------- */
  let chartCount = 0;
  const slidePartName = (slideId: string) => `slide${slideNumber.get(slideId)}.xml`;
  const writerFor = (
    ownerId: string,
    rels: Relationships,
    container: DeckElementContainer,
    placeholder: (element: DeckElement) => string,
  ): PartWriter => {
    let shapeId = 1;
    return {
      report,
      measurer,
      ownerId,
      nextShapeId: () => ++shapeId,
      image: (path) => {
        const entry = mediaFor(path);
        if (!entry) return null;
        const relative = (name: string) => `../media/${name.split('/').pop()}`;
        return {
          raster: rels.add(REL.image, relative(entry.raster)),
          ...(entry.svg ? { svg: rels.add(REL.image, relative(entry.svg)) } : {}),
        };
      },
      chart: (item) => {
        chartCount += 1;
        const chartName = `ppt/charts/chart${chartCount}.xml`;
        const workbookName = `ppt/embeddings/Microsoft_Excel_Worksheet${chartCount}.xlsx`;
        const chartRels = new Relationships();
        const workbookRel = chartRels.add(
          REL.package,
          `../embeddings/${workbookName.split('/').pop()}`,
        );
        part(chartName, chartXml(item, workbookRel), CT.chart);
        part(`ppt/charts/_rels/chart${chartCount}.xml.rels`, chartRels.toXml());
        pendingWorkbooks.push({ name: workbookName, parts: chartWorkbookParts(item) });
        extensions.add('xlsx');
        report.addOnce({
          severity: 'approximated',
          code: 'chart-layout',
          message:
            'Charts are native and editable; their data, colours, and fonts match, and axis spacing follows the viewer’s chart layout.',
        });
        return rels.add(REL.chart, `../charts/chart${chartCount}.xml`);
      },
      link: (link: DeckLink) => {
        if (link.kind === 'url') {
          if (!/^(https?:|mailto:)/i.test(link.href)) return null;
          return { id: rels.add(REL.hyperlink, link.href, true) };
        }
        if (link.kind === 'slide') {
          if (!slideNumber.has(link.slideId)) return null;
          return {
            id: rels.add(REL.slide, `../slides/${slidePartName(link.slideId)}`),
            action: 'ppaction://hlinksldjump',
          };
        }
        return null;
      },
      placeholder: (item) => {
        const element = container.elements[item.id];
        return element?.placeholder ? placeholder(element) : '';
      },
    };
  };
  const pendingWorkbooks: Array<{ name: string; parts: Record<string, string> }> = [];

  /* Themes, masters, and layouts ----------------------------------------- */
  const themeParts = new Map<string, string>();
  const themeFor = (themeId: string) => {
    let name = themeParts.get(themeId);
    if (!name) {
      name = `theme${themeParts.size + 1}.xml`;
      themeParts.set(themeId, name);
      part(
        `ppt/theme/${name}`,
        themeXml(deck.themes[themeId], deck.themes[themeId]?.name ?? 'Collab'),
        CT.theme,
      );
    }
    return name;
  };
  themeFor(deck.themeId);

  const masterIds = Object.keys(deck.masters).sort();
  const layoutsByMaster = new Map<string, string[]>();
  for (const [id, layout] of Object.entries(deck.layouts)) {
    const list = layoutsByMaster.get(layout.masterId) ?? [];
    list.push(id);
    layoutsByMaster.set(layout.masterId, list);
  }
  const layoutPart = new Map<string, string>();
  const layoutPlaceholders = new Map<string, Map<string, { type: string; idx: number | null }>>();
  const masterParts: string[] = [];
  let layoutCount = 0;
  let blankLayout = 'slideLayout1.xml';
  let nextLayoutId = 2_147_483_648 + masterIds.length;

  masterIds.forEach((masterId, masterIndex) => {
    const master = deck.masters[masterId];
    const masterName = `slideMaster${masterIndex + 1}.xml`;
    masterParts.push(masterName);
    const masterRels = new Relationships();
    const masterPh = placeholderIndexes(master);
    const scene = resolveDesign(deck, { kind: 'master', id: masterId });
    const writer = writerFor(masterId, masterRels, master, (element) =>
      phXml(masterPh.get(element.id)!),
    );
    const shapes = containerXml(writer, master, itemsOf(scene, 'master'));

    const layoutEntries: string[] = [];
    for (const layoutId of (layoutsByMaster.get(masterId) ?? []).sort((a, b) =>
      (deck.layouts[a].name ?? a).localeCompare(deck.layouts[b].name ?? b),
    )) {
      const layout = deck.layouts[layoutId];
      layoutCount += 1;
      const name = `slideLayout${layoutCount}.xml`;
      layoutPart.set(layoutId, name);
      const rels = new Relationships();
      rels.add(REL.slideMaster, `../slideMasters/${masterName}`);
      const indexes = placeholderIndexes(layout);
      layoutPlaceholders.set(layoutId, indexes);
      const layoutScene = resolveDesign(deck, { kind: 'layout', id: layoutId });
      const layoutWriter = writerFor(layoutId, rels, layout, (element) =>
        phXml(indexes.get(element.id)!, true),
      );
      const layoutShapes = containerXml(layoutWriter, layout, itemsOf(layoutScene, 'layout'));
      part(
        `ppt/slideLayouts/${name}`,
        `${XML_HEADER}<p:sldLayout ${SLIDE_ROOT} preserve="1"${layout.showMasterElements === false ? ' showMasterSp="0"' : ''}>` +
          `<p:cSld name="${attr(layout.name)}">${layout.background ? backgroundXml(layoutScene, layoutWriter.image) : ''}<p:spTree>${EMPTY_GROUP}${layoutShapes}</p:spTree></p:cSld>` +
          '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
        CT.layout,
      );
      part(`ppt/slideLayouts/_rels/${name}.rels`, rels.toXml());
      const relId = masterRels.add(REL.slideLayout, `../slideLayouts/${name}`);
      layoutEntries.push(`<p:sldLayoutId id="${nextLayoutId++}" r:id="${relId}"/>`);
    }
    // A master needs at least one layout, and slides with no layout use a blank one.
    const needsBlank =
      layoutEntries.length === 0 ||
      (masterIndex === 0 && slideOrder.some((id) => !deck.slides[id]?.layoutId));
    if (needsBlank) {
      layoutCount += 1;
      const name = `slideLayout${layoutCount}.xml`;
      if (masterIndex === 0) blankLayout = name;
      const rels = new Relationships();
      rels.add(REL.slideMaster, `../slideMasters/${masterName}`);
      part(
        `ppt/slideLayouts/${name}`,
        `${XML_HEADER}<p:sldLayout ${SLIDE_ROOT} preserve="1" type="blank"><p:cSld name="Blank"><p:spTree>${EMPTY_GROUP}</p:spTree></p:cSld>` +
          '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
        CT.layout,
      );
      part(`ppt/slideLayouts/_rels/${name}.rels`, rels.toXml());
      const relId = masterRels.add(REL.slideLayout, `../slideLayouts/${name}`);
      layoutEntries.push(`<p:sldLayoutId id="${nextLayoutId++}" r:id="${relId}"/>`);
    }
    masterRels.add(REL.theme, `../theme/${themeFor(master.themeId ?? deck.themeId)}`);

    // Default text styles: what PowerPoint uses for new text in these placeholders.
    const styleOf = (type: string) => {
      const item = scene.items.find(
        (entry) =>
          entry.origin === 'master' &&
          entry.kind === 'shape' &&
          masterPh.get(entry.id)?.type === type,
      );
      const run =
        item?.kind === 'shape' ? (item.text?.paragraphs[0]?.runs[0]?.style ?? null) : null;
      return run
        ? `<a:lvl1pPr marL="0" indent="0">${type === 'title' ? '' : '<a:buNone/>'}${runProperties(run, { opacity: 1, report }, '', 'a:defRPr')}</a:lvl1pPr>`
        : '<a:lvl1pPr marL="0" indent="0"><a:defRPr/></a:lvl1pPr>';
    };
    part(
      `ppt/slideMasters/${masterName}`,
      `${XML_HEADER}<p:sldMaster ${SLIDE_ROOT}><p:cSld>${backgroundXml(scene, writer.image) || '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'}<p:spTree>${EMPTY_GROUP}${shapes}</p:spTree></p:cSld>` +
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
        `<p:sldLayoutIdLst>${layoutEntries.join('')}</p:sldLayoutIdLst>` +
        `<p:txStyles><p:titleStyle>${styleOf('title')}</p:titleStyle><p:bodyStyle>${styleOf('body')}</p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`,
      CT.master,
    );
    part(`ppt/slideMasters/_rels/${masterName}.rels`, masterRels.toXml());
  });

  /* Notes master -------------------------------------------------------- */
  const notesTheme = `theme${themeParts.size + 1}.xml`;
  part(`ppt/theme/${notesTheme}`, themeXml(deck.themes[deck.themeId], 'Notes'), CT.theme);
  const notesMasterRels = new Relationships();
  notesMasterRels.add(REL.theme, `../theme/${notesTheme}`);
  part(
    'ppt/notesMasters/notesMaster1.xml',
    `${XML_HEADER}<p:notesMaster ${SLIDE_ROOT}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${EMPTY_GROUP}` +
      '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:xfrm><a:off x="381000" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr></p:sp>' +
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr><a:xfrm><a:off x="685800" y="4343400"/><a:ext cx="5486400" cy="4114800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
      '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>' +
      '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:notesMaster>',
    CT.notesMaster,
  );
  part('ppt/notesMasters/_rels/notesMaster1.xml.rels', notesMasterRels.toXml());

  /* Slides --------------------------------------------------------------- */
  const slideEntries: string[] = [];
  const presentationRels = new Relationships();
  const masterEntries = masterParts.map((name, index) => {
    const id = presentationRels.add(REL.slideMaster, `slideMasters/${name}`);
    return `<p:sldMasterId id="${2_147_483_648 + index}" r:id="${id}"/>`;
  });
  const sldIds = new Map<string, number>();

  for (const [index, slideId] of slideOrder.entries()) {
    cancelled();
    const source = deck.slides[slideId];
    const scene = resolveSlide(deck, slideId);
    const name = `slide${index + 1}.xml`;
    const rels = new Relationships();
    const layoutId = source.layoutId;
    const layoutName = layoutId ? layoutPart.get(layoutId) : undefined;
    rels.add(REL.slideLayout, `../slideLayouts/${layoutName ?? blankLayout}`);
    const layout = layoutId ? deck.layouts[layoutId] : undefined;
    const indexes = layoutId ? layoutPlaceholders.get(layoutId) : undefined;
    const writer = writerFor(slideId, rels, source, (element) => {
      const match = findPlaceholder(layout, element.placeholder);
      const entry = match ? indexes?.get(match.id) : undefined;
      return entry ? phXml(entry) : '';
    });
    const shapes = containerXml(writer, source, itemsOf(scene, 'slide'));
    part(
      `ppt/slides/${name}`,
      `${XML_HEADER}<p:sld ${SLIDE_ROOT}${scene.hidden ? ' show="0"' : ''}>` +
        `<p:cSld${source.name ? ` name="${attr(source.name)}"` : ''}>${backgroundXml(scene, writer.image)}<p:spTree>${EMPTY_GROUP}${shapes}</p:spTree></p:cSld>` +
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>',
      CT.slide,
    );

    // Speaker notes, with their formatting.
    if (scene.notes && scene.notes.paragraphs.length > 0) {
      const notesName = `notesSlide${index + 1}.xml`;
      const notesRels = new Relationships();
      notesRels.add(REL.notesMaster, '../notesMasters/notesMaster1.xml');
      notesRels.add(REL.slide, `../slides/${name}`);
      const body = textBodyXml(
        scene.notes,
        {
          report,
          slideId,
          elementId: 'notes',
          opacity: 1,
          link: (link) =>
            link.kind === 'url' && /^(https?:|mailto:)/i.test(link.href)
              ? { id: notesRels.add(REL.hyperlink, link.href, true) }
              : null,
          slideNumberField: false,
        },
        'p:txBody',
      );
      part(
        `ppt/notesSlides/${notesName}`,
        `${XML_HEADER}<p:notes ${SLIDE_ROOT}><p:cSld><p:spTree>${EMPTY_GROUP}` +
          '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
          `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>${body}</p:sp>` +
          '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>',
        CT.notesSlide,
      );
      part(`ppt/notesSlides/_rels/${notesName}.rels`, notesRels.toXml());
      rels.add(REL.notesSlide, `../notesSlides/${notesName}`);
    }
    part(`ppt/slides/_rels/${name}.rels`, rels.toXml());

    const relId = presentationRels.add(REL.slide, `slides/${name}`);
    const sldId = 256 + index;
    sldIds.set(slideId, sldId);
    slideEntries.push(`<p:sldId id="${sldId}" r:id="${relId}"/>`);

    if (source.transition && source.transition.kind !== 'none') {
      report.add({
        severity: 'omitted',
        code: 'transition',
        message: 'Slide transitions are not exported yet.',
        slideId,
      });
    }
    if (source.animations?.length) {
      report.add({
        severity: 'omitted',
        code: 'animation',
        message: 'Animations are not exported yet.',
        slideId,
      });
    }
    options.onProgress?.(index + 1, slideOrder.length);
    // Let a worker's cancel message in between slides.
    await Promise.resolve();
  }
  cancelled();

  /* Fonts ---------------------------------------------------------------- */
  for (const [family, fallback] of Object.entries(options.missingFonts ?? {})) {
    report.add({
      severity: 'approximated',
      code: 'font-missing',
      message: `${family} is not installed here; Collab drew it with ${fallback}. The file asks for ${family}, and viewers without it substitute their own.`,
    });
  }

  /* Presentation and package parts --------------------------------------- */
  const notesMasterRel = presentationRels.add(REL.notesMaster, 'notesMasters/notesMaster1.xml');
  presentationRels.add(REL.presProps, 'presProps.xml');
  presentationRels.add(REL.viewProps, 'viewProps.xml');
  presentationRels.add(REL.theme, `theme/${themeFor(deck.themeId)}`);
  presentationRels.add(REL.tableStyles, 'tableStyles.xml');

  const sections = (deck.sections ?? [])
    .map((section, index, all) => {
      const start = deck.slideOrder.indexOf(section.firstSlideId);
      const end = all
        .slice(index + 1)
        .map((next) => deck.slideOrder.indexOf(next.firstSlideId))
        .filter((at) => at > start)
        .reduce((min, at) => Math.min(min, at), deck.slideOrder.length);
      const ids = deck.slideOrder
        .slice(Math.max(0, start), end)
        .map((id) => sldIds.get(id))
        .filter((id): id is number => id !== undefined);
      return ids.length
        ? `<p14:section name="${attr(section.name)}" id="${guid(section.id)}"><p14:sldIdLst>${ids.map((id) => `<p14:sldId id="${id}"/>`).join('')}</p14:sldIdLst></p14:section>`
        : '';
    })
    .filter(Boolean);
  const sectionXml = sections.length
    ? `<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="${NS.p14}">${sections.join('')}</p14:sectionLst></p:ext></p:extLst>`
    : '';

  part(
    'ppt/presentation.xml',
    `${XML_HEADER}<p:presentation ${SLIDE_ROOT} saveSubsetFonts="1">` +
      `<p:sldMasterIdLst>${masterEntries.join('')}</p:sldMasterIdLst>` +
      `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterRel}"/></p:notesMasterIdLst>` +
      `<p:sldIdLst>${slideEntries.join('')}</p:sldIdLst>` +
      `<p:sldSz cx="${emu(deck.size.width)}" cy="${emu(deck.size.height)}"/><p:notesSz cx="6858000" cy="9144000"/>` +
      `${sectionXml}</p:presentation>`,
    CT.presentation,
  );
  part('ppt/_rels/presentation.xml.rels', presentationRels.toXml());
  part('ppt/presProps.xml', `${XML_HEADER}<p:presentationPr ${SLIDE_ROOT}/>`, CT.presProps);
  part(
    'ppt/viewProps.xml',
    `${XML_HEADER}<p:viewPr ${SLIDE_ROOT}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
    CT.viewProps,
  );
  part(
    'ppt/tableStyles.xml',
    `${XML_HEADER}<a:tblStyleLst xmlns:a="${NS.a}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    CT.tableStyles,
  );
  part(
    'docProps/core.xml',
    `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
      `<dc:title>${text(deck.name)}</dc:title><dc:creator>Collab</dc:creator>` +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${text(deck.createdAt)}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${text(deck.updatedAt)}</dcterms:modified></cp:coreProperties>`,
    CT.core,
  );
  part(
    'docProps/app.xml',
    `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Collab</Application><Slides>${slideOrder.length}</Slides><Notes>${[...files.keys()].filter((name) => name.startsWith('ppt/notesSlides/notesSlide')).length}</Notes></Properties>`,
    CT.app,
  );
  const rootRels = new Relationships();
  rootRels.add(REL.officeDocument, 'ppt/presentation.xml');
  rootRels.add(REL.coreProps, 'docProps/core.xml');
  rootRels.add(REL.extendedProps, 'docProps/app.xml');
  part('_rels/.rels', rootRels.toXml());

  // Embedded chart workbooks are themselves small zip packages.
  for (const workbook of pendingWorkbooks) {
    const inner = new JSZip();
    for (const [name, content] of Object.entries(workbook.parts)) {
      inner.file(name, content, { createFolders: false });
    }
    files.set(
      workbook.name,
      await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
    );
  }

  const contentTypes =
    `${XML_HEADER}<Types xmlns="${NS.ct}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    [...extensions]
      .map(
        (extension) =>
          `<Default Extension="${extension}" ContentType="${MEDIA_TYPES[extension]}"/>`,
      )
      .join('') +
    [...overrides.entries()]
      .map(([name, type]) => `<Override PartName="${attr(name)}" ContentType="${type}"/>`)
      .join('') +
    '</Types>';

  const zip = new JSZip();
  // `[Content_Types].xml` first, as some readers expect.
  // No folder entries: Office Open XML packages hold parts only.
  zip.file('[Content_Types].xml', contentTypes, { createFolders: false });
  for (const [name, content] of files) zip.file(name, content, { createFolders: false });
  const bytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
  return { bytes, report: report.build(slideOrder.length) };
}
