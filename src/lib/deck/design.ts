/**
 * Reversible edits to a deck's design: its theme, masters, and layouts, and
 * how slides sit on them (layout choice, placeholders, overrides).
 *
 * Same contract as `operations.ts`: pure functions returning the new deck and
 * its exact inverse, so the one undo stack covers design edits too.
 *
 * Placeholder inheritance is data, not behaviour. A slide placeholder that
 * leaves a property unset inherits it from its layout, then its master
 * (`resolve.ts`); an override is simply a property the slide element sets.
 * Resetting a placeholder therefore means deleting its overrides.
 */
import { DECK_LIMITS, DECK_UNITS_PER_POINT } from '../../types/deck';
import type {
  DeckDocument,
  DeckElement,
  DeckLayout,
  DeckMaster,
  DeckPlaceholderRef,
  DeckPlaceholderType,
  DeckSlide,
  DeckTheme,
} from '../../types/deck';

import { applyPatch } from './operations';
import type { DeckEdit } from './operations';
import { findPlaceholder, resolveSlide } from './resolve';
import { isRichTextEmpty, stripTextFormatting } from './richText';

const unchanged = (document: DeckDocument): DeckEdit => ({
  result: document,
  inverse: unchanged,
});

/* ------------------------------------------------------------------------- */
/* Theme, master, layout records                                              */
/* ------------------------------------------------------------------------- */

export function updateTheme(
  document: DeckDocument,
  themeId: string,
  update: (theme: DeckTheme) => DeckTheme,
): DeckEdit {
  const theme = document.themes[themeId];
  if (!theme) throw new Error(`Theme ${themeId} does not exist.`);
  const next = update(theme);
  if (next === theme) return unchanged(document);
  return applyPatch(document, { themes: { [themeId]: { ...next, id: themeId } } });
}

export function updateMaster(
  document: DeckDocument,
  masterId: string,
  update: (master: DeckMaster) => DeckMaster,
): DeckEdit {
  const master = document.masters[masterId];
  if (!master) throw new Error(`Master ${masterId} does not exist.`);
  const next = update(master);
  if (next === master) return unchanged(document);
  return applyPatch(document, { masters: { [masterId]: { ...next, id: masterId } } });
}

export function updateLayout(
  document: DeckDocument,
  layoutId: string,
  update: (layout: DeckLayout) => DeckLayout,
): DeckEdit {
  const layout = document.layouts[layoutId];
  if (!layout) throw new Error(`Layout ${layoutId} does not exist.`);
  const next = update(layout);
  if (next === layout) return unchanged(document);
  if (!document.masters[next.masterId]) throw new Error(`Master ${next.masterId} does not exist.`);
  return applyPatch(document, { layouts: { [layoutId]: { ...next, id: layoutId } } });
}

/** Copies a layout, placeholders and artwork included, under a new id. */
export function duplicateLayout(
  document: DeckDocument,
  layoutId: string,
  newId: string,
): DeckEdit & { layoutId: string } {
  const layout = document.layouts[layoutId];
  if (!layout) throw new Error(`Layout ${layoutId} does not exist.`);
  if (Object.keys(document.layouts).length >= DECK_LIMITS.layouts) {
    throw new Error(`A presentation can have at most ${DECK_LIMITS.layouts} layouts.`);
  }
  if (document.layouts[newId]) throw new Error(`Layout ${newId} already exists.`);
  const copy: DeckLayout = { ...structuredClone(layout), id: newId, name: `${layout.name} copy` };
  return { ...applyPatch(document, { layouts: { [newId]: copy } }), layoutId: newId };
}

/** The built-in layouts' order, as every template creates them. */
const BUILT_IN_LAYOUT_ORDER = [
  'layout-title',
  'layout-content',
  'layout-two-content',
  'layout-section',
  'layout-title-only',
  'layout-blank',
];

/**
 * A deck's layouts in a stable order for menus and the design rail: the
 * built-in layouts in their usual order, then any others by name. Stored
 * layouts are a map, so their key order says nothing.
 */
export function orderedLayouts(document: DeckDocument): DeckLayout[] {
  const rank = (id: string) => {
    const index = BUILT_IN_LAYOUT_ORDER.indexOf(id);
    return index < 0 ? BUILT_IN_LAYOUT_ORDER.length : index;
  };
  return Object.values(document.layouts).sort(
    (a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

/** Slides that use a layout. */
export function slidesUsingLayout(document: DeckDocument, layoutId: string): string[] {
  return document.slideOrder.filter((id) => document.slides[id]?.layoutId === layoutId);
}

/**
 * Deletes a layout nobody uses. A layout in use is refused, as PowerPoint
 * does, because silently moving its slides elsewhere would restyle them.
 */
export function deleteLayout(document: DeckDocument, layoutId: string): DeckEdit {
  if (!document.layouts[layoutId]) return unchanged(document);
  const users = slidesUsingLayout(document, layoutId);
  if (users.length > 0) {
    throw new Error(
      `This layout is used by ${users.length} ${users.length === 1 ? 'slide' : 'slides'}; give ${users.length === 1 ? 'it' : 'them'} another layout first.`,
    );
  }
  if (Object.keys(document.layouts).length <= 1) {
    throw new Error('A presentation needs at least one layout.');
  }
  return applyPatch(document, { layouts: { [layoutId]: null } });
}

/* ------------------------------------------------------------------------- */
/* Placeholders                                                               */
/* ------------------------------------------------------------------------- */

/** Placeholder types that carry slide content, and so are created on new slides. */
const CONTENT_PLACEHOLDERS: ReadonlySet<DeckPlaceholderType> = new Set([
  'title',
  'subtitle',
  'body',
  'content',
]);

/** The content placeholders a slide on this layout starts with, in paint order. */
export function placeholdersForLayout(layout: DeckLayout | undefined): DeckPlaceholderRef[] {
  if (!layout) return [];
  const refs: DeckPlaceholderRef[] = [];
  for (const id of layout.elementOrder) {
    const placeholder = layout.elements[id]?.placeholder;
    if (placeholder && CONTENT_PLACEHOLDERS.has(placeholder.type)) refs.push({ ...placeholder });
  }
  return refs;
}

function emptyPlaceholder(id: string, ref: DeckPlaceholderRef): DeckElement {
  return {
    id,
    type: 'text',
    placeholder: { ...ref },
    text: { content: { paragraphs: [] } },
  };
}

/** A new slide on a layout, with an empty element for each content placeholder. */
export function createSlideForLayout(id: string, layout: DeckLayout | undefined): DeckSlide {
  const elements = placeholdersForLayout(layout).map((ref) =>
    emptyPlaceholder(`${id}-${ref.key}`, ref),
  );
  const slide: DeckSlide = {
    id,
    elements: Object.fromEntries(elements.map((element) => [element.id, element])),
    elementOrder: elements.map((element) => element.id),
  };
  if (layout) slide.layoutId = layout.id;
  return slide;
}

/** A placeholder key not yet used in a layout or master. */
function freshKey(container: DeckLayout | DeckMaster, type: DeckPlaceholderType): string {
  const base = type === 'slideNumber' ? 'number' : type;
  const used = new Set(
    Object.values(container.elements).map((element) => element.placeholder?.key),
  );
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

const PLACEHOLDER_NAMES: Record<DeckPlaceholderType, string> = {
  title: 'Title',
  subtitle: 'Subtitle',
  body: 'Text',
  content: 'Content',
  picture: 'Picture',
  date: 'Date',
  footer: 'Footer',
  slideNumber: 'Slide number',
};

export function placeholderName(type: DeckPlaceholderType): string {
  return PLACEHOLDER_NAMES[type];
}

/**
 * Adds a placeholder to a layout or master. Text styles come from the master,
 * so the new placeholder only needs a frame; slides created on the layout
 * afterwards receive it.
 */
export function insertPlaceholder(
  document: DeckDocument,
  target: { kind: 'layout' | 'master'; id: string },
  type: DeckPlaceholderType,
  id: string,
): DeckEdit & { elementId: string } {
  const container =
    target.kind === 'layout' ? document.layouts[target.id] : document.masters[target.id];
  if (!container) throw new Error(`The ${target.kind} ${target.id} does not exist.`);
  if (container.elements[id]) throw new Error(`Element ${id} already exists.`);
  const { width, height } = document.size;
  const small = type === 'date' || type === 'footer' || type === 'slideNumber';
  const boxWidth = Math.round(small ? width * 0.25 : width * 0.6);
  const boxHeight = Math.round(small ? 24 * DECK_UNITS_PER_POINT : height * 0.2);
  const element: DeckElement = {
    id,
    type: 'text',
    name: PLACEHOLDER_NAMES[type],
    placeholder: { type, key: freshKey(container, type) },
    frame: {
      x: Math.round((width - boxWidth) / 2),
      y: Math.round((height - boxHeight) / 2),
      width: boxWidth,
      height: boxHeight,
    },
    text: { content: { paragraphs: [] } },
  };
  const next = {
    ...container,
    elements: { ...container.elements, [id]: element },
    elementOrder: [...container.elementOrder, id],
  };
  const edit =
    target.kind === 'layout'
      ? applyPatch(document, { layouts: { [target.id]: next as DeckLayout } })
      : applyPatch(document, { masters: { [target.id]: next as DeckMaster } });
  return { ...edit, elementId: id };
}

/** The layout and master placeholders a slide element inherits from. */
function inheritanceChain(document: DeckDocument, slide: DeckSlide, element: DeckElement) {
  const layout = slide.layoutId ? document.layouts[slide.layoutId] : undefined;
  const master = layout
    ? document.masters[layout.masterId]
    : document.masters[Object.keys(document.masters).sort()[0]];
  return [
    findPlaceholder(layout, element.placeholder),
    findPlaceholder(master, element.placeholder),
  ].filter((entry): entry is DeckElement => entry !== undefined);
}

/** Whether a slide placeholder overrides anything its layout would give it. */
export function hasPlaceholderOverrides(element: DeckElement): boolean {
  if (!element.placeholder) return false;
  if (element.frame) return true;
  if ((element.type === 'text' || element.type === 'shape') && (element.fill || element.line)) {
    return true;
  }
  if (element.type !== 'text' && element.type !== 'shape') return false;
  const body = element.text;
  if (!body) return false;
  if (
    body.insets !== undefined ||
    body.verticalAlign !== undefined ||
    body.autoFit !== undefined ||
    body.wrap !== undefined
  ) {
    return true;
  }
  return body.content.paragraphs.some(
    (paragraph) =>
      paragraph.endStyle !== undefined ||
      Object.keys(paragraph.style ?? {}).some((key) => key !== 'level') ||
      paragraph.runs.some((run) => run.style !== undefined),
  );
}

/**
 * Resets slide placeholders to their layout: position, size, fill, outline,
 * text box settings, and text formatting go; text, links, and list levels
 * stay. With no ids, every placeholder on the slide is reset.
 */
export function resetPlaceholders(
  document: DeckDocument,
  slideId: string,
  elementIds?: string[],
): DeckEdit {
  const slide = document.slides[slideId];
  if (!slide) throw new Error(`Slide ${slideId} does not exist.`);
  const ids = elementIds ?? Object.keys(slide.elements);
  const elements = { ...slide.elements };
  let changed = false;
  for (const id of ids) {
    const element = elements[id];
    if (!element?.placeholder || !hasPlaceholderOverrides(element)) continue;
    const chain = inheritanceChain(document, slide, element);
    const next = { ...element } as DeckElement;
    // Keep the frame only when nothing upstream could supply one.
    if (chain.some((entry) => entry.frame)) delete next.frame;
    if (next.type === 'text' || next.type === 'shape') {
      delete next.fill;
      delete next.line;
      if (next.text) {
        next.text = { content: stripTextFormatting(next.text.content) };
      }
    }
    elements[id] = next;
    changed = true;
  }
  if (!changed) return unchanged(document);
  return applyPatch(document, { slides: { [slideId]: { ...slide, elements } } });
}

function hasContent(element: DeckElement): boolean {
  if (element.type === 'text' || element.type === 'shape') {
    return !isRichTextEmpty(element.text?.content);
  }
  return true;
}

/**
 * Moves slides onto another layout, as PowerPoint's "Layout" command does:
 *
 * - a placeholder the new layout (or its master) also has follows it, and
 *   takes the new layout's key so later inheritance is unambiguous;
 * - an empty placeholder the new layout lacks is removed;
 * - one with content keeps its current position as an explicit frame, so
 *   nothing a person wrote disappears;
 * - content placeholders the new layout adds arrive empty.
 */
export function setSlideLayout(
  document: DeckDocument,
  slideIds: string[],
  layoutId: string,
  nextId: (prefix: string) => string,
): DeckEdit {
  const layout = document.layouts[layoutId];
  if (!layout) throw new Error(`Layout ${layoutId} does not exist.`);
  const master = document.masters[layout.masterId];
  const slides: Record<string, DeckSlide> = {};

  for (const slideId of slideIds) {
    const slide = document.slides[slideId];
    if (!slide || slide.layoutId === layoutId) continue;
    const before = resolveSlide(document, slideId);
    const frames = new Map(before.items.map((item) => [item.id, item.frame]));
    const elements: Record<string, DeckElement> = {};
    const order: string[] = [];
    const claimed = new Set<string>();

    for (const id of slide.elementOrder) {
      const element = slide.elements[id];
      if (!element) continue;
      if (!element.placeholder) {
        elements[id] = element;
        order.push(id);
        continue;
      }
      const inLayout = findPlaceholder(
        {
          elements: Object.fromEntries(
            Object.entries(layout.elements).filter(
              ([, entry]) => entry.placeholder && !claimed.has(entry.placeholder.key),
            ),
          ),
          elementOrder: [],
        },
        element.placeholder,
      );
      if (inLayout?.placeholder) {
        claimed.add(inLayout.placeholder.key);
        elements[id] = { ...element, placeholder: { ...inLayout.placeholder } } as DeckElement;
        order.push(id);
        continue;
      }
      if (findPlaceholder(master, element.placeholder)) {
        elements[id] = element;
        order.push(id);
        continue;
      }
      if (!hasContent(element)) continue;
      const frame = element.frame ?? frames.get(id);
      elements[id] = (frame ? { ...element, frame: { ...frame } } : element) as DeckElement;
      order.push(id);
    }
    // Keep group children that were never in the paint order.
    for (const [id, element] of Object.entries(slide.elements)) {
      if (!elements[id] && !slide.elementOrder.includes(id)) elements[id] = element;
    }
    for (const ref of placeholdersForLayout(layout)) {
      if (claimed.has(ref.key)) continue;
      if (Object.values(elements).some((element) => element.placeholder?.key === ref.key)) continue;
      let id = `${slideId}-${ref.key}`;
      if (elements[id]) id = nextId('el');
      elements[id] = emptyPlaceholder(id, ref);
      order.push(id);
    }
    const next: DeckSlide = { ...slide, layoutId, elements, elementOrder: order };
    if (slide.animations) {
      const animations = slide.animations.filter((animation) => elements[animation.elementId]);
      if (animations.length > 0) next.animations = animations;
      else delete next.animations;
    }
    slides[slideId] = next;
  }
  if (Object.keys(slides).length === 0) return unchanged(document);
  return applyPatch(document, { slides });
}
