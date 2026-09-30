/**
 * Deterministic SVG output for a resolved slide.
 *
 * This is the drawing adapter behind thumbnails, presentation playback, slide
 * images, and PDF pages. It reads only the `ResolvedSlide` and a text measurer;
 * it never resolves inheritance or theme values itself (see `resolve.ts`).
 *
 * The SVG's coordinate system is deck units (`viewBox="0 0 W H"`), so the same
 * markup serves every output size. Only the root `width`/`height` change with
 * the target — which is the property `svg.test.ts` pins.
 *
 * Determinism rules, as for ink export: fixed-precision numbers, paint order
 * from the resolved item list, no clock or random reads, every document string
 * XML-escaped, and no external URL ever reaches an `href`.
 */
import type { DeckArrowhead, DeckAssetRef } from '../../types/deck';

import { fmt, shapePath } from './geometry';
import type {
  ResolvedChartItem,
  ResolvedColor,
  ResolvedFill,
  ResolvedItem,
  ResolvedLine,
  ResolvedLineItem,
  ResolvedRunStyle,
  ResolvedSlide,
  ResolvedTableItem,
  ResolvedTextBody,
} from './resolve';
import { cssFontFamily, layoutText } from './textLayout';
import type { DeckTextMeasurer, LaidOutFragment } from './textLayout';
import { unitsToPx } from './units';

export interface DeckSvgOptions {
  measurer: DeckTextMeasurer;
  /** Output size in CSS pixels. Defaults to the slide's size at 100% zoom. */
  pixelWidth?: number;
  pixelHeight?: number;
  /**
   * Resolves a vault asset to an inline `data:` or `blob:` URL. Anything else
   * is treated as missing, so a document can never make the renderer fetch.
   */
  resolveAsset?: (asset: DeckAssetRef) => string | null;
}

export function escapeXml(value: string): string {
  return (
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // Strip characters XML 1.0 cannot carry at all.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  );
}

function paintAttrs(kind: 'fill' | 'stroke', color: ResolvedColor): string {
  const alpha = color.alpha < 1 ? ` ${kind}-opacity="${fmt(color.alpha)}"` : '';
  return `${kind}="${color.hex}"${alpha}`;
}

function fillAttrs(fill: ResolvedFill): string {
  return fill.kind === 'solid' ? paintAttrs('fill', fill.color) : 'fill="none"';
}

const DASHES: Record<ResolvedLine['dash'], (width: number) => string> = {
  solid: () => '',
  dash: (width) => ` stroke-dasharray="${fmt(width * 4)} ${fmt(width * 3)}"`,
  dot: (width) => ` stroke-dasharray="${fmt(width)} ${fmt(width * 2)}"`,
  dashDot: (width) =>
    ` stroke-dasharray="${fmt(width * 4)} ${fmt(width * 2)} ${fmt(width)} ${fmt(width * 2)}"`,
};

function strokeAttrs(line: ResolvedLine | null): string {
  if (!line) return 'stroke="none"';
  return `${paintAttrs('stroke', line.color)} stroke-width="${fmt(line.width)}"${DASHES[line.dash](line.width)}`;
}

function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  return /^(data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]|blob:)/i.test(href) ? href : null;
}

/** Transform placing a local box at its frame, rotated about its centre. */
function frameTransform(frame: ResolvedItem['frame']): string {
  const parts = [`translate(${fmt(frame.x)} ${fmt(frame.y)})`];
  if (frame.rotation) {
    parts.push(
      `rotate(${fmt(frame.rotation / 100)} ${fmt(frame.width / 2)} ${fmt(frame.height / 2)})`,
    );
  }
  if (frame.flipH || frame.flipV) {
    parts.push(
      `translate(${fmt(frame.flipH ? frame.width : 0)} ${fmt(frame.flipV ? frame.height : 0)})`,
      `scale(${frame.flipH ? -1 : 1} ${frame.flipV ? -1 : 1})`,
    );
  }
  return parts.join(' ');
}

function fragmentSvg(
  fragment: LaidOutFragment,
  baseline: number,
  offsetX: number,
  offsetY: number,
): string {
  const style = fragment.style;
  let size = style.size;
  let y = baseline;
  if (style.baseline !== 'normal') {
    size = style.size * 0.65;
    y += style.baseline === 'superscript' ? -style.size * 0.35 : style.size * 0.15;
  }
  const decorations = [style.underline ? 'underline' : '', style.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ');
  const family = cssFontFamily(style.font);
  return (
    `<text x="${fmt(offsetX + fragment.x)}" y="${fmt(offsetY + y)}" xml:space="preserve"` +
    ` font-family="${escapeXml(family)}" font-size="${fmt(size)}"` +
    `${style.bold ? ' font-weight="700"' : ''}${style.italic ? ' font-style="italic"' : ''}` +
    `${decorations ? ` text-decoration="${decorations}"` : ''} ${paintAttrs('fill', style.color)}>` +
    `${escapeXml(fragment.text)}</text>`
  );
}

function textSvg(
  body: ResolvedTextBody,
  width: number,
  height: number,
  measurer: DeckTextMeasurer,
  offsetX = 0,
  offsetY = 0,
): string {
  const layout = layoutText(body, width, height, measurer);
  const out: string[] = [];
  for (const line of layout.lines) {
    if (line.label) out.push(fragmentSvg(line.label, line.baseline, offsetX, offsetY));
    for (const fragment of line.fragments)
      out.push(fragmentSvg(fragment, line.baseline, offsetX, offsetY));
  }
  return out.join('');
}

function arrowhead(
  kind: DeckArrowhead,
  tip: { x: number; y: number },
  from: { x: number; y: number },
  line: ResolvedLine,
): string {
  if (kind === 'none') return '';
  const size = Math.max(line.width * 3, 600);
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const point = (distance: number, spread: number) => ({
    x: tip.x - Math.cos(angle) * distance + Math.cos(angle + Math.PI / 2) * spread,
    y: tip.y - Math.sin(angle) * distance + Math.sin(angle + Math.PI / 2) * spread,
  });
  const color = paintAttrs('fill', line.color);
  if (kind === 'oval') {
    const centre = point(size / 2, 0);
    return `<circle cx="${fmt(centre.x)}" cy="${fmt(centre.y)}" r="${fmt(size / 2)}" ${color}/>`;
  }
  const left = point(size, size / 2);
  const right = point(size, -size / 2);
  if (kind === 'diamond') {
    const back = point(size, 0);
    const mid1 = point(size / 2, size / 2);
    const mid2 = point(size / 2, -size / 2);
    return `<path d="M${fmt(tip.x)} ${fmt(tip.y)} L${fmt(mid1.x)} ${fmt(mid1.y)} L${fmt(back.x)} ${fmt(back.y)} L${fmt(mid2.x)} ${fmt(mid2.y)} Z" ${color}/>`;
  }
  const d = `M${fmt(left.x)} ${fmt(left.y)} L${fmt(tip.x)} ${fmt(tip.y)} L${fmt(right.x)} ${fmt(right.y)}`;
  return kind === 'open'
    ? `<path d="${d}" fill="none" ${strokeAttrs(line).replace(/ stroke-dasharray="[^"]*"/, '')}/>`
    : `<path d="${d} Z" ${color}/>`;
}

function lineSvg(item: ResolvedLineItem): string {
  const { from, to, line } = item;
  return (
    `<line x1="${fmt(from.x)}" y1="${fmt(from.y)}" x2="${fmt(to.x)}" y2="${fmt(to.y)}" ${strokeAttrs(line)} stroke-linecap="round"/>` +
    arrowhead(item.startArrow, from, to, line) +
    arrowhead(item.endArrow, to, from, line)
  );
}

function missingAsset(
  width: number,
  height: number,
  label: string,
  measurer: DeckTextMeasurer,
): string {
  const style: ResolvedRunStyle = {
    font: { family: 'sans-serif', fallbacks: [] },
    size: Math.max(600, Math.min(1_400, height / 8)),
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    color: { hex: '#6b7280', alpha: 1 },
    baseline: 'normal',
  };
  const text = textSvg(
    {
      paragraphs: [
        {
          id: 'missing',
          align: 'center',
          level: 0,
          label: null,
          indent: 0,
          spaceBefore: 0,
          spaceAfter: 0,
          lineSpacing: 100,
          runs: [{ kind: 'text', text: label, style }],
          endStyle: style,
        },
      ],
      insets: [200, 200, 200, 200],
      verticalAlign: 'middle',
      autoFit: 'shrink',
      wrap: true,
    },
    width,
    height,
    measurer,
  );
  return (
    `<rect width="${fmt(width)}" height="${fmt(height)}" fill="#f3f4f6" stroke="#9ca3af" stroke-width="100" stroke-dasharray="400 300"/>` +
    text
  );
}

/** A linked document with no preview: a card naming it, never a broken image. */
function embedCard(
  width: number,
  height: number,
  title: string,
  path: string,
  measurer: DeckTextMeasurer,
): string {
  const size = Math.max(600, Math.min(2_400, height / 6));
  const style: ResolvedRunStyle = {
    font: { family: 'sans-serif', fallbacks: [] },
    size,
    bold: true,
    italic: false,
    underline: false,
    strike: false,
    color: { hex: '#111827', alpha: 1 },
    baseline: 'normal',
  };
  const fit = (text: string, textStyle: ResolvedRunStyle) => {
    const room = width - size * 2;
    if (measurer.measure(text, textStyle) <= room) return text;
    let cut = text;
    while (cut.length > 1 && measurer.measure(`${cut}…`, textStyle) > room) cut = cut.slice(0, -1);
    return `${cut}…`;
  };
  const small = { ...style, size: size * 0.6, bold: false, color: { hex: '#6b7280', alpha: 1 } };
  return (
    `<rect width="${fmt(width)}" height="${fmt(height)}" rx="${fmt(size * 0.4)}" fill="#f9fafb" stroke="#d1d5db" stroke-width="${fmt(size / 16)}"/>` +
    `<rect width="${fmt(size * 0.3)}" height="${fmt(height)}" fill="#6d5dfc"/>` +
    `<text x="${fmt(size)}" y="${fmt(size * 1.8)}" font-family="sans-serif" font-size="${fmt(size)}" font-weight="700" fill="#111827">${escapeXml(fit(title, style))}</text>` +
    `<text x="${fmt(size)}" y="${fmt(size * 2.9)}" font-family="sans-serif" font-size="${fmt(small.size)}" fill="#6b7280">${escapeXml(fit(path, small))}</text>`
  );
}

function tableSvg(item: ResolvedTableItem, measurer: DeckTextMeasurer): string {
  const out: string[] = [];
  for (const cell of item.cells) {
    const x = cell.x - item.frame.x;
    const y = cell.y - item.frame.y;
    out.push(
      `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(cell.width)}" height="${fmt(cell.height)}" ${fillAttrs(cell.fill)} ${strokeAttrs(item.border)}/>`,
    );
    out.push(textSvg(cell.text, cell.width, cell.height, measurer, x, y));
  }
  return out.join('');
}

function chartSvg(item: ResolvedChartItem, measurer: DeckTextMeasurer): string {
  const { width, height } = item.frame;
  const style = item.textStyle;
  const out: string[] = [];
  const label = (
    text: string,
    x: number,
    y: number,
    anchor: 'start' | 'middle' | 'end',
    size = style.size,
  ) =>
    `<text x="${fmt(x)}" y="${fmt(y)}" text-anchor="${anchor}" font-family="${escapeXml(cssFontFamily(style.font))}" font-size="${fmt(size)}" ${paintAttrs('fill', style.color)}>${escapeXml(text)}</text>`;

  let top = 0;
  if (item.title) {
    out.push(label(item.title, width / 2, style.size * 1.3, 'middle', style.size * 1.2));
    top = style.size * 2;
  }
  let bottom = height;
  if (item.showLegend && item.series.length > 0) {
    bottom = height - style.size * 2;
    let x = 0;
    for (const series of item.series) {
      out.push(
        `<rect x="${fmt(x)}" y="${fmt(bottom + style.size * 0.5)}" width="${fmt(style.size)}" height="${fmt(style.size)}" ${paintAttrs('fill', series.color)}/>`,
      );
      out.push(label(series.name, x + style.size * 1.4, bottom + style.size * 1.35, 'start'));
      x += style.size * 2 + measurer.measure(series.name, style);
    }
  }

  if (item.chartKind === 'pie') {
    const values = item.series[0]?.values.map((value) => Math.max(0, value)) ?? [];
    const total = values.reduce((sum, value) => sum + value, 0);
    const radius = Math.min(width, bottom - top) / 2;
    const cx = width / 2;
    const cy = top + (bottom - top) / 2;
    let angle = -Math.PI / 2;
    const accents = item.series.map((series) => series.color);
    values.forEach((value, index) => {
      if (total <= 0 || value <= 0) return;
      const sweep = (value / total) * Math.PI * 2;
      const end = angle + sweep;
      const color = accents[index % accents.length] ?? { hex: '#6b7280', alpha: 1 };
      if (sweep >= Math.PI * 2 - 1e-9) {
        out.push(
          `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(radius)}" ${paintAttrs('fill', color)}/>`,
        );
      } else {
        out.push(
          `<path d="M${fmt(cx)} ${fmt(cy)} L${fmt(cx + Math.cos(angle) * radius)} ${fmt(cy + Math.sin(angle) * radius)} A${fmt(radius)} ${fmt(radius)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${fmt(cx + Math.cos(end) * radius)} ${fmt(cy + Math.sin(end) * radius)} Z" ${paintAttrs('fill', color)}/>`,
        );
      }
      angle = end;
    });
    return out.join('');
  }

  const all = item.series.flatMap((series) => series.values);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;

  if (item.chartKind === 'bar') {
    // Horizontal bars: categories down the left, values along the bottom.
    const labelWidth =
      Math.max(0, ...item.categories.map((category) => measurer.measure(category, style))) +
      style.size;
    const plotLeft = Math.min(width * 0.4, labelWidth);
    const plotRight = width - measurer.measure(String(max), style) / 2 - style.size * 0.5;
    const plotBottomY = bottom - style.size * 1.8;
    const plotSpan = Math.max(1, plotRight - plotLeft);
    const xOf = (value: number) => plotLeft + ((value - min) / span) * plotSpan;
    const rows = Math.max(1, item.categories.length);
    const rowBand = Math.max(1, plotBottomY - top) / rows;
    const barHeight = (rowBand * 0.8) / Math.max(1, item.series.length);
    out.push(
      `<line x1="${fmt(xOf(0))}" y1="${fmt(top)}" x2="${fmt(xOf(0))}" y2="${fmt(plotBottomY)}" stroke="#9ca3af" stroke-width="75"/>`,
    );
    out.push(label(String(max), xOf(max), plotBottomY + style.size * 1.3, 'middle'));
    item.categories.forEach((category, index) => {
      out.push(
        label(
          category,
          plotLeft - style.size * 0.4,
          top + rowBand * (index + 0.5) + style.size * 0.35,
          'end',
        ),
      );
    });
    item.series.forEach((series, seriesIndex) => {
      series.values.forEach((value, index) => {
        const y = top + rowBand * index + rowBand * 0.1 + barHeight * seriesIndex;
        const x = Math.min(xOf(value), xOf(0));
        out.push(
          `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(Math.abs(xOf(value) - xOf(0)))}" height="${fmt(barHeight)}" ${paintAttrs('fill', series.color)}/>`,
        );
      });
    });
    return out.join('');
  }

  const left = measurer.measure(String(max), style) + style.size;
  const plotBottom = bottom - style.size * 1.8;
  const plotHeight = Math.max(1, plotBottom - top);
  const plotWidth = Math.max(1, width - left);
  const yOf = (value: number) => plotBottom - ((value - min) / span) * plotHeight;
  const categories = Math.max(1, item.categories.length);
  const band = plotWidth / categories;

  out.push(
    `<line x1="${fmt(left)}" y1="${fmt(yOf(0))}" x2="${fmt(width)}" y2="${fmt(yOf(0))}" stroke="#9ca3af" stroke-width="75"/>`,
  );
  out.push(label(String(max), left - style.size * 0.4, yOf(max) + style.size * 0.35, 'end'));
  item.categories.forEach((category, index) => {
    out.push(label(category, left + band * (index + 0.5), plotBottom + style.size * 1.3, 'middle'));
  });

  if (item.chartKind === 'column') {
    const barWidth = (band * 0.8) / Math.max(1, item.series.length);
    item.series.forEach((series, seriesIndex) => {
      series.values.forEach((value, index) => {
        const x = left + band * index + band * 0.1 + barWidth * seriesIndex;
        const y = Math.min(yOf(value), yOf(0));
        out.push(
          `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(barWidth)}" height="${fmt(Math.abs(yOf(value) - yOf(0)))}" ${paintAttrs('fill', series.color)}/>`,
        );
      });
    });
  } else {
    item.series.forEach((series) => {
      const points = series.values.map(
        (value, index) => `${fmt(left + band * (index + 0.5))},${fmt(yOf(value))}`,
      );
      if (item.chartKind === 'area' && points.length > 0) {
        const first = fmt(left + band * 0.5);
        const last = fmt(left + band * (series.values.length - 0.5));
        out.push(
          `<polygon points="${first},${fmt(yOf(0))} ${points.join(' ')} ${last},${fmt(yOf(0))}" ${paintAttrs('fill', { ...series.color, alpha: series.color.alpha * 0.6 })}/>`,
        );
      } else {
        out.push(
          `<polyline points="${points.join(' ')}" fill="none" ${paintAttrs('stroke', series.color)} stroke-width="200" stroke-linejoin="round"/>`,
        );
      }
    });
  }
  return out.join('');
}

function itemSvg(item: ResolvedItem, options: DeckSvgOptions): string {
  const opacity = item.opacity < 1 ? ` opacity="${fmt(item.opacity)}"` : '';
  const id = ` data-element="${escapeXml(item.id)}"`;
  if (item.kind === 'line') return `<g${id}${opacity}>${lineSvg(item)}</g>`;

  const { width, height } = item.frame;
  let body = '';
  switch (item.kind) {
    case 'shape':
      body = `<path d="${shapePath(item.geometry, width, height)}" ${fillAttrs(item.fill)} ${strokeAttrs(item.line)}/>`;
      if (item.text) body += textSvg(item.text, width, height, options.measurer);
      break;
    case 'image': {
      const href = safeHref(options.resolveAsset?.(item.asset));
      if (!href) {
        body = missingAsset(width, height, `Missing image: ${item.asset.path}`, options.measurer);
        break;
      }
      const { pixelWidth: pw, pixelHeight: ph } = item.asset;
      const crop = item.crop;
      const sx = (pw * crop.left) / 1_000;
      const sy = (ph * crop.top) / 1_000;
      const sw = Math.max(1, (pw * (1_000 - crop.left - crop.right)) / 1_000);
      const sh = Math.max(1, (ph * (1_000 - crop.top - crop.bottom)) / 1_000);
      body =
        `<svg width="${fmt(width)}" height="${fmt(height)}" viewBox="${fmt(sx)} ${fmt(sy)} ${fmt(sw)} ${fmt(sh)}" preserveAspectRatio="none" overflow="hidden">` +
        `<image width="${pw}" height="${ph}" preserveAspectRatio="none" href="${escapeXml(href)}"/></svg>`;
      if (item.line)
        body += `<rect width="${fmt(width)}" height="${fmt(height)}" fill="none" ${strokeAttrs(item.line)}/>`;
      break;
    }
    case 'table':
      body = tableSvg(item, options.measurer);
      break;
    case 'chart':
      body = chartSvg(item, options.measurer);
      break;
    case 'embed': {
      const href = item.preview ? safeHref(options.resolveAsset?.(item.preview)) : null;
      body = href
        ? `<image width="${fmt(width)}" height="${fmt(height)}" preserveAspectRatio="xMidYMid meet" href="${escapeXml(href)}"/>`
        : embedCard(
            width,
            height,
            item.name ?? item.source.path,
            item.source.path,
            options.measurer,
          );
      break;
    }
  }
  const alt = item.altText ? `<title>${escapeXml(item.altText)}</title>` : '';
  return `<g${id} transform="${frameTransform(item.frame)}"${opacity}>${alt}${body}</g>`;
}

function backgroundSvg(slide: ResolvedSlide, options: DeckSvgOptions): string {
  const size = `width="${fmt(slide.width)}" height="${fmt(slide.height)}"`;
  const fill = slide.background;
  if (fill.kind === 'solid') return `<rect ${size} ${paintAttrs('fill', fill.color)}/>`;
  if (fill.kind === 'image') {
    const href = safeHref(options.resolveAsset?.(fill.asset));
    if (!href) return `<rect ${size} fill="#ffffff"/>`;
    const aspect =
      fill.fit === 'stretch' ? 'none' : fill.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
    return `<image ${size} preserveAspectRatio="${aspect}" href="${escapeXml(href)}"/>`;
  }
  return '';
}

/** Renders one resolved slide as a standalone SVG document string. */
export function renderSlideSvg(slide: ResolvedSlide, options: DeckSvgOptions): string {
  const pixelWidth = options.pixelWidth ?? unitsToPx(slide.width);
  const pixelHeight = options.pixelHeight ?? (pixelWidth * slide.height) / slide.width;
  const items = slide.items.map((item) => itemSvg(item, options)).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(pixelWidth)}" height="${fmt(pixelHeight)}"` +
    ` viewBox="0 0 ${fmt(slide.width)} ${fmt(slide.height)}" overflow="hidden" data-deck-slide="${escapeXml(slide.slideId)}">` +
    `${backgroundSvg(slide, options)}${items}</svg>`
  );
}

/**
 * Scale and offset that fit a slide into a container, centred. The editor
 * stage, thumbnails, and presentation mode all place slides with this.
 */
export function fitSlide(
  slide: { width: number; height: number },
  container: { width: number; height: number },
): { scale: number; x: number; y: number; width: number; height: number } {
  const slideWidthPx = unitsToPx(slide.width);
  const slideHeightPx = unitsToPx(slide.height);
  const scale = Math.max(
    0,
    Math.min(container.width / slideWidthPx, container.height / slideHeightPx),
  );
  const width = slideWidthPx * scale;
  const height = slideHeightPx * scale;
  return {
    scale,
    width,
    height,
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
  };
}
