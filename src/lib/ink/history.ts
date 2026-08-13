/**
 * Local undo/redo for ink editing.
 *
 * A stack of the inverses `operations.ts` already produces. Nothing here
 * reconstructs state after the fact — the inverse was captured at the moment of
 * the edit, when the erased stroke's samples still existed.
 *
 * **Scoped to the local user's own operations**, per the plan. A shared undo
 * stack in a collaborative document lets one person undo another's work, which
 * is never what either of them meant. When Phase 6 lands, remote changes arrive
 * as new document state and simply invalidate stale redo entries; they never
 * enter this stack.
 */

import type { InkEdit, InkOperation } from './operations';

/** How many steps back a user can go. Deep enough for a session, bounded. */
export const INK_HISTORY_LIMIT = 200;

export interface InkHistoryEntry<T> {
  /** Undoes this edit. */
  undo: InkOperation<T>;
  /** Human-readable, for an undo tooltip or an accessibility announcement. */
  label: string;
}

export interface InkHistorySnapshot {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  depth: number;
}

/**
 * An undo stack over a document of type `T`.
 *
 * The caller owns the document; this owns only how to reverse the edits. That
 * split means the stack cannot hold a stale copy of the document and hand it
 * back over the top of newer state.
 */
export class InkHistory<T> {
  private undoStack: Array<InkHistoryEntry<T>> = [];
  private redoStack: Array<InkHistoryEntry<T>> = [];

  constructor(private readonly limit: number = INK_HISTORY_LIMIT) {}

  /**
   * Records an edit that has already been applied.
   *
   * Pushing clears the redo stack: once you edit after undoing, the branch you
   * undid is unreachable, and keeping it would let a redo splice unrelated work
   * back into the drawing.
   */
  push(edit: InkEdit<T>, label: string): void {
    this.undoStack.push({ undo: edit.inverse, label });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Applies one undo, returning the resulting document. */
  undo(document: T): T | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    const reverted = entry.undo(document);
    this.redoStack.push({ undo: reverted.inverse, label: entry.label });
    return reverted.result;
  }

  /** Applies one redo, returning the resulting document. */
  redo(document: T): T | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    const reapplied = entry.undo(document);
    this.undoStack.push({ undo: reapplied.inverse, label: entry.label });
    return reapplied.result;
  }

  /**
   * Drops everything.
   *
   * Called when the document is replaced wholesale — a reload, a conflict
   * resolution, a switch to another file. Every inverse in the stack describes
   * a document that no longer exists, and applying one would corrupt the new
   * one rather than undo anything.
   */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  snapshot(): InkHistorySnapshot {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack[this.undoStack.length - 1]?.label ?? null,
      redoLabel: this.redoStack[this.redoStack.length - 1]?.label ?? null,
      depth: this.undoStack.length,
    };
  }
}
