/**
 * New objects for the Phase 2 editor: a text box and a few basic shapes,
 * centred on the slide and styled from the theme.
 *
 * Deliberately minimal — they exist so the scene editor has objects to work
 * on. The full shape gallery, fills, lines, and images are Phase 4; text
 * editing is Phase 3.
 */
import { DECK_UNITS_PER_POINT } from '../../types/deck';
import type { DeckDocument, DeckElement, DeckShapeGeometry } from '../../types/deck';

const pt = (points: number) => Math.round(points * DECK_UNITS_PER_POINT);

export type DeckInsertKind = 'text' | 'rect' | 'ellipse' | 'roundRect' | 'line';

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
    case 'line': {
      const frame = centred(deck, pt(240), 0, offset);
      return {
        id,
        type: 'line',
        name: 'Line',
        from: { x: frame.x, y: frame.y },
        to: { x: frame.x + frame.width, y: frame.y },
        line: { color: { kind: 'theme', token: 'dark1' }, width: pt(2) },
      };
    }
    default: {
      const geometry: DeckShapeGeometry = kind;
      return {
        id,
        type: 'shape',
        name:
          geometry === 'ellipse'
            ? 'Ellipse'
            : geometry === 'roundRect'
              ? 'Rounded rectangle'
              : 'Rectangle',
        geometry,
        frame: centred(deck, pt(200), pt(140), offset),
        fill: { kind: 'solid', color: { kind: 'theme', token: 'accent1' } },
      };
    }
  }
}
