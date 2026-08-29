import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

/**
 * Shared, framework-agnostic document session core (Phase 1 of the document
 * session & collaboration stability plan). It centralizes the version, dirty,
 * save, remote-change, and conflict state that was previously re-derived
 * independently by every editor view (`NoteView`, `useCanvasDocumentSession`,
 * `KanbanPage`, `LogicDiagramView`, `useSvgSession`, …).
 *
 * The controller owns no React, React Flow, CodeMirror, or document-format
 * knowledge: content is opaque strings, documents are an opaque `TDocument`,
 * and all IO is injected (`write`, `read`, `applyDocument`). This lets it be
 * unit-tested in isolation and reused by any view.
 *
 * It enforces the plan's safety invariants:
 * - never replace editor state while there are unsaved local changes
 *   (dirty remote candidates are queued, not applied);
 * - never apply a remote candidate older than / equal to the current session
 *   version (stale rejection);
 * - never reload while a local save is in flight (queue instead);
 * - serialize writes per document and coalesce trailing saves to the latest
 *   content (via {@link createExclusiveSaveRunner});
 * - stop autosave after a failed save / unresolved conflict until it is
 *   explicitly resolved;
 * - disable REST autosave while a live session owns persistence.
 */

export type DocumentSource = 'rest' | 'cache' | 'live' | 'local';

export type DocumentStatus =
  | 'idle'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'remote-pending'
  | 'conflict'
  | 'offline-queued'
  | 'live-connected'
  | 'live-reconnecting';

export type SaveReason = 'autosave' | 'manual' | 'flush';

/**
 * How a pending remote change or an active conflict should be resolved.
 * - `load-remote`: discard local edits and adopt the remote/their content.
 * - `keep-local`: keep local edits, rebasing onto the remote version so the
 *   next save overwrites it (backend three-way merge uses their content as the
 *   base).
 * - `save-as-new`: keep local edits; the caller persists them to a new
 *   revision/file. The core only clears conflict state.
 */
export type ConflictChoice = 'load-remote' | 'keep-local' | 'save-as-new';

export type RemoteDecision = 'applied' | 'queued' | 'merged' | 'stale' | 'ignored';

export interface RemoteCandidate<TDocument> {
  document: TDocument;
  content: string;
  version: string | null;
  source: DocumentSource;
}

export interface DocumentReadResult {
  content: string;
  version: string | null;
  source?: DocumentSource;
}

export interface ConflictState {
  /** The other side's current content. */
  theirContent: string;
  /** The last common base content, when the writer supplied one. */
  baseContent?: string;
  /** The other side's version token. */
  theirVersion: string | null;
  /** The local content that failed to save (always recoverable). */
  ourContent: string;
}

/**
 * The unresolved-remote state a view needs to render the Phase 3 review surface,
 * derived uniformly from either a queued pending-remote candidate or a hard
 * save conflict. `ours` is always a recoverable copy of the local content.
 */
export interface Reconciliation {
  kind: 'remote-pending' | 'conflict';
  /** Last common base content, when known (enables a three-way diff). */
  base: string | null;
  /** The local (unsaved) content — always recoverable. */
  ours: string;
  /** The other side's content. */
  theirs: string;
  /** The other side's version token. */
  theirVersion: string | null;
}

/**
 * Pure projection of a snapshot into the review model, so the shared surface can
 * render reactively from the subscribed snapshot rather than reaching into the
 * controller. Returns `null` when there is nothing to reconcile.
 */
export function deriveReconciliation<TDocument>(
  snapshot: DocumentSessionSnapshot<TDocument>,
): Reconciliation | null {
  if (snapshot.conflict) {
    return {
      kind: 'conflict',
      base: snapshot.conflict.baseContent ?? null,
      ours: snapshot.conflict.ourContent,
      theirs: snapshot.conflict.theirContent,
      theirVersion: snapshot.conflict.theirVersion,
    };
  }
  if (snapshot.pendingRemote) {
    return {
      kind: 'remote-pending',
      base: snapshot.lastSavedContent,
      ours: snapshot.currentContent ?? '',
      theirs: snapshot.pendingRemote.content,
      theirVersion: snapshot.pendingRemote.version,
    };
  }
  return null;
}

export interface DocumentWriteOutcome {
  version: string;
  /** Backend-merged content when concurrent non-overlapping edits were merged. */
  mergedContent?: string;
  /** Present when the write was rejected because the document changed elsewhere. */
  conflict?: {
    theirContent: string;
    baseContent?: string;
    theirVersion?: string | null;
  };
  /** The write could not reach the server and was queued for later sync. */
  offlineQueued?: boolean;
}

export interface DocumentSessionSnapshot<TDocument> {
  loadedVersion: string | null;
  lastSavedContent: string | null;
  currentContent: string | null;
  dirty: boolean;
  saving: boolean;
  saveQueued: boolean;
  conflicted: boolean;
  conflict: ConflictState | null;
  pendingRemote: RemoteCandidate<TDocument> | null;
  lastLocalWriteStartedAt: number;
  lastAppliedRemoteVersion: string | null;
  source: DocumentSource;
  liveState: 'live-connected' | 'live-reconnecting' | null;
  autosavePaused: boolean;
  offlineQueued: boolean;
  status: DocumentStatus;
}

export interface DocumentSessionControllerOptions<TDocument> {
  /** Persist content optimistically. Injected so the core stays client-agnostic. */
  write(args: {
    content: string;
    expectedVersion: string | null;
    baseContent?: string;
  }): Promise<DocumentWriteOutcome>;
  /** Serialize a document to the string content written to the vault. */
  serialize(doc: TDocument): string;
  /** Parse vault content into a document. */
  deserialize(content: string): TDocument;
  /**
   * Push an adopted document (clean remote auto-apply, forced remote load,
   * backend merge adoption, or explicit reload) into the view.
   */
  applyDocument(candidate: RemoteCandidate<TDocument>): void;
  /**
   * Read the current authoritative document, used by
   * {@link DocumentSessionController.handleExternalMutation}. Optional: when
   * omitted, external-mutation events that carry no document are ignored.
   */
  read?(): Promise<DocumentReadResult | null>;
  /**
   * Optional structural / three-way merge used when a remote candidate arrives
   * while the document is dirty. Returning `null` falls back to queuing the
   * candidate as pending. (Wired further in Phase 3.)
   */
  mergeRemote?(args: {
    base: string | null;
    local: TDocument;
    remote: TDocument;
  }): { document: TDocument; content: string } | null;
  /** Content equality; defaults to strict string equality. */
  isContentEqual?(a: string, b: string): boolean;
  /**
   * Version ordering: `< 0` if `a` is older than `b`, `0` if equal, `> 0` if
   * newer. When omitted, versions are treated as opaque tokens: a candidate is
   * stale only when its version equals the current or last-applied version
   * (mirroring today's `version !== current` reload checks). Phase 4 injects a
   * real manifest-sequence comparator here.
   */
  compareVersions?(a: string | null, b: string | null): number;
  /** Whether a live session currently owns persistence (disables REST autosave). */
  isLive?(): boolean;
  /** Notified on every observable state change (for non-React consumers). */
  onChange?(snapshot: DocumentSessionSnapshot<TDocument>): void;
  /** Debounced-autosave delay after a local change. Defaults to 600 ms. */
  autosaveDebounceMs?: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?(): number;
  /**
   * Injectable scheduler for the autosave debounce (tests). Returns a cancel
   * function. Defaults to `setTimeout`/`clearTimeout`.
   */
  schedule?(fn: () => void, ms: number): () => void;
}

const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 600;

/**
 * Runs document saves one at a time. If a save is requested while another is in
 * flight, the request is coalesced: only the most recent `save` thunk runs once
 * the current one finishes. This prevents overlapping writes from racing on
 * slow connections, where a second autosave would otherwise be sent with an
 * already-stale optimistic version and rejected ("file revision changed"). The
 * latest thunk always reads the freshest content and version, so the trailing
 * save reflects the newest edits with the version returned by the prior write.
 *
 * This is the primitive the whole plan builds on; `useDocumentSessionState`
 * (the legacy per-view hook) and {@link DocumentSessionController} both use it.
 */
export function createExclusiveSaveRunner(callbacks?: { onBusy?(): void; onIdle?(): void }) {
  let saving = false;
  let pending: null | (() => Promise<void>) = null;

  async function run(save: () => Promise<void>): Promise<void> {
    if (saving) {
      pending = save;
      return;
    }
    saving = true;
    callbacks?.onBusy?.();
    try {
      let current: (() => Promise<void>) | null = save;
      while (current) {
        pending = null;
        await current();
        current = pending;
      }
    } finally {
      saving = false;
      pending = null;
      callbacks?.onIdle?.();
    }
  }

  return {
    run,
    isBusy: () => saving,
    hasPending: () => pending !== null,
  };
}

/**
 * Shared ordering for document-session versions. Hosted document versions are
 * revision sequences, so older cached replica reads must be rejected instead of
 * treated as fresh just because their opaque token differs. Local hashes remain
 * opaque: equality is stale, any different hash is potentially new.
 */
export function compareDocumentVersions(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  const numericA = Number(a);
  const numericB = Number(b);
  if (Number.isInteger(numericA) && Number.isInteger(numericB)) {
    return numericA - numericB;
  }
  return 1;
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}

export class DocumentSessionController<TDocument> {
  private readonly options: DocumentSessionControllerOptions<TDocument>;
  private readonly runner: ReturnType<typeof createExclusiveSaveRunner>;
  private readonly listeners = new Set<() => void>();

  private loadedVersion: string | null = null;
  private lastSavedContent: string | null = null;
  private currentContent: string | null = null;
  private currentDocument: TDocument | null = null;
  private dirty = false;
  private saving = false;
  private saveQueued = false;
  private conflicted = false;
  private conflict: ConflictState | null = null;
  private pendingRemote: RemoteCandidate<TDocument> | null = null;
  private lastLocalWriteStartedAt = 0;
  private lastAppliedRemoteVersion: string | null = null;
  private source: DocumentSource = 'rest';
  private liveState: 'live-connected' | 'live-reconnecting' | null = null;
  private autosavePaused = false;
  private offlineQueued = false;
  private justSaved = false;

  private cancelAutosave: (() => void) | null = null;
  private snapshotCache: DocumentSessionSnapshot<TDocument> | null = null;

  constructor(options: DocumentSessionControllerOptions<TDocument>) {
    this.options = options;
    this.runner = createExclusiveSaveRunner({
      onBusy: () => {
        this.saving = true;
        this.invalidate();
      },
      onIdle: () => {
        this.saving = false;
        this.saveQueued = false;
        this.invalidate();
      },
    });
  }

  // ── Read side ────────────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): DocumentSessionSnapshot<TDocument> => {
    if (!this.snapshotCache) this.snapshotCache = this.buildSnapshot();
    return this.snapshotCache;
  };

  get status(): DocumentStatus {
    return this.deriveStatus();
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  get version(): string | null {
    return this.loadedVersion;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Establishes (or re-establishes) the session baseline from an authoritative
   * read. This is the "force explicit reload" policy used for initial load,
   * tab open/path change, and history/snapshot restore. Resets dirty, pending
   * remote, and conflict state.
   */
  load(content: string, version: string | null, source: DocumentSource = 'rest'): void {
    const document = this.options.deserialize(content);
    this.loadedVersion = version;
    this.lastSavedContent = content;
    this.currentContent = content;
    this.currentDocument = document;
    this.dirty = false;
    this.justSaved = false;
    this.pendingRemote = null;
    this.offlineQueued = false;
    this.clearConflictState();
    this.source = source;
    this.clearAutosave();
    this.options.applyDocument({ document, content, version, source });
    this.invalidate();
  }

  // ── Local edits ──────────────────────────────────────────────────────────

  /**
   * Records a local edit. Marks the session dirty when the serialized content
   * diverges from the last saved content and schedules a debounced autosave
   * (unless paused, conflicted, or a live session owns persistence).
   */
  markLocalChange(doc: TDocument): void {
    this.currentDocument = doc;
    this.currentContent = this.options.serialize(doc);
    this.dirty =
      this.lastSavedContent === null
        ? true
        : !this.contentEqual(this.currentContent, this.lastSavedContent);
    if (this.dirty) {
      this.justSaved = false;
      this.scheduleAutosave();
    }
    this.invalidate();
  }

  /** Requests a save now. Manual saves flush the debounce and run immediately. */
  requestSave(_reason: SaveReason = 'manual'): Promise<void> {
    if (this.conflicted) return Promise.resolve();
    // Live sessions persist through the server relay; the REST write path is
    // disabled so it never races the CRDT materialization with a stale version.
    if (this.options.isLive?.()) return Promise.resolve();
    if (this.currentContent === null) return Promise.resolve();
    this.clearAutosave();
    if (this.runner.isBusy()) {
      this.saveQueued = true;
      this.invalidate();
    }
    return this.runner.run(() => this.performSave());
  }

  private async performSave(): Promise<void> {
    const content = this.currentContent;
    if (content === null || this.conflicted) return;
    this.lastLocalWriteStartedAt = this.nowMs();
    const base = this.lastSavedContent ?? undefined;
    const outcome = await this.options.write({
      content,
      expectedVersion: this.loadedVersion,
      baseContent: base,
    });

    if (outcome.conflict) {
      this.setConflict(outcome.conflict, content);
      return;
    }

    if (outcome.offlineQueued) {
      // The bytes are safely queued locally; keep them dirty and surface the
      // offline status without advancing the session version.
      this.offlineQueued = true;
      this.pendingRemote = null;
      this.invalidate();
      return;
    }

    this.offlineQueued = false;
    const saved = outcome.mergedContent ?? content;
    this.loadedVersion = outcome.version;
    this.lastSavedContent = saved;
    if (saved !== content && !this.contentEqual(saved, content)) {
      // The backend auto-merged concurrent non-overlapping edits; adopt the
      // merged document as the new source of truth.
      this.currentContent = saved;
      const document = this.options.deserialize(saved);
      this.currentDocument = document;
      this.options.applyDocument({
        document,
        content: saved,
        version: outcome.version,
        source: 'rest',
      });
    }
    this.dirty =
      this.currentContent === null
        ? false
        : this.lastSavedContent !== null &&
          !this.contentEqual(this.currentContent, this.lastSavedContent);
    this.justSaved = !this.dirty;
    this.invalidate();
  }

  // ── Remote changes ─────────────────────────────────────────────────────────

  /**
   * Decides what to do with a concrete remote document candidate (from a
   * watcher re-read, replica refresh, cache/network read, or live seed):
   * - a live session owning the doc → `ignored`;
   * - a stale (older/equal) version → `stale`;
   * - a save in flight → `queued` (never clobber an in-flight write);
   * - clean document → `applied` (auto-apply, view can pulse);
   * - dirty document → `queued` as pending remote (merge UX is Phase 3).
   */
  handleRemoteCandidate(candidate: RemoteCandidate<TDocument>): RemoteDecision {
    if (candidate.source !== 'live' && this.options.isLive?.()) return 'ignored';

    // Live seeds/updates are authoritative for their document and bypass the
    // opaque-version staleness check (a live re-seed may reuse the version).
    if (candidate.source === 'live') {
      this.adoptRemote(candidate);
      return 'applied';
    }

    if (this.isStale(candidate.version)) return 'stale';

    if (this.saving || this.runner.isBusy()) {
      this.pendingRemote = candidate;
      this.invalidate();
      return 'queued';
    }

    if (!this.dirty) {
      this.adoptRemote(candidate);
      return 'applied';
    }

    // Dirty: attempt a safe merge, else queue as pending for the user to review.
    if (this.options.mergeRemote && this.currentDocument !== null) {
      const merged = this.options.mergeRemote({
        base: this.lastSavedContent,
        local: this.currentDocument,
        remote: candidate.document,
      });
      if (merged) {
        this.currentContent = merged.content;
        this.currentDocument = merged.document;
        this.loadedVersion = candidate.version;
        this.lastSavedContent = candidate.content;
        this.lastAppliedRemoteVersion = candidate.version;
        this.source = candidate.source;
        this.pendingRemote = null;
        this.dirty = !this.contentEqual(merged.content, candidate.content);
        this.options.applyDocument({
          document: merged.document,
          content: merged.content,
          version: candidate.version,
          source: candidate.source,
        });
        this.scheduleAutosave();
        this.invalidate();
        return 'merged';
      }
    }

    this.pendingRemote = candidate;
    this.invalidate();
    return 'queued';
  }

  /**
   * Handles an opaque external-mutation event (filesystem watcher / replica
   * mutation) by re-reading the authoritative document (via the injected
   * `read`) and routing it through {@link handleRemoteCandidate}. Skips the
   * read entirely when a live session owns the document.
   */
  async handleExternalMutation(source: DocumentSource = 'rest'): Promise<RemoteDecision> {
    if (this.options.isLive?.()) return 'ignored';
    if (!this.options.read) return 'ignored';
    // A re-read can fail for reasons that must not crash the editor: the vault's
    // server is not the connected one and there is no decryptable local cache, a
    // transient IO error, etc. Treat any such failure as "nothing to apply"
    // rather than letting it surface as an unhandled rejection from the watcher /
    // replica-mutation event handlers that drive this.
    let read: DocumentReadResult | null;
    try {
      read = await this.options.read();
    } catch {
      return 'ignored';
    }
    if (!read) return 'ignored';
    return this.handleRemoteCandidate({
      document: this.options.deserialize(read.content),
      content: read.content,
      version: read.version,
      source: read.source ?? source,
    });
  }

  /** Forcefully applies the queued pending remote, discarding local edits. */
  applyRemoteNow(): void {
    if (!this.pendingRemote) return;
    const candidate = this.pendingRemote;
    this.pendingRemote = null;
    this.adoptRemote(candidate);
  }

  /** Discards the queued pending remote, keeping local edits. */
  discardRemoteCandidate(): void {
    if (!this.pendingRemote) return;
    this.pendingRemote = null;
    this.invalidate();
  }

  /**
   * Uniform read model for the shared review surface, derived from whichever of
   * a conflict or a queued pending-remote is currently active.
   */
  getReconciliation(): Reconciliation | null {
    return deriveReconciliation(this.getSnapshot());
  }

  /**
   * "Load remote": adopt the other side's content, discarding local edits. Works
   * for both a hard conflict and a queued pending-remote. Callers should let the
   * user copy/export their local content first (the review surface does).
   */
  loadRemote(): void {
    if (this.conflict) {
      this.resolveConflict('load-remote');
      return;
    }
    this.applyRemoteNow();
  }

  /**
   * "Keep mine": keep the local edits but rebase them onto the other side's
   * version so the next save cleanly overwrites it (the backend three-way merge
   * treats their content as the base). For a pending-remote this replaces the
   * old "discard candidate" behavior, which left a stale version that would only
   * hard-conflict on the next autosave.
   */
  keepMine(): void {
    if (this.conflict) {
      this.resolveConflict('keep-local');
      return;
    }
    const pending = this.pendingRemote;
    if (!pending) return;
    this.pendingRemote = null;
    this.loadedVersion = pending.version;
    this.lastSavedContent = pending.content;
    this.lastAppliedRemoteVersion = pending.version;
    this.dirty =
      this.currentContent === null
        ? false
        : !this.contentEqual(this.currentContent, pending.content);
    this.justSaved = false;
    if (this.dirty) this.scheduleAutosave();
    this.invalidate();
  }

  /**
   * "Save mine as new revision": the caller persists the current local content
   * to a new file/revision (via `persist`), after which the active document
   * adopts the remote content. Both copies survive. If `persist` rejects, the
   * remote is not adopted and the reconciliation state is left intact so the
   * user can retry.
   */
  async saveMineAsNew(persist: (localContent: string) => Promise<void>): Promise<void> {
    const recon = this.getReconciliation();
    if (!recon) return;
    await persist(recon.ours);
    this.loadRemote();
  }

  private adoptRemote(candidate: RemoteCandidate<TDocument>): void {
    this.loadedVersion = candidate.version;
    this.lastSavedContent = candidate.content;
    this.currentContent = candidate.content;
    this.currentDocument = candidate.document;
    this.dirty = false;
    this.justSaved = false;
    this.pendingRemote = null;
    this.offlineQueued = false;
    this.lastAppliedRemoteVersion = candidate.version;
    this.source = candidate.source;
    this.clearAutosave();
    this.options.applyDocument(candidate);
    this.invalidate();
  }

  // ── Conflict ────────────────────────────────────────────────────────────────

  private setConflict(
    conflict: { theirContent: string; baseContent?: string; theirVersion?: string | null },
    ourContent: string,
  ): void {
    this.conflicted = true;
    this.conflict = {
      theirContent: conflict.theirContent,
      baseContent: conflict.baseContent,
      theirVersion: conflict.theirVersion ?? null,
      ourContent,
    };
    // A failed save / unresolved conflict must stop autosave until resolved.
    this.clearAutosave();
    this.invalidate();
  }

  /** Resolves an active conflict (or a pending remote) per the user's choice. */
  resolveConflict(choice: ConflictChoice): void {
    const conflict = this.conflict;
    if (!conflict) return;
    if (choice === 'load-remote') {
      this.clearConflictState();
      this.load(conflict.theirContent, conflict.theirVersion, 'rest');
      return;
    }
    if (choice === 'keep-local') {
      // Rebase onto their version so the next save overwrites it; the backend
      // three-way merge treats their content as the common base.
      this.loadedVersion = conflict.theirVersion;
      this.lastSavedContent = conflict.theirContent;
      this.dirty =
        this.currentContent === null
          ? false
          : !this.contentEqual(this.currentContent, conflict.theirContent);
      this.clearConflictState();
      if (this.dirty) this.scheduleAutosave();
      this.invalidate();
      return;
    }
    // save-as-new: the caller persists to a new revision/file; just clear state.
    this.clearConflictState();
    this.invalidate();
  }

  private clearConflictState(): void {
    this.conflicted = false;
    this.conflict = null;
  }

  // ── Autosave control ────────────────────────────────────────────────────────

  pauseAutosave(): void {
    if (this.autosavePaused) return;
    this.autosavePaused = true;
    this.clearAutosave();
    this.invalidate();
  }

  resumeAutosave(): void {
    if (!this.autosavePaused) return;
    this.autosavePaused = false;
    if (this.dirty) this.scheduleAutosave();
    this.invalidate();
  }

  /** Updates the live connection state used for the status vocabulary. */
  setLiveState(state: 'live-connected' | 'live-reconnecting' | null): void {
    if (this.liveState === state) return;
    this.liveState = state;
    if (state) this.clearAutosave();
    this.invalidate();
  }

  /** Cancels pending timers. Call on unmount. */
  dispose(): void {
    this.clearAutosave();
    this.listeners.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private scheduleAutosave(): void {
    if (this.autosavePaused || this.conflicted) return;
    if (this.options.isLive?.()) return;
    this.clearAutosave();
    const schedule = this.options.schedule ?? defaultSchedule;
    const delay = this.options.autosaveDebounceMs ?? DEFAULT_AUTOSAVE_DEBOUNCE_MS;
    this.cancelAutosave = schedule(() => {
      this.cancelAutosave = null;
      // A rejected write (e.g. an unexpected backend/IO error) must never surface
      // as an unhandled rejection from the debounce timer; the content stays
      // dirty and a later save/flush retries.
      void this.requestSave('autosave').catch(() => {});
    }, delay);
  }

  private clearAutosave(): void {
    if (this.cancelAutosave) {
      this.cancelAutosave();
      this.cancelAutosave = null;
    }
  }

  private isStale(candidateVersion: string | null): boolean {
    if (this.options.compareVersions) {
      return this.options.compareVersions(candidateVersion, this.loadedVersion) <= 0;
    }
    // Opaque tokens: a candidate equal to what we already have (or already
    // applied) carries no change and is stale; anything else is treated as new.
    if (candidateVersion === this.loadedVersion) return true;
    if (candidateVersion !== null && candidateVersion === this.lastAppliedRemoteVersion)
      return true;
    return false;
  }

  private contentEqual(a: string, b: string): boolean {
    return this.options.isContentEqual ? this.options.isContentEqual(a, b) : a === b;
  }

  private nowMs(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private deriveStatus(): DocumentStatus {
    if (this.conflicted) return 'conflict';
    if (this.saving) return 'saving';
    if (this.offlineQueued) return 'offline-queued';
    if (this.pendingRemote) return 'remote-pending';
    if (this.dirty) return 'dirty';
    if (this.liveState) return this.liveState;
    if (this.justSaved) return 'saved';
    return 'idle';
  }

  private buildSnapshot(): DocumentSessionSnapshot<TDocument> {
    return {
      loadedVersion: this.loadedVersion,
      lastSavedContent: this.lastSavedContent,
      currentContent: this.currentContent,
      dirty: this.dirty,
      saving: this.saving,
      saveQueued: this.saveQueued,
      conflicted: this.conflicted,
      conflict: this.conflict,
      pendingRemote: this.pendingRemote,
      lastLocalWriteStartedAt: this.lastLocalWriteStartedAt,
      lastAppliedRemoteVersion: this.lastAppliedRemoteVersion,
      source: this.source,
      liveState: this.liveState,
      autosavePaused: this.autosavePaused,
      offlineQueued: this.offlineQueued,
      status: this.deriveStatus(),
    };
  }

  private invalidate(): void {
    this.snapshotCache = this.buildSnapshot();
    this.options.onChange?.(this.snapshotCache);
    for (const listener of this.listeners) listener();
  }
}

/**
 * React binding for {@link DocumentSessionController}. Creates a single
 * controller instance whose injected callbacks always delegate to the latest
 * `options` (so the view can pass fresh closures every render without
 * recreating the session), and subscribes to its snapshot.
 */
export function useDocumentSessionController<TDocument>(
  options: DocumentSessionControllerOptions<TDocument>,
): {
  controller: DocumentSessionController<TDocument>;
  snapshot: DocumentSessionSnapshot<TDocument>;
} {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const controller = useMemo(() => {
    const proxy: DocumentSessionControllerOptions<TDocument> = {
      write: (args) => optionsRef.current.write(args),
      serialize: (doc) => optionsRef.current.serialize(doc),
      deserialize: (content) => optionsRef.current.deserialize(content),
      applyDocument: (candidate) => optionsRef.current.applyDocument(candidate),
      read: () => (optionsRef.current.read ? optionsRef.current.read() : Promise.resolve(null)),
      mergeRemote: (args) => optionsRef.current.mergeRemote?.(args) ?? null,
      isContentEqual: (a, b) =>
        optionsRef.current.isContentEqual ? optionsRef.current.isContentEqual(a, b) : a === b,
      compareVersions: optionsRef.current.compareVersions
        ? (a, b) => optionsRef.current.compareVersions!(a, b)
        : undefined,
      isLive: () => optionsRef.current.isLive?.() ?? false,
      onChange: (snapshot) => optionsRef.current.onChange?.(snapshot),
      autosaveDebounceMs: optionsRef.current.autosaveDebounceMs,
      now: () => (optionsRef.current.now ? optionsRef.current.now() : Date.now()),
      schedule: optionsRef.current.schedule
        ? (fn, ms) => optionsRef.current.schedule!(fn, ms)
        : undefined,
    };
    return new DocumentSessionController<TDocument>(proxy);
    // The controller intentionally lives for the lifetime of the hook; callers
    // remount it by changing the hook's key (e.g. relativePath) upstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => controller.dispose(), [controller]);

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  return { controller, snapshot };
}
