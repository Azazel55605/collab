import type { DocumentSessionSnapshot } from './documentSessionController';

export type RetainedDocumentSession = Omit<DocumentSessionSnapshot<unknown>, 'pendingRemote'> & {
  pendingRemote: {
    content: string;
    version: string | null;
    source: DocumentSessionSnapshot<unknown>['source'];
  } | null;
};

function retainedBytes(state: RetainedDocumentSession) {
  // Conservative UTF-16 content/metadata estimate, without encoding whole
  // documents or walking the retained cache at every navigation boundary.
  return (
    1024 +
    2 *
      [
        state.currentContent,
        state.lastSavedContent,
        state.loadedVersion,
        state.lastAppliedRemoteVersion,
        state.conflict?.theirContent,
        state.conflict?.baseContent,
        state.conflict?.ourContent,
        state.conflict?.theirVersion,
        state.pendingRemote?.content,
        state.pendingRemote?.version,
      ].reduce<number>((total, text) => total + (text?.length ?? 0), 0)
  );
}

/** Serialized sessions only: no DOM, callbacks, parsed scenes, workers or sockets. */
export class DocumentSessionRetention {
  private entries = new Map<string, { state: RetainedDocumentSession; bytes: number }>();
  private generation = 0;
  private totalBytes = 0;
  constructor(
    private maxEntries = 64,
    private maxBytes = 16 * 1024 * 1024,
  ) {}
  get epoch() {
    return this.generation;
  }
  get(key: string) {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry?.state;
  }
  put(key: string, snapshot: DocumentSessionSnapshot<unknown>, epoch = this.generation) {
    if (epoch !== this.generation || snapshot.currentContent === null || snapshot.liveState) return;
    const { pendingRemote, ...rest } = snapshot;
    const state: RetainedDocumentSession = {
      ...rest,
      saving: false,
      saveQueued: false,
      pendingRemote: pendingRemote && {
        content: pendingRemote.content,
        version: pendingRemote.version,
        source: pendingRemote.source,
      },
    };
    this.remove(key);
    const bytes = retainedBytes(state);
    this.entries.set(key, { state, bytes });
    this.totalBytes += bytes;
    for (const [path, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) break;
      // Recovery drafts are pinned. Navigation normally saves them before detach;
      // an exceptional teardown must never silently evict unsaved content.
      if (entry.state.dirty || entry.state.conflicted || entry.state.pendingRemote) continue;
      this.remove(path);
    }
  }
  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) {
      this.totalBytes -= entry.bytes;
      this.entries.delete(key);
    }
  }
  activate(key: string) {
    this.remove(key);
  }
  get bytes() {
    return this.totalBytes;
  }
  clear() {
    this.generation++;
    this.entries.clear();
    this.totalBytes = 0;
  }
  removePath(scope: string, path: string) {
    for (const key of this.entries.keys()) {
      const [vault, file] = JSON.parse(key) as string[];
      if (vault === scope && (file === path || file.startsWith(`${path}/`))) this.remove(key);
    }
  }
}
export const documentSessionRetention = new DocumentSessionRetention();
