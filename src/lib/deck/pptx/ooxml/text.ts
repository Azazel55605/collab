/**
 * Resolved rich text → DrawingML text bodies.
 *
 * Every run is written with its full resolved formatting (size, font, colour,
 * weight...), so what PowerPoint shows never depends on how it would have
 * inherited a style. Units line up without conversion where OOXML allows:
 * font sizes and paragraph spacing are hundredths of a point, as deck units
 * are.
 */
import type { DeckLink } from '../../../../types/deck';
import type { ResolvedParagraph, ResolvedRunStyle, ResolvedTextBody } from '../../resolve';
import type { DeckExportReportBuilder } from '../exportReport';

import { attr, emu, guid, int, text } from './xml';

export interface TextWriteContext {
  report: DeckExportReportBuilder;
  slideId: string;
  elementId: string;
  /** Element opacity, multiplied into every colour. */
  opacity: number;
  /** A relationship id for a link, or null when it has no meaning in PowerPoint. */
  link: (link: DeckLink) => { id: string; action?: string } | null;
  /** Runs showing the slide number are written as a slide-number field. */
  slideNumberField: boolean;
}

const ALIGN = { left: 'l', center: 'ctr', right: 'r', justify: 'just' } as const;
const ANCHOR = { top: 't', middle: 'ctr', bottom: 'b' } as const;

export function srgb(color: { hex: string; alpha: number }, opacity = 1): string {
  const value = color.hex.replace('#', '').toUpperCase();
  const alpha = Math.max(0, Math.min(1, color.alpha * opacity));
  return alpha < 1
    ? `<a:srgbClr val="${value}"><a:alpha val="${int(alpha * 100_000)}"/></a:srgbClr>`
    : `<a:srgbClr val="${value}"/>`;
}

export function solidFill(color: { hex: string; alpha: number }, opacity = 1): string {
  return `<a:solidFill>${srgb(color, opacity)}</a:solidFill>`;
}

/** Run properties, as `<a:rPr>` (or `<a:endParaRPr>` with `tag`). */
export function runProperties(
  style: ResolvedRunStyle,
  context: Pick<TextWriteContext, 'opacity' | 'report'>,
  extra = '',
  tag = 'a:rPr',
): string {
  context.report.font(style.font.family);
  const attrs = [
    style.lang ? ` lang="${attr(style.lang)}"` : '',
    ` sz="${int(Math.max(100, Math.min(400_000, style.size)))}"`,
    style.bold ? ' b="1"' : ' b="0"',
    style.italic ? ' i="1"' : ' i="0"',
    style.underline ? ' u="sng"' : '',
    style.strike ? ' strike="sngStrike"' : '',
    style.baseline === 'superscript' ? ' baseline="30000"' : '',
    style.baseline === 'subscript' ? ' baseline="-25000"' : '',
    ' dirty="0"',
  ].join('');
  const family = attr(style.font.family);
  return (
    `<${tag}${attrs}>${solidFill(style.color, context.opacity)}` +
    `<a:latin typeface="${family}"/><a:ea typeface="${family}"/><a:cs typeface="${family}"/>` +
    `${extra}</${tag}>`
  );
}

function numberValue(label: string): number | null {
  const body = label.replace(/\.$/, '');
  if (/^\d+$/.test(body)) return Number(body);
  if (/^[a-z]+$/i.test(body) && !/^[ivxlcdm]+$/.test(body)) {
    let value = 0;
    for (const char of body.toLowerCase()) value = value * 26 + (char.charCodeAt(0) - 96);
    return value;
  }
  const romans: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  if (/^[ivxlcdm]+$/.test(body)) {
    let value = 0;
    for (let index = 0; index < body.length; index += 1) {
      const current = romans[body[index]];
      const next = romans[body[index + 1]] ?? 0;
      value += current < next ? -current : current;
    }
    return value;
  }
  return null;
}

function numberType(label: string): string {
  const body = label.replace(/\.$/, '');
  if (/^\d+$/.test(body)) return 'arabicPeriod';
  if (/^[ivxlcdm]+$/.test(body)) return 'romanLcPeriod';
  if (/^[A-Z]+$/.test(body)) return 'alphaUcPeriod';
  return 'alphaLcPeriod';
}

function isNumberLabel(label: string): boolean {
  return /\.$/.test(label) && label.length > 1;
}

function paragraphProperties(
  paragraph: ResolvedParagraph,
  previous: ResolvedParagraph | undefined,
): string {
  const label = paragraph.label;
  const size = paragraph.runs[0]?.style.size ?? paragraph.endStyle.size;
  const hanging = label
    ? Math.min(paragraph.indent, Math.round(size * (0.6 * label.length + 0.3)))
    : 0;
  const attrs = [
    ` marL="${emu(paragraph.indent)}"`,
    ` indent="${label ? -emu(hanging) : 0}"`,
    paragraph.level > 0 ? ` lvl="${Math.min(8, paragraph.level)}"` : '',
    ` algn="${ALIGN[paragraph.align]}"`,
  ].join('');
  const children: string[] = [];
  if (paragraph.lineSpacing !== 100) {
    children.push(`<a:lnSpc><a:spcPct val="${int(paragraph.lineSpacing * 1_000)}"/></a:lnSpc>`);
  }
  children.push(`<a:spcBef><a:spcPts val="${int(paragraph.spaceBefore)}"/></a:spcBef>`);
  children.push(`<a:spcAft><a:spcPts val="${int(paragraph.spaceAfter)}"/></a:spcAft>`);
  if (!label) {
    children.push('<a:buNone/>');
  } else if (isNumberLabel(label)) {
    const value = numberValue(label) ?? 1;
    const continues =
      previous?.label && isNumberLabel(previous.label) && previous.level === paragraph.level;
    children.push(
      `<a:buAutoNum type="${numberType(label)}"${!continues && value !== 1 ? ` startAt="${value}"` : ''}/>`,
    );
  } else {
    children.push(`<a:buFont typeface="Arial"/><a:buChar char="${attr(label)}"/>`);
  }
  return `<a:pPr${attrs}>${children.join('')}</a:pPr>`;
}

/** The `<a:p>` elements of a body. */
export function paragraphsXml(body: ResolvedTextBody, context: TextWriteContext): string {
  const out: string[] = [];
  body.paragraphs.forEach((paragraph, paragraphIndex) => {
    const parts: string[] = [paragraphProperties(paragraph, body.paragraphs[paragraphIndex - 1])];
    paragraph.runs.forEach((run, runIndex) => {
      if (run.kind === 'break') {
        parts.push(`<a:br>${runProperties(run.style, context)}</a:br>`);
        return;
      }
      if (run.text === '') return;
      let hyperlink = '';
      if (run.link) {
        const target = context.link(run.link);
        if (target) {
          hyperlink = `<a:hlinkClick r:id="${target.id}"${target.action ? ` action="${target.action}"` : ''}/>`;
        } else {
          context.report.add({
            severity: 'omitted',
            code: 'vault-link',
            message:
              'A link to a vault file has no meaning outside Collab and was exported as plain text.',
            slideId: context.slideId,
            elementId: context.elementId,
          });
        }
      }
      const properties = runProperties(run.style, context, hyperlink);
      if (context.slideNumberField && /^(\d+|‹#›)$/.test(run.text)) {
        parts.push(
          `<a:fld id="${guid(`${context.slideId}:${context.elementId}:${paragraphIndex}:${runIndex}`)}" type="slidenum">${properties}<a:t>${text(run.text)}</a:t></a:fld>`,
        );
      } else {
        parts.push(`<a:r>${properties}<a:t>${text(run.text)}</a:t></a:r>`);
      }
    });
    parts.push(runProperties(paragraph.endStyle, context, '', 'a:endParaRPr'));
    out.push(`<a:p>${parts.join('')}</a:p>`);
  });
  if (out.length === 0) out.push('<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>');
  return out.join('');
}

/**
 * `<a:bodyPr>`: insets, anchor, wrap, and auto-fit. `scale` is the shrink
 * factor Collab's layout applied, written so viewers that do not recompute
 * auto-fit (most of them, until the text is edited) draw the same size.
 */
export function bodyProperties(body: ResolvedTextBody, scale = 1): string {
  const [left, top, right, bottom] = body.insets;
  const autofit =
    body.autoFit === 'shrink'
      ? scale < 1
        ? `<a:normAutofit fontScale="${int(scale * 100_000)}"/>`
        : '<a:normAutofit/>'
      : body.autoFit === 'grow'
        ? '<a:spAutoFit/>'
        : '<a:noAutofit/>';
  return (
    `<a:bodyPr rot="0" spcFirstLastPara="0" vertOverflow="overflow" horzOverflow="overflow" vert="horz"` +
    ` wrap="${body.wrap ? 'square' : 'none'}" lIns="${emu(left)}" tIns="${emu(top)}" rIns="${emu(right)}" bIns="${emu(bottom)}"` +
    ` numCol="1" anchor="${ANCHOR[body.verticalAlign]}" anchorCtr="0" rtlCol="0">${autofit}</a:bodyPr>`
  );
}

/** A whole text body under `tag` (`p:txBody` for shapes, `a:txBody` in tables). */
export function textBodyXml(
  body: ResolvedTextBody,
  context: TextWriteContext,
  tag: 'p:txBody' | 'a:txBody',
  scale = 1,
): string {
  return `<${tag}>${bodyProperties(body, scale)}<a:lstStyle/>${paragraphsXml(body, context)}</${tag}>`;
}
