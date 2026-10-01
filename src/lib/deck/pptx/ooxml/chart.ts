/**
 * Charts as native PowerPoint charts: a DrawingML chart part with the values
 * cached in it (what viewers draw) and an embedded workbook holding the same
 * values (what "Edit Data" opens).
 *
 * Styling follows Collab's renderer: series colours, the chart's text style
 * for every label, a legend at the bottom, no gridlines, one axis line.
 */
import type { ResolvedChartItem } from '../../resolve';

import { solidFill } from './text';
import { attr, int, NS, text, XML_HEADER } from './xml';

/** Spreadsheet column letters: 0 → A, 26 → AA. */
export function columnName(index: number): string {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function textProperties(item: ResolvedChartItem, scale = 1): string {
  const style = item.textStyle;
  return (
    '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>' +
    `<a:defRPr sz="${int(style.size * scale)}" b="${style.bold ? 1 : 0}">${solidFill(style.color)}` +
    `<a:latin typeface="${attr(style.font.family)}"/></a:defRPr>` +
    '</a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>'
  );
}

function stringCache(formula: string, values: string[]): string {
  return (
    `<c:strRef><c:f>${text(formula)}</c:f><c:strCache><c:ptCount val="${values.length}"/>` +
    values.map((value, index) => `<c:pt idx="${index}"><c:v>${text(value)}</c:v></c:pt>`).join('') +
    '</c:strCache></c:strRef>'
  );
}

function numberCache(formula: string, values: number[]): string {
  return (
    `<c:numRef><c:f>${text(formula)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>` +
    values
      .map((value, index) =>
        Number.isFinite(value) ? `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>` : '',
      )
      .join('') +
    '</c:numCache></c:numRef>'
  );
}

const AXIS_LINE =
  '<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="9CA3AF"/></a:solidFill></a:ln></c:spPr>';
const NO_LINE = '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>';

function axes(item: ResolvedChartItem, horizontal: boolean): string {
  const catPos = horizontal ? 'l' : 'b';
  const valPos = horizontal ? 'b' : 'l';
  return (
    `<c:catAx><c:axId val="1001"/><c:scaling><c:orientation val="${horizontal ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${catPos}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/>` +
    `<c:tickLblPos val="nextTo"/>${AXIS_LINE}${textProperties(item)}<c:crossAx val="1002"/><c:crosses val="autoZero"/>` +
    '<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>' +
    `<c:valAx><c:axId val="1002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${valPos}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/>` +
    `<c:tickLblPos val="nextTo"/>${NO_LINE}${textProperties(item)}<c:crossAx val="1001"/><c:crosses val="autoZero"/>` +
    '<c:crossBetween val="between"/></c:valAx>'
  );
}

/** The chart part. `workbookRel` is the relationship id of the embedded workbook. */
export function chartXml(item: ResolvedChartItem, workbookRel: string): string {
  const count = item.categories.length;
  const categoryRef = `Sheet1!$A$2:$A$${count + 1}`;
  const series = (index: number) => {
    const entry = item.series[index];
    const column = columnName(index + 1);
    const color = solidFill(entry.color);
    const shape =
      item.chartKind === 'line'
        ? `<c:spPr><a:ln w="25400" cap="rnd">${color}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>`
        : item.chartKind === 'area'
          ? `<c:spPr>${solidFill({ ...entry.color, alpha: entry.color.alpha * 0.6 })}<a:ln><a:noFill/></a:ln></c:spPr>`
          : `<c:spPr>${color}<a:ln><a:noFill/></a:ln></c:spPr>`;
    const points =
      item.chartKind === 'pie'
        ? item.categories
            .map((_, point) => {
              const slice = item.series[point % item.series.length]?.color ?? entry.color;
              return `<c:dPt><c:idx val="${point}"/><c:bubble3D val="0"/><c:spPr>${solidFill(slice)}<a:ln><a:noFill/></a:ln></c:spPr></c:dPt>`;
            })
            .join('')
        : '';
    return (
      `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx>${stringCache(`Sheet1!$${column}$1`, [entry.name])}</c:tx>` +
      `${shape}${item.chartKind === 'column' || item.chartKind === 'bar' ? '<c:invertIfNegative val="0"/>' : ''}${points}` +
      `<c:cat>${stringCache(categoryRef, item.categories)}</c:cat>` +
      `<c:val>${numberCache(`Sheet1!$${column}$2:$${column}$${count + 1}`, entry.values.slice(0, count))}</c:val>` +
      `${item.chartKind === 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>`
    );
  };
  const allSeries = item.series.map((_, index) => series(index)).join('');
  let plot: string;
  switch (item.chartKind) {
    case 'pie':
      plot = `<c:pieChart><c:varyColors val="1"/>${item.series.length ? series(0) : ''}<c:firstSliceAng val="0"/></c:pieChart>`;
      break;
    case 'line':
      plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${allSeries}<c:marker val="1"/><c:axId val="1001"/><c:axId val="1002"/></c:lineChart>${axes(item, false)}`;
      break;
    case 'area':
      plot = `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${allSeries}<c:axId val="1001"/><c:axId val="1002"/></c:areaChart>${axes(item, false)}`;
      break;
    default: {
      const horizontal = item.chartKind === 'bar';
      plot =
        `<c:barChart><c:barDir val="${horizontal ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${allSeries}` +
        `<c:gapWidth val="25"/><c:axId val="1001"/><c:axId val="1002"/></c:barChart>${axes(item, horizontal)}`;
    }
  }
  const title = item.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${int(item.textStyle.size * 1.2)}" b="0">${solidFill(item.textStyle.color)}<a:latin typeface="${attr(item.textStyle.font.family)}"/></a:defRPr></a:pPr><a:r><a:rPr lang="en-US" sz="${int(item.textStyle.size * 1.2)}" b="0">${solidFill(item.textStyle.color)}<a:latin typeface="${attr(item.textStyle.font.family)}"/></a:rPr><a:t>${text(item.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : '<c:autoTitleDeleted val="1"/>';
  const legend = item.showLegend
    ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${textProperties(item)}</c:legend>`
    : '';
  return (
    `${XML_HEADER}<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}">` +
    '<c:date1904 val="0"/><c:roundedCorners val="0"/>' +
    `<c:chart>${title}<c:plotArea><c:layout/>${plot}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>' +
    `${textProperties(item)}<c:externalData r:id="${workbookRel}"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`
  );
}

/** The embedded workbook: categories in column A, one series per column. */
export function chartWorkbookParts(item: ResolvedChartItem): Record<string, string> {
  const cell = (ref: string, value: string | number) =>
    typeof value === 'number'
      ? `<c r="${ref}"><v>${Number.isFinite(value) ? value : 0}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${text(value)}</t></is></c>`;
  const rows: string[] = [];
  rows.push(
    `<row r="1">${cell('A1', '')}${item.series.map((series, index) => cell(`${columnName(index + 1)}1`, series.name)).join('')}</row>`,
  );
  item.categories.forEach((category, row) => {
    rows.push(
      `<row r="${row + 2}">${cell(`A${row + 2}`, category)}${item.series
        .map((series, index) => cell(`${columnName(index + 1)}${row + 2}`, series.values[row] ?? 0))
        .join('')}</row>`,
    );
  });
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return {
    '[Content_Types].xml':
      `${XML_HEADER}<Types xmlns="${NS.ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': `${XML_HEADER}<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML_HEADER}<workbook xmlns="${main}" xmlns:r="${NS.r}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML_HEADER}<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `${XML_HEADER}<styleSheet xmlns="${main}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `${XML_HEADER}<worksheet xmlns="${main}"><sheetData>${rows.join('')}</sheetData></worksheet>`,
  };
}
