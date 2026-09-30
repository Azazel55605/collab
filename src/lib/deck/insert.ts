/**
 * New objects for the editor: text boxes, every preset shape, lines and
 * arrows, images, tables, charts, and linked documents — centred on the slide
 * and styled from the theme.
 *
 * Every object is ordinary schema content. Tables arrive with a header row
 * styled from the theme (accent fill, light bold text) as explicit cell
 * formatting, so the look is inspectable and editable rather than a hidden
 * table style.
 */
import { DECK_LIMITS, DECK_UNITS_PER_POINT } from '../../types/deck';
import type {
  DeckAssetRef,
  DeckChartKind,
  DeckDocument,
  DeckElement,
  DeckShapeGeometry,
  DeckTableCell,
  DeckTableElement,
} from '../../types/deck';

const pt = (points: number) => Math.round(points * DECK_UNITS_PER_POINT);

export type DeckInsertKind = 'text' | 'line' | 'arrow' | DeckShapeGeometry;

/** Display names for the shape gallery. */
export const SHAPE_NAMES: Record<DeckShapeGeometry, string> = {
  rect: 'Rectangle',
  roundRect: 'Rounded rectangle',
  ellipse: 'Ellipse',
  triangle: 'Triangle',
  rightTriangle: 'Right triangle',
  diamond: 'Diamond',
  pentagon: 'Pentagon',
  hexagon: 'Hexagon',
  rightArrow: 'Right arrow',
  leftArrow: 'Left arrow',
  upArrow: 'Up arrow',
  downArrow: 'Down arrow',
  chevron: 'Chevron',
  star5: 'Star',
};

function centred(deck: DeckDocument, width: number, height: number, offset: number) {
  return {
    x: Math.round((deck.size.width - width) / 2) + offset,
    y: Math.round((deck.size.height - height) / 2) + offset,
    width,
    height,
  };
}

/**
 * A new element of `kind`. `offset` staggers repeated inserts so they do not
 * land exactly on top of each other.
 */
export function createInsertedElement(
  deck: DeckDocument,
  id: string,
  kind: DeckInsertKind,
  offset = 0,
): DeckElement {
  switch (kind) {
    case 'text':
      return {
        id,
        type: 'text',
        name: 'Text box',
        frame: centred(deck, Math.round(deck.size.width * 0.4), pt(60), offset),
        text: {
          content: { paragraphs: [{ id: `${id}-p`, runs: [{ kind: 'text', text: 'Text' }] }] },
          autoFit: 'grow',
        },
      };
    case 'line':
    case 'arrow': {
      const frame = centred(deck, pt(240), 0, offset);
      return {
        id,
        type: 'line',
        name: kind === 'arrow' ? 'Arrow' : 'Line',
        from: { x: frame.x, y: frame.y },
        to: { x: frame.x + frame.width, y: frame.y },
        line: { color: { kind: 'theme', token: 'dark1' }, width: pt(2) },
        ...(kind === 'arrow' ? { endArrow: 'triangle' as const } : {}),
      };
    }
    default: {
      const geometry: DeckShapeGeometry = kind;
      const square = geometry === 'ellipse' || geometry === 'star5' || geometry === 'hexagon';
      return {
        id,
        type: 'shape',
        name: SHAPE_NAMES[geometry],
        geometry,
        frame: centred(deck, pt(square ? 160 : 200), pt(square ? 160 : 140), offset),
        fill: { kind: 'solid', color: { kind: 'theme', token: 'accent1' } },
      };
    }
  }
}

/**
 * An image at its natural aspect ratio, fitted inside 60% of the slide and
 * never enlarged past one image pixel per CSS pixel.
 */
export function createImageElement(
  deck: DeckDocument,
  id: string,
  asset: DeckAssetRef,
  offset = 0,
): DeckElement {
  const maxWidth = deck.size.width * 0.6;
  const maxHeight = deck.size.height * 0.6;
  // 75 deck units per CSS pixel at 100%: an image's own size in deck units.
  const natural = { width: asset.pixelWidth * 75, height: asset.pixelHeight * 75 };
  const scale = Math.min(1, maxWidth / natural.width, maxHeight / natural.height);
  const width = Math.max(pt(8), Math.round(natural.width * scale));
  const height = Math.max(pt(8), Math.round(natural.height * scale));
  const name = asset.path.split('/').pop() ?? 'Image';
  return {
    id,
    type: 'image',
    name,
    frame: centred(deck, width, height, offset),
    asset,
  };
}

const CELL_INSETS: [number, number, number, number] = [pt(6), pt(4), pt(6), pt(4)];

/** An empty cell, styled as a header or body cell of a new table. */
export function tableCell(id: string, header: boolean): DeckTableCell {
  return {
    text: {
      content: {
        paragraphs: [
          {
            id,
            runs: [],
            ...(header
              ? {
                  endStyle: {
                    bold: true,
                    color: { kind: 'theme' as const, token: 'light1' as const },
                  },
                }
              : {}),
          },
        ],
      },
      insets: CELL_INSETS,
      verticalAlign: 'middle',
    },
    ...(header
      ? {
          fill: {
            kind: 'solid' as const,
            color: { kind: 'theme' as const, token: 'accent1' as const },
          },
        }
      : {}),
  };
}

/** A new table of `rows` × `columns`, the first row styled as a header. */
export function createTableElement(
  deck: DeckDocument,
  id: string,
  rows: number,
  columns: number,
  nextId: (prefix: string) => string,
  offset = 0,
): DeckTableElement {
  const rowCount = Math.max(1, Math.min(DECK_LIMITS.tableRows, Math.floor(rows)));
  const columnCount = Math.max(1, Math.min(DECK_LIMITS.tableColumns, Math.floor(columns)));
  if (rowCount * columnCount > DECK_LIMITS.tableCells) {
    throw new Error(
      `A table can have at most ${DECK_LIMITS.tableCells.toLocaleString('en-US')} cells.`,
    );
  }
  const width = Math.round(deck.size.width * 0.8);
  const rowHeight = pt(36);
  const columnWidth = Math.floor(width / columnCount);
  const rowOrder = Array.from({ length: rowCount }, () => nextId('row'));
  const columnOrder = Array.from({ length: columnCount }, () => nextId('col'));
  const cells: Record<string, DeckTableCell> = {};
  rowOrder.forEach((rowId, rowIndex) => {
    for (const columnId of columnOrder) {
      cells[`${rowId}:${columnId}`] = tableCell(nextId('p'), rowIndex === 0);
    }
  });
  return {
    id,
    type: 'table',
    name: 'Table',
    frame: centred(deck, columnWidth * columnCount, rowHeight * rowCount, offset),
    rowOrder,
    columnOrder,
    rowHeights: Object.fromEntries(rowOrder.map((rowId) => [rowId, rowHeight])),
    columnWidths: Object.fromEntries(columnOrder.map((columnId) => [columnId, columnWidth])),
    cells,
    headerRow: true,
    border: { color: { kind: 'theme', token: 'dark2', alpha: 40 }, width: pt(1) },
  };
}

/** A chart of `kind` with a small sample data set to replace. */
export function createChartElement(
  deck: DeckDocument,
  id: string,
  kind: DeckChartKind,
  nextId: (prefix: string) => string,
  offset = 0,
): DeckElement {
  const pie = kind === 'pie';
  return {
    id,
    type: 'chart',
    name: 'Chart',
    kind,
    frame: centred(
      deck,
      Math.round(deck.size.width * 0.6),
      Math.round(deck.size.height * 0.55),
      offset,
    ),
    title: pie ? 'Share' : 'Results',
    categories: pie ? ['North', 'South', 'East', 'West'] : ['Q1', 'Q2', 'Q3', 'Q4'],
    series: pie
      ? [{ id: nextId('series'), name: 'Share', values: [40, 25, 20, 15] }]
      : [
          { id: nextId('series'), name: 'This year', values: [12, 18, 15, 22] },
          { id: nextId('series'), name: 'Last year', values: [10, 14, 16, 17] },
        ],
    showLegend: true,
  };
}

/** A linked document: a static preview of another vault document, never a live view. */
export function createEmbedElement(
  deck: DeckDocument,
  id: string,
  path: string,
  preview: DeckAssetRef | undefined,
  offset = 0,
): DeckElement {
  const width = Math.round(deck.size.width * 0.4);
  const height = preview
    ? Math.round((width * preview.pixelHeight) / Math.max(1, preview.pixelWidth))
    : Math.round(width * 0.6);
  return {
    id,
    type: 'embed',
    name: path.split('/').pop() ?? path,
    frame: centred(deck, width, Math.min(height, Math.round(deck.size.height * 0.8)), offset),
    source: { path },
    ...(preview ? { preview } : {}),
  };
}
