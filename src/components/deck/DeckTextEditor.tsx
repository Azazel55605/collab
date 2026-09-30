import { useEffect, useLayoutEffect, useRef } from 'react';

import type { ResolvedTextBody } from '../../lib/deck/resolve';
import {
  caretStop,
  deleteRange,
  flatText,
  insertRichText,
  insertSoftBreak,
  insertText,
  normalizeRange,
  paragraphStarts,
  richTextToPlain,
  sliceRichText,
  splitParagraph,
  textFragment,
  textLimitError,
} from '../../lib/deck/richText';
import type { TextFormat } from '../../lib/deck/richText';
import type { TextSessionEditKind } from '../../lib/deck/textSession';
import { DECK_LIMITS } from '../../types/deck';
import type { DeckRichText } from '../../types/deck';

import { readSelection, renderEditorContent, writeSelection } from './textDom';
import type { EditorSelection } from './textDom';

export type TextEditKind = Exclude<TextSessionEditKind, 'format'>;

/**
 * The last rich copy made inside a deck text editor. The system clipboard
 * carries plain text; when what is pasted is exactly that text, the rich
 * version is used instead, so formatting survives copy and paste in Collab.
 */
let richClipboard: { plain: string; fragment: DeckRichText } | null = null;

interface DeckTextEditorProps {
  /** The body being edited — the session's draft, not the stored document. */
  body: DeckRichText;
  /** The same body resolved (one resolved run per stored run), for styling. */
  resolved: ResolvedTextBody;
  selection: EditorSelection;
  /** Formatting the next typed text takes, set by a toolbar toggle on a caret. */
  pendingFormat: TextFormat | null;
  pxPerUnit: number;
  plain?: boolean;
  label: string;
  className?: string;
  style?: React.CSSProperties;
  /** Changing this re-focuses the editor, after a toolbar control took focus. */
  focusRequest?: number;
  /** Where the double-click that opened the editor landed, for the caret. */
  initialPoint?: { clientX: number; clientY: number } | null;
  nextId: () => string;
  onChange: (body: DeckRichText, selection: EditorSelection, kind: TextEditKind) => void;
  onSelectionChange: (selection: EditorSelection) => void;
  /** Formatting and other shortcuts; return true when handled. */
  onShortcut?: (event: React.KeyboardEvent<HTMLDivElement>) => boolean;
  onUndo: () => void;
  onRedo: () => void;
  onExit?: () => void;
  onLimit?: (message: string) => void;
}

function caretFromPoint(
  doc: Document,
  clientX: number,
  clientY: number,
): { node: Node; offset: number } | null {
  const withPosition = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = withPosition.caretPositionFromPoint?.(clientX, clientY);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = withPosition.caretRangeFromPoint?.(clientX, clientY);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/**
 * In-place rich-text editing: the first-party `contenteditable` adapter the
 * Phase 0 contract chose over Lexical.
 *
 * The browser supplies caret movement, selection, IME composition, spell
 * checking, and accessibility; every *change* is intercepted (`beforeinput`,
 * clipboard, composition end) and applied to the `.deck` model through
 * `richText.ts`, after which the DOM is redrawn from the model. The DOM is
 * never read back as content, so it can never become the document.
 *
 * While a box is edited the browser lays its text out; everything else uses
 * the engine. The contract measured the two as agreeing on 359 of 384 cases
 * in Chromium, differing only at knife-edge line widths.
 */
export function DeckTextEditor({
  body,
  resolved,
  selection,
  pendingFormat,
  pxPerUnit,
  plain,
  label,
  className,
  style,
  focusRequest,
  initialPoint,
  nextId,
  onChange,
  onSelectionChange,
  onShortcut,
  onUndo,
  onRedo,
  onExit,
  onLimit,
}: DeckTextEditorProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const composing = useRef<{ range: EditorSelection } | null>(null);
  // Latest props for the native listeners, which are attached once.
  const latest = useRef({ body, selection, pendingFormat, nextId, onChange, onLimit });
  latest.current = { body, selection, pendingFormat, nextId, onChange, onLimit };
  const reportSelection = useRef(onSelectionChange);
  reportSelection.current = onSelectionChange;
  /**
   * Selections read from the DOM, and model selections already placed. The
   * browser moves the caret faster than React re-renders; a selection that
   * came *from* the DOM is never written back to it, or a late re-render
   * would drag the caret back to where it was a keystroke ago.
   */
  const fromDom = useRef(new WeakSet<EditorSelection>());
  const written = useRef(new WeakSet<EditorSelection>());

  /** The live selection: the DOM's while focused, otherwise the model's. */
  const liveSelection = (): EditorSelection => {
    const root = rootRef.current;
    const read = root && root.ownerDocument.activeElement === root ? readSelection(root) : null;
    return read ?? latest.current.selection;
  };

  /** Tells the owner about a selection the browser made. */
  const report = (read: EditorSelection) => {
    const current = latest.current.selection;
    if (read.anchor === current.anchor && read.focus === current.focus) return;
    fromDom.current.add(read);
    latest.current.selection = read;
    reportSelection.current(read);
  };

  /** Places a model selection once; returns false for one the DOM already has. */
  const place = (root: HTMLElement, selection: EditorSelection): boolean => {
    if (fromDom.current.has(selection) || written.current.has(selection)) return false;
    written.current.add(selection);
    writeSelection(root, selection);
    return true;
  };

  // Redraw from the model. Composition owns the DOM until it ends.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || composing.current) return;
    const focused = root.ownerDocument.activeElement === root;
    const before = focused ? readSelection(root) : null;
    renderEditorContent(root, resolved, { pxPerUnit, plain });
    if (!focused) return;
    // Rebuilding the content drops the DOM selection: put back the model's
    // new one after an edit, otherwise wherever the caret was.
    if (!place(root, latest.current.selection)) {
      writeSelection(root, before ?? latest.current.selection);
    }
  }, [plain, pxPerUnit, resolved]);

  // A selection set by the model without an edit (undo, a link's extent).
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || composing.current || root.ownerDocument.activeElement !== root) return;
    place(root, selection);
  }, [selection]);

  // Focus on open, placing the caret where the person clicked.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.focus({ preventScroll: true });
    const point = initialPoint
      ? caretFromPoint(root.ownerDocument, initialPoint.clientX, initialPoint.clientY)
      : null;
    if (point && root.contains(point.node)) {
      root.ownerDocument.getSelection()?.collapse(point.node, point.offset);
      const read = readSelection(root);
      if (read) {
        report(read);
        return;
      }
    }
    written.current.add(latest.current.selection);
    writeSelection(root, latest.current.selection);
    // Only on mount: later selection changes flow through the effects above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || focusRequest === undefined) return;
    if (root.ownerDocument.activeElement !== root) {
      root.focus({ preventScroll: true });
      writeSelection(root, latest.current.selection);
    }
  }, [focusRequest]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const doc = root.ownerDocument;
    const onSelection = () => {
      if (composing.current || doc.activeElement !== root) return;
      const read = readSelection(root);
      if (read) report(read);
    };
    doc.addEventListener('selectionchange', onSelection);
    return () => doc.removeEventListener('selectionchange', onSelection);
    // `report` reads everything through refs.
  }, []);

  /** Applies an edit, refusing one that breaks a text limit. */
  const commit = (
    next: DeckRichText,
    caret: number,
    kind: TextEditKind,
    limitCheck = true,
  ): void => {
    if (limitCheck) {
      const error = textLimitError(next);
      if (error) {
        latest.current.onLimit?.(error);
        return;
      }
    }
    const nextSelection = { anchor: caret, focus: caret };
    latest.current.selection = nextSelection;
    latest.current.onChange(next, nextSelection, kind);
  };

  // `beforeinput` is the one place the browser announces every intended edit.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType === 'insertCompositionText' || composing.current) return;
      event.preventDefault();
      const { body: current, pendingFormat: pending, nextId: id } = latest.current;
      const sel = liveSelection();
      const range = normalizeRange({ start: sel.anchor, end: sel.focus }, current);
      const text = flatText(current);
      const collapsed = range.start === range.end;
      const remove = (from: number, to: number) => {
        const target = normalizeRange({ start: from, end: to }, current);
        if (target.start === target.end) return;
        commit(deleteRange(current, target), target.start, 'delete', false);
      };
      switch (event.inputType) {
        case 'insertText':
        case 'insertReplacementText': {
          const data = event.data ?? event.dataTransfer?.getData('text/plain') ?? '';
          if (data === '') return;
          const next = insertText(current, range, data, id, pending ?? undefined);
          commit(next, range.start + data.replace(/\r\n?/g, '\n').length, 'type');
          return;
        }
        case 'insertParagraph':
          commit(splitParagraph(current, range, id), range.start + 1, 'structure');
          return;
        case 'insertLineBreak':
          commit(insertSoftBreak(current, range, id), range.start + 1, 'structure');
          return;
        case 'deleteContentBackward':
          return collapsed
            ? remove(caretStop(text, range.start, -1), range.start)
            : remove(range.start, range.end);
        case 'deleteContentForward':
          return collapsed
            ? remove(range.start, caretStop(text, range.start, 1))
            : remove(range.start, range.end);
        case 'deleteWordBackward':
          return collapsed
            ? remove(caretStop(text, range.start, -1, 'word'), range.start)
            : remove(range.start, range.end);
        case 'deleteWordForward':
          return collapsed
            ? remove(range.start, caretStop(text, range.start, 1, 'word'))
            : remove(range.start, range.end);
        case 'deleteSoftLineBackward':
        case 'deleteHardLineBackward': {
          if (!collapsed) return remove(range.start, range.end);
          const starts = paragraphStarts(current);
          const start = [...starts].reverse().find((entry) => entry < range.start) ?? 0;
          return remove(start, range.start);
        }
        case 'deleteSoftLineForward':
        case 'deleteHardLineForward': {
          if (!collapsed) return remove(range.start, range.end);
          const next = text.indexOf('\n', range.start);
          return remove(range.start, next < 0 ? text.length : next);
        }
        case 'deleteByCut':
        case 'deleteContent':
          return remove(range.start, range.end);
        case 'historyUndo':
          onUndo();
          return;
        case 'historyRedo':
          onRedo();
          return;
        default:
          // Formatting input types, drops, and anything else never touch the DOM.
          return;
      }
    };
    root.addEventListener('beforeinput', onBeforeInput);
    return () => root.removeEventListener('beforeinput', onBeforeInput);
    // `commit` and the handlers read everything through `latest`.
  }, [onRedo, onUndo]);

  const currentRange = () => {
    const live = liveSelection();
    return normalizeRange({ start: live.anchor, end: live.focus }, body);
  };

  const onCopy = (event: React.ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    event.preventDefault();
    const range = currentRange();
    if (range.start === range.end) return;
    const fragment = sliceRichText(body, range);
    const plainText = richTextToPlain(fragment);
    event.clipboardData.setData('text/plain', plainText);
    richClipboard = { plain: plainText, fragment };
    if (cut) commit(deleteRange(body, range), range.start, 'delete', false);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    if (new TextEncoder().encode(text).length > DECK_LIMITS.clipboardBytes) {
      onLimit?.('That is too much text to paste at once.');
      return;
    }
    const range = currentRange();
    const normalized = text.replace(/\r\n?/g, '\n');
    const fragment =
      richClipboard && richClipboard.plain === normalized
        ? structuredClone(richClipboard.fragment)
        : textFragment(normalized, pendingFormat ?? {});
    const next =
      richClipboard && richClipboard.plain === normalized
        ? insertRichText(body, range, fragment, nextId)
        : insertText(body, range, normalized, nextId, pendingFormat ?? undefined);
    const inserted = fragment.paragraphs.reduce(
      (total, paragraph, index) =>
        total +
        (index > 0 ? 1 : 0) +
        paragraph.runs.reduce((sum, run) => sum + (run.kind === 'break' ? 1 : run.text.length), 0),
      0,
    );
    commit(next, range.start + inserted, 'paste');
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    // Commands act on where the caret is now, not where the last event left it.
    const live = liveSelection();
    if (!composing.current) report(live);
    const mod = event.ctrlKey || event.metaKey;
    const lower = event.key.toLowerCase();
    if (event.key === 'Escape') {
      event.preventDefault();
      onExit?.();
      return;
    }
    if (mod && lower === 'z') {
      event.preventDefault();
      if (event.shiftKey) onRedo();
      else onUndo();
      return;
    }
    if (mod && lower === 'y') {
      event.preventDefault();
      onRedo();
      return;
    }
    if (onShortcut?.(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Tab' && !mod && !event.altKey) {
      event.preventDefault();
      const range = currentRange();
      commit(
        insertText(body, range, '\t', nextId, pendingFormat ?? undefined),
        range.start + 1,
        'type',
      );
    }
  };

  return (
    <div
      ref={rootRef}
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      contentEditable
      suppressContentEditableWarning
      tabIndex={0}
      spellCheck
      className={className}
      style={{ outline: 'none', cursor: 'text', ...style }}
      data-testid="deck-text-editor"
      onKeyDown={onKeyDown}
      onCopy={(event) => onCopy(event, false)}
      onCut={(event) => onCopy(event, true)}
      onPaste={onPaste}
      onDrop={(event) => event.preventDefault()}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onCompositionStart={() => {
        composing.current = { range: liveSelection() };
      }}
      onCompositionEnd={(event) => {
        const started = composing.current;
        composing.current = null;
        const data = event.data ?? '';
        const range = normalizeRange(
          { start: started?.range.anchor ?? 0, end: started?.range.focus ?? 0 },
          body,
        );
        const root = rootRef.current;
        if (data === '') {
          // Cancelled: the model never changed; redraw over the browser's edits.
          if (root) {
            renderEditorContent(root, resolved, { pxPerUnit, plain });
            writeSelection(root, selection);
          }
          return;
        }
        const next = insertText(body, range, data, nextId, pendingFormat ?? undefined);
        // Force a redraw even if React sees no prop change for this frame.
        if (root) renderEditorContent(root, resolved, { pxPerUnit, plain });
        commit(next, range.start + data.length, 'type');
      }}
    />
  );
}
