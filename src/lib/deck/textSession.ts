/**
 * One in-place text editing session: the draft body, its selection, and a
 * local undo stack.
 *
 * Typing does not write the deck on every keystroke. The session holds a
 * draft; the view writes it to the document on a short idle timer and when
 * editing ends, and all of one session's writes form a single step on the
 * deck's own undo stack. Inside the session, Ctrl+Z walks this finer-grained
 * local history instead — a burst of typing, a deletion, a paragraph split, a
 * format change — as a word processor does.
 */
import type { DeckRichText } from '../../types/deck';

import type { DeckTarget } from './resolve';
import type { TextFormat } from './richText';

export interface EditorSelection {
  anchor: number;
  focus: number;
}

export type TextSessionEditKind = 'type' | 'delete' | 'structure' | 'paste' | 'format';

interface Snapshot {
  body: DeckRichText;
  selection: EditorSelection;
}

export interface TextSession {
  /** Unique per session, so its document writes coalesce into one undo step. */
  id: number;
  kind: 'element' | 'notes';
  /** The container edited: a slide, layout, or master (always a slide for notes). */
  target: DeckTarget;
  elementId: string | null;
  body: DeckRichText;
  selection: EditorSelection;
  /** Formatting for the next typed text, from a toolbar toggle on a caret. */
  pending: TextFormat | null;
  initialPoint: { clientX: number; clientY: number } | null;
  past: Snapshot[];
  future: Snapshot[];
  lastKind: TextSessionEditKind | null;
  lastAt: number;
  /** Bumped to pull focus back into the editor after a toolbar control. */
  focusRequest: number;
}

/** Local steps kept per session. */
const LIMIT = 100;
/** Typing pauses longer than this start a new undo step. */
const TYPING_GAP_MS = 1_200;

let nextSessionId = 1;

export function startTextSession(options: {
  kind: TextSession['kind'];
  target: DeckTarget;
  elementId: string | null;
  body: DeckRichText;
  selection: EditorSelection;
  initialPoint?: { clientX: number; clientY: number } | null;
}): TextSession {
  return {
    id: nextSessionId++,
    kind: options.kind,
    target: options.target,
    elementId: options.elementId,
    body: options.body,
    selection: options.selection,
    pending: null,
    initialPoint: options.initialPoint ?? null,
    past: [],
    future: [],
    lastKind: null,
    lastAt: 0,
    focusRequest: 0,
  };
}

/**
 * Records an edit. Consecutive typing (or consecutive deleting) within a
 * short gap is one undo step; anything else starts a new one.
 */
export function editSession(
  session: TextSession,
  body: DeckRichText,
  selection: EditorSelection,
  kind: TextSessionEditKind,
  now: number,
): TextSession {
  if (body === session.body) {
    return { ...session, selection };
  }
  const continues =
    (kind === 'type' || kind === 'delete') &&
    session.lastKind === kind &&
    now - session.lastAt < TYPING_GAP_MS;
  const past = continues
    ? session.past
    : [...session.past, { body: session.body, selection: session.selection }].slice(-LIMIT);
  return {
    ...session,
    body,
    selection,
    past,
    future: [],
    lastKind: kind,
    lastAt: now,
    pending: kind === 'format' ? session.pending : null,
  };
}

export function undoSession(session: TextSession): TextSession | null {
  const previous = session.past[session.past.length - 1];
  if (!previous) return null;
  return {
    ...session,
    body: previous.body,
    selection: previous.selection,
    past: session.past.slice(0, -1),
    future: [...session.future, { body: session.body, selection: session.selection }],
    lastKind: null,
    pending: null,
  };
}

export function redoSession(session: TextSession): TextSession | null {
  const next = session.future[session.future.length - 1];
  if (!next) return null;
  return {
    ...session,
    body: next.body,
    selection: next.selection,
    future: session.future.slice(0, -1),
    past: [...session.past, { body: session.body, selection: session.selection }],
    lastKind: null,
    pending: null,
  };
}
