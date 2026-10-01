/**
 * The deck theme as a DrawingML theme part.
 *
 * A deck theme has exactly the twelve colour slots and two font roles a
 * PowerPoint theme has, so it maps one to one: PowerPoint's theme colour
 * picker shows the deck's colours and its theme fonts are the deck's fonts.
 * The format scheme (line, fill, and effect styles) is the minimal valid one;
 * nothing in a deck refers to it.
 */
import type { DeckTheme } from '../../../../types/deck';

import { attr, NS, XML_HEADER } from './xml';

const SLOTS: Array<[string, keyof DeckTheme['colors']]> = [
  ['dk1', 'dark1'],
  ['lt1', 'light1'],
  ['dk2', 'dark2'],
  ['lt2', 'light2'],
  ['accent1', 'accent1'],
  ['accent2', 'accent2'],
  ['accent3', 'accent3'],
  ['accent4', 'accent4'],
  ['accent5', 'accent5'],
  ['accent6', 'accent6'],
  ['hlink', 'hyperlink'],
  ['folHlink', 'followedHyperlink'],
];

export function hexColor(value: string | undefined, fallback = '000000'): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(value ?? '');
  return match ? match[1].toUpperCase() : fallback;
}

const FILL = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const LINE = (width: number) =>
  `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;

export function themeXml(theme: DeckTheme | undefined, name: string): string {
  const colors = SLOTS.map(
    ([slot, token]) =>
      `<a:${slot}><a:srgbClr val="${hexColor(theme?.colors[token])}"/></a:${slot}>`,
  ).join('');
  const heading = attr(theme?.fonts.heading.family ?? 'Calibri');
  const body = attr(theme?.fonts.body.family ?? 'Calibri');
  return (
    `${XML_HEADER}<a:theme xmlns:a="${NS.a}" name="${attr(name)}">` +
    `<a:themeElements><a:clrScheme name="${attr(name)}">${colors}</a:clrScheme>` +
    `<a:fontScheme name="${attr(name)}">` +
    `<a:majorFont><a:latin typeface="${heading}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="${body}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
    '</a:fontScheme>' +
    '<a:fmtScheme name="Collab">' +
    `<a:fillStyleLst>${FILL}${FILL}${FILL}</a:fillStyleLst>` +
    `<a:lnStyleLst>${LINE(6350)}${LINE(12700)}${LINE(19050)}</a:lnStyleLst>` +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    `<a:bgFillStyleLst>${FILL}${FILL}${FILL}</a:bgFillStyleLst>` +
    '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>'
  );
}
