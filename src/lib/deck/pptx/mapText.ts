/**
 * Resolved rich text → PptxGenJS text runs.
 *
 * Paragraph-level options (alignment, list, spacing, level) ride on the first
 * run of each paragraph and the last run carries `breakLine`, which is how
 * PptxGenJS delimits `<a:p>` elements.
 */
import type PptxGenJS from 'pptxgenjs';

import type { ResolvedParagraph, ResolvedRunStyle, ResolvedTextBody } from '../resolve';
import { unitsToPoints } from '../units';

import type { DeckExportReportBuilder } from './exportReport';

type TextProps = PptxGenJS.TextProps;
type TextOptions = NonNullable<PptxGenJS.TextProps['options']>;

export interface TextMapContext {
  report: DeckExportReportBuilder;
  slideId: string;
  elementId: string;
  /** 1-based slide numbers by slide id, for internal links. */
  slideNumbers: Map<string, number>;
  /** Element opacity, applied as text transparency. */
  opacity: number;
}

export function hex(color: { hex: string }): string {
  return color.hex.slice(1).toUpperCase();
}

/** PptxGenJS transparency is a percentage where 100 is invisible. */
export function transparency(alpha: number, opacity = 1): number | undefined {
  const value = Math.round((1 - alpha * opacity) * 100);
  return value > 0 ? value : undefined;
}

function runOptions(style: ResolvedRunStyle, context: TextMapContext): TextOptions {
  context.report.font(style.font.family);
  const options: TextOptions = {
    fontFace: style.font.family,
    fontSize: unitsToPoints(style.size),
    color: hex(style.color),
  };
  const alpha = transparency(style.color.alpha, context.opacity);
  if (alpha !== undefined) options.transparency = alpha;
  if (style.bold) options.bold = true;
  if (style.italic) options.italic = true;
  if (style.underline) options.underline = { style: 'sng' };
  if (style.strike) options.strike = 'sngStrike';
  if (style.baseline === 'superscript') options.superscript = true;
  if (style.baseline === 'subscript') options.subscript = true;
  if (style.lang) options.lang = style.lang;
  return options;
}

const NUMBER_TYPES = {
  arabicPeriod: 'arabicPeriod',
  alphaLcPeriod: 'alphaLcPeriod',
  alphaUcPeriod: 'alphaUcPeriod',
  romanLcPeriod: 'romanLcPeriod',
} as const;

function paragraphOptions(paragraph: ResolvedParagraph, source: ResolvedTextBody): TextOptions {
  const options: TextOptions = { align: paragraph.align };
  if (paragraph.spaceBefore) options.paraSpaceBefore = unitsToPoints(paragraph.spaceBefore);
  if (paragraph.spaceAfter) options.paraSpaceAfter = unitsToPoints(paragraph.spaceAfter);
  if (paragraph.lineSpacing !== 100) options.lineSpacingMultiple = paragraph.lineSpacing / 100;
  if (paragraph.level > 0) options.indentLevel = paragraph.level;
  if (paragraph.label) {
    const isNumber = /\.$/.test(paragraph.label) && paragraph.label.length > 1;
    options.bullet = isNumber
      ? { type: 'number', numberType: NUMBER_TYPES[numberStyleOf(paragraph.label)] }
      : {
          characterCode: paragraph.label
            .codePointAt(0)!
            .toString(16)
            .toUpperCase()
            .padStart(4, '0'),
          indent: unitsToPoints(Math.max(paragraph.indent, paragraph.runs[0]?.style.size ?? 0)),
        };
  } else if (source.paragraphs.some((entry) => entry.label)) {
    options.bullet = false;
  }
  return options;
}

function numberStyleOf(label: string): keyof typeof NUMBER_TYPES {
  const body = label.slice(0, -1);
  if (/^\d+$/.test(body)) return 'arabicPeriod';
  if (/^[ivxlcdm]+$/.test(body)) return 'romanLcPeriod';
  if (/^[A-Z]+$/.test(body)) return 'alphaUcPeriod';
  return 'alphaLcPeriod';
}

/** Maps a resolved body to PptxGenJS runs. Empty paragraphs keep their line. */
export function mapTextBody(body: ResolvedTextBody, context: TextMapContext): TextProps[] {
  const runs: TextProps[] = [];
  body.paragraphs.forEach((paragraph) => {
    const paragraphOpts = paragraphOptions(paragraph, body);
    const start = runs.length;
    let softBreak = false;
    for (const run of paragraph.runs) {
      if (run.kind === 'break') {
        softBreak = true;
        continue;
      }
      if (run.text === '') continue;
      const options = runOptions(run.style, context);
      if (softBreak) {
        options.softBreakBefore = true;
        softBreak = false;
      }
      if (run.link) {
        if (run.link.kind === 'url') {
          options.hyperlink = { url: run.link.href };
        } else if (run.link.kind === 'slide') {
          const number = context.slideNumbers.get(run.link.slideId);
          if (number) options.hyperlink = { slide: number };
        } else {
          context.report.add({
            severity: 'omitted',
            code: 'vault-link',
            message: `A link to the vault file ${run.link.path} has no meaning outside Collab and was exported as plain text.`,
            slideId: context.slideId,
            elementId: context.elementId,
          });
        }
      }
      runs.push({ text: run.text, options });
    }
    if (runs.length === start) {
      // An empty paragraph still occupies a line at its end-mark size.
      runs.push({ text: '', options: runOptions(paragraph.endStyle, context) });
    }
    runs[start].options = { ...paragraphOpts, ...runs[start].options };
    // PptxGenJS starts a new paragraph whenever `align` differs from the
    // previous run's, so every run of a paragraph must repeat it.
    for (let index = start + 1; index < runs.length; index += 1) {
      runs[index].options = { ...runs[index].options, align: paragraph.align };
    }
    runs[runs.length - 1].options = { ...runs[runs.length - 1].options, breakLine: true };
  });
  if (runs.length > 0) {
    // The final paragraph needs no trailing break; PptxGenJS would add an empty one.
    const last = runs[runs.length - 1].options!;
    delete last.breakLine;
  }
  return runs;
}

export function plainNotes(body: ResolvedTextBody): string {
  return body.paragraphs
    .map((paragraph) =>
      paragraph.runs.map((run) => (run.kind === 'break' ? '\n' : run.text)).join(''),
    )
    .join('\n');
}
