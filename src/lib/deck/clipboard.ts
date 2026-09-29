/**
 * Copy and paste for slide elements.
 *
 * The system clipboard only carries text reliably across WebViews, so copied
 * elements travel as a marked JSON payload in `text/plain`. Anything else on
 * the clipboard pastes as a plain text box.
 *
 * Copied elements are made self-contained: a placeholder's inherited geometry
 * is written into its frame and the placeholder link is dropped, so a paste
 * lands where it was on any slide, in any deck, whatever that slide's layout.
 * (Inherited text styling is Phase 3's to carry across.)
 */
import { DECK_LIMITS } from '../../types/deck';
import type { DeckElement, DeckParagraph } from '../../types/deck';

import { cloneElements, expandGroups } from './operations';
import type { SlideGeometry } from './transform';

const MARKER = 'collab-deck-elements/v1\n';

export interface DeckClipboardPayload {
  elements: DeckElement[];
  /** Top-level ids, in paint order. */
  topLevel: string[];
}

export function copyElements(geometry: SlideGeometry, ids: string[]): string {
  const topLevel = geometry.order.filter((id) => ids.includes(id));
  const members = expandGroups(geometry.slide, topLevel);
  const elements = [...members].map((id) => {
    const element = structuredClone(geometry.slide.elements[id]);
    const frame = geometry.frames.get(id);
    if (element.placeholder) {
      delete element.placeholder;
      if (!element.frame && frame) {
        element.frame = {
          x: Math.round(frame.x),
          y: Math.round(frame.y),
          width: Math.round(frame.width),
          height: Math.round(frame.height),
          ...(frame.rotation ? { rotation: frame.rotation } : {}),
        };
      }
    }
    return element;
  });
  return MARKER + JSON.stringify({ elements, topLevel } satisfies DeckClipboardPayload);
}

export function parseClipboard(text: string): DeckClipboardPayload | null {
  if (!text.startsWith(MARKER) || text.length > DECK_LIMITS.clipboardBytes) return null;
  try {
    const value = JSON.parse(text.slice(MARKER.length)) as DeckClipboardPayload;
    if (!Array.isArray(value.elements) || !Array.isArray(value.topLevel)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Prepares clipboard content for pasting: fresh ids, and every element nudged
 * by `offset` so repeated pastes cascade instead of stacking invisibly.
 */
export function preparePaste(
  payload: DeckClipboardPayload,
  nextId: (prefix: string) => string,
  offset: number,
): { elements: DeckElement[]; topLevel: string[] } {
  const { elements, ids } = cloneElements(payload.elements, nextId);
  const shifted = elements.map((element): DeckElement => {
    if (element.type === 'line') {
      return {
        ...element,
        from: { x: element.from.x + offset, y: element.from.y + offset },
        to: { x: element.to.x + offset, y: element.to.y + offset },
      };
    }
    return element.frame
      ? {
          ...element,
          frame: { ...element.frame, x: element.frame.x + offset, y: element.frame.y + offset },
        }
      : element;
  });
  return { elements: shifted, topLevel: payload.topLevel.map((id) => ids.get(id) ?? id) };
}

/** Plain text as paragraphs for a new text box, bounded by the text limits. */
export function textToParagraphs(text: string, idPrefix: string): DeckParagraph[] {
  const lines = text
    .slice(0, DECK_LIMITS.textPerBody)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .slice(0, DECK_LIMITS.paragraphsPerBody);
  return lines.map((line, index) => ({
    id: `${idPrefix}-p${index}`,
    runs: line ? [{ kind: 'text', text: line }] : [],
  }));
}
