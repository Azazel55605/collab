/**
 * Load, edit, and save lifecycle for `.deck` presentations.
 *
 * Reads and writes go through the mode-agnostic {@link createVaultClient}, so
 * local and hosted vaults share one path, and writes use the normal optimistic
 * revision flow with conflict surfacing and the offline queue.
 *
 * Two things make a session read-only: hosted viewer access, and a document
 * whose `schemaVersion` is newer than this build understands — rewriting it
 * would strip fields a newer client wrote.
 *
 * Hosted decks are edited live (Phase 6): once the REST revision has loaded,
 * the session joins the deck's Yjs room (`liveDeckSession.ts`) and every edit
 * goes there instead of through REST saves. Different slides, objects, and
 * characters in one text box merge; the server writes ordinary `.deck`
 * revisions from the room. The offline replica keeps edits made offline and
 * merges them on reconnect. A room that is empty, unreadable, or a different
 * deck than the REST revision is discarded and REST stays in charge, so a
 * damaged cache can never replace the saved presentation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listen } from '@tauri-apps/api/event';

import type { DeckDocument } from '../../types/deck';
import { isVaultReadOnly } from '../../types/vault';
import type { VaultMeta } from '../../types/vault';
import { useCollabIdentity } from '../collabIdentity';
import { saveConflictedCopy } from '../conflictedCopy';
import {
  compareDocumentVersions,
  type DocumentSessionController,
  type DocumentSessionSnapshot,
  type DocumentStatus,
  type RemoteCandidate,
  useDocumentSessionController,
} from '../documentSessionController';
import { useLiveDocumentStatus } from '../useLiveDocumentStatus';
import { createVaultClient } from '../vaultClient';
import { onReplicaMutated, replicaMutationAffectsPath } from '../vaultReplica';

import {
  DeckDocumentError,
  type DeckSchemaSupport,
  normalizeDeckDocument,
  parseDeckDocument,
} from './document';
import { openLiveDeckSession } from './liveDeckSession';
import type { LiveDeckSession } from './liveDeckSession';
import { serializeDeck } from './validate';

interface UseDeckSessionOptions {
  vault: VaultMeta | null;
  relativePath: string | null;
  markDirty: (path: string) => void;
  markSaved: (path: string, hash: string) => void;
}

export interface DeckSession {
  document: DeckDocument | null;
  /**
   * Applies an edit and marks the session dirty, returning the validated
   * document now held (or null when read-only or empty). Throws, without
   * changing anything, if the edit would produce an invalid deck.
   */
  updateDocument: (updater: (current: DeckDocument) => DeckDocument) => DeckDocument | null;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  saving: boolean;
  status: DocumentStatus;
  /** True for hosted viewers *or* for a document this build may not rewrite. */
  readOnly: boolean;
  schemaSupport: DeckSchemaSupport;
  schemaVersion: number | null;
  /** Non-fatal repairs applied when the stored document was opened. */
  warnings: string[];
  save: () => Promise<void>;
  loadRemote: () => void;
  keepLocal: () => void;
  controller: DocumentSessionController<DeckDocument>;
  snapshot: DocumentSessionSnapshot<DeckDocument>;
  saveMineAsNew: (localContent: string) => Promise<void>;
  /** The live room, for hosted decks once joined; null for REST editing. */
  liveSession: LiveDeckSession | null;
  /** Increments whenever a collaborator's change (or the live seed) is adopted. */
  remoteRevision: number;
}

export function describeDeckOpenError(reason: unknown): string {
  if (reason instanceof DeckDocumentError) {
    const detail =
      reason.issues.length > 1 ? ` (and ${reason.issues.length - 1} more problems)` : '';
    return `This presentation could not be opened: ${reason.message}${detail}`;
  }
  if (reason instanceof SyntaxError)
    return `This presentation could not be opened: ${reason.message}`;
  return String(reason);
}

export function useDeckSession({
  vault,
  relativePath,
  markDirty,
  markSaved,
}: UseDeckSessionOptions): DeckSession {
  const [document, setDocument] = useState<DeckDocument | null>(null);
  // Mirrors `document` so edits are computed synchronously; a rejected edit
  // throws to its caller instead of inside a React state updater.
  const documentRef = useRef<DeckDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [schemaSupport, setSchemaSupport] = useState<DeckSchemaSupport>('supported');
  const [schemaVersion, setSchemaVersion] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [liveSession, setLiveSession] = useState<LiveDeckSession | null>(null);
  const liveSessionRef = useRef<LiveDeckSession | null>(null);
  const restDocumentRef = useRef<DeckDocument | null>(null);
  const [restLoadedPath, setRestLoadedPath] = useState<string | null>(null);
  const [remoteRevision, setRemoteRevision] = useState(0);
  const { userId, userName, userColor } = useCollabIdentity();

  const vaultReadOnly = isVaultReadOnly(vault);
  const readOnly = vaultReadOnly || schemaSupport === 'newer';
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);

  const applyDocument = useCallback((candidate: RemoteCandidate<DeckDocument>) => {
    documentRef.current = candidate.document;
    if (candidate.source !== 'live') restDocumentRef.current = candidate.document;
    setDocument(candidate.document);
  }, []);

  const { controller, snapshot } = useDocumentSessionController<DeckDocument>({
    serialize: serializeDeck,
    deserialize: (content) => parseDeckDocument(content).document,
    applyDocument,
    read: async () => {
      if (!client || !relativePath) return null;
      const doc = await client.readDocument(relativePath);
      return {
        content: doc.content,
        version: doc.version,
        source: doc.source && doc.source !== 'network' ? 'cache' : 'rest',
      };
    },
    write: async ({ content, expectedVersion, baseContent }) => {
      if (!client || !relativePath || readOnly) return { version: expectedVersion ?? '' };
      const result = await client.writeDocument(
        relativePath,
        content,
        expectedVersion ?? undefined,
        baseContent ?? undefined,
      );
      if (result.conflict) {
        let theirVersion: string | null = null;
        try {
          theirVersion = (await client.readDocument(relativePath)).version;
        } catch {
          // Best-effort; a null version makes a keep-mine resolution overwrite.
        }
        return {
          version: expectedVersion ?? '',
          conflict: {
            theirContent: result.conflict.theirContent ?? content,
            baseContent,
            theirVersion,
          },
        };
      }
      if (result.offlineQueued) return { version: result.version, offlineQueued: true };
      return { version: result.version, mergedContent: result.mergedContent };
    },
    mergeRemote: () => null,
    compareVersions: compareDocumentVersions,
    isLive: () => liveSessionRef.current !== null,
  });
  useLiveDocumentStatus(controller, liveSession);

  useEffect(() => {
    if (!client || !relativePath) {
      setDocument(null);
      setError('No presentation selected');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    documentRef.current = null;
    setDocument(null);
    setWarnings([]);
    setSchemaSupport('supported');
    setSchemaVersion(null);
    setRestLoadedPath(null);

    client
      .readDocument(relativePath)
      .then((doc) => {
        if (cancelled) return;
        const inspection = parseDeckDocument(doc.content);
        setSchemaSupport(inspection.support);
        setSchemaVersion(inspection.schemaVersion);
        setWarnings(inspection.warnings);
        if (inspection.support === 'newer') {
          // Never hand a newer document to the controller: it would serialize
          // it back through this build on the next save.
          documentRef.current = inspection.document;
          setDocument(inspection.document);
          return;
        }
        controller.load(doc.content, doc.version, 'rest');
        setRestLoadedPath(relativePath);
      })
      .catch((reason) => {
        if (cancelled) return;
        setDocument(null);
        setError(describeDeckOpenError(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, controller, relativePath]);

  useEffect(() => {
    if (!relativePath) return;
    // Live edits are saved by the room, never by this session.
    if (liveSession) return;
    if (snapshot.dirty) markDirty(relativePath);
    else if (snapshot.loadedVersion) markSaved(relativePath, `deck:${snapshot.loadedVersion}`);
  }, [liveSession, markDirty, markSaved, relativePath, snapshot.dirty, snapshot.loadedVersion]);

  const updateDocument = useCallback(
    (updater: (current: DeckDocument) => DeckDocument) => {
      if (readOnly) return null;
      const current = documentRef.current;
      if (!current) return null;
      const next = updater(current);
      if (next === current) return current;
      // Validated here so an operation can never persist a deck the server
      // would refuse; the caller turns the throw into a message.
      const checked = normalizeDeckDocument({ ...next, updatedAt: new Date().toISOString() });
      documentRef.current = checked.document;
      setDocument(checked.document);
      if (liveSessionRef.current) liveSessionRef.current.writeDeck(checked.document);
      else controller.markLocalChange(checked.document);
      return checked.document;
    },
    [controller, readOnly],
  );

  // Hosted decks join the live room once the REST revision is in hand; REST
  // stays the fallback and the integrity baseline for the room's first state.
  useEffect(() => {
    if (
      !client ||
      !relativePath ||
      !client.resolveLiveSession ||
      restLoadedPath !== relativePath ||
      schemaSupport !== 'supported'
    ) {
      liveSessionRef.current = null;
      setLiveSession(null);
      return;
    }
    let cancelled = false;
    let opened: LiveDeckSession | null = null;
    let off: (() => void) | undefined;

    const adopt = (json: Record<string, unknown>): boolean => {
      try {
        const next = normalizeDeckDocument(json).document;
        if (next.id !== restDocumentRef.current?.id) return false;
        controller.handleRemoteCandidate({
          document: next,
          content: serializeDeck(next),
          version: controller.version,
          source: 'live',
        });
        setRemoteRevision((revision) => revision + 1);
        return true;
      } catch {
        return false;
      }
    };

    const reject = (session: LiveDeckSession) => {
      session.discardOfflineState();
      session.destroy();
      if (liveSessionRef.current === session) liveSessionRef.current = null;
      setLiveSession(null);
      opened = null;
    };

    openLiveDeckSession(client, relativePath)
      .then((session) => {
        if (cancelled || !session) {
          session?.destroy();
          return;
        }
        opened = session;
        // Edits made in the moment before the room answered stay with REST
        // (they save normally); writing them into the room as a whole deck
        // could undo a collaborator's newer change.
        if (controller.getSnapshot().dirty) {
          session.destroy();
          opened = null;
          return;
        }
        const initial = session.readDeck();
        // An empty or foreign room never replaces the saved presentation.
        if (!initial || !adopt(initial)) {
          reject(session);
          return;
        }
        liveSessionRef.current = session;
        setLiveSession(session);
        off = session.onChange((json) => {
          if (cancelled) return;
          if (!adopt(json)) {
            setError(
              'The live presentation could not be read. The saved revision remains available.',
            );
            off?.();
            reject(session);
          }
        });
      })
      .catch(() => {
        // Best-effort: optimistic REST saves remain available.
      });

    return () => {
      cancelled = true;
      off?.();
      opened?.destroy();
      liveSessionRef.current = null;
      setLiveSession(null);
    };
  }, [client, controller, relativePath, restLoadedPath, schemaSupport]);

  useEffect(() => {
    if (!liveSession) return;
    liveSession.awareness.setLocalStateField('user', {
      id: userId,
      name: userName,
      color: userColor,
    });
    liveSession.awareness.setLocalStateField('document', { kind: 'deck', relativePath });
  }, [liveSession, relativePath, userColor, userId, userName]);

  // Local filesystem watcher: a clean deck reloads automatically, a dirty one
  // queues the remote version instead of discarding local edits.
  useEffect(() => {
    if (!client?.capabilities?.filesystemWatch || !relativePath || readOnly) return;
    let unlisten: (() => void) | undefined;
    void listen<{ path: string }>('vault:file-modified', async (event) => {
      if (event.payload?.path !== relativePath) return;
      if (Date.now() - controller.getSnapshot().lastLocalWriteStartedAt < 2000) return;
      await controller.handleExternalMutation('rest');
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, [client, controller, relativePath, readOnly]);

  // Hosted vaults have no watcher: the replica emitter reports remote changes.
  useEffect(() => {
    if (!relativePath || client?.capabilities?.filesystemWatch) return;
    return onReplicaMutated((mutation) => {
      if (!replicaMutationAffectsPath(mutation, relativePath)) return;
      void controller.handleExternalMutation('cache');
    });
  }, [client, controller, relativePath]);

  const save = useCallback(async () => {
    if (readOnly) return;
    await controller.requestSave('manual');
  }, [controller, readOnly]);

  const saveMineAsNew = useCallback(
    async (localContent: string) => {
      if (!client || !relativePath) return;
      await saveConflictedCopy(client, relativePath, localContent);
    },
    [client, relativePath],
  );

  return {
    document,
    updateDocument,
    loading,
    error,
    dirty: snapshot.dirty,
    saving: snapshot.status === 'saving',
    status: snapshot.status,
    readOnly,
    schemaSupport,
    schemaVersion,
    warnings,
    save,
    loadRemote: () => controller.loadRemote(),
    keepLocal: () => controller.keepMine(),
    controller,
    snapshot,
    saveMineAsNew,
    liveSession,
    remoteRevision,
  };
}
