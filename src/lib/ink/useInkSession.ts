/**
 * Load, edit, and save lifecycle for `.ink` drawings.
 *
 * Reads and writes go through the mode-agnostic {@link createVaultClient}, so
 * local and hosted vaults share one path and writes use the normal optimistic
 * revision flow with conflict surfacing.
 *
 * Two things make a session read-only: hosted viewer access, and a document
 * whose `schemaVersion` is newer than this build understands — rewriting the
 * latter would silently strip fields a newer client wrote.
 *
 * Hosted drawings prefer the Phase 6 live Ink CRDT session and retain this
 * controller as the local-vault and unavailable-socket fallback.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

import {
  compareDocumentVersions,
  useDocumentSessionController,
  type DocumentSessionController,
  type DocumentSessionSnapshot,
  type DocumentStatus,
  type RemoteCandidate,
} from '../documentSessionController';
import { createVaultClient } from '../vaultClient';
import { saveConflictedCopy } from '../conflictedCopy';
import { onReplicaMutated, replicaMutationAffectsPath } from '../vaultReplica';
import { isVaultReadOnly } from '../../types/vault';
import type { VaultMeta } from '../../types/vault';
import type { InkDocument } from '../../types/ink';
import {
  InkDocumentError,
  normalizeInkDocument,
  parseInkDocument,
  serializeInkDocument,
  type InkSchemaSupport,
} from './document';
import { openLiveInkSession, type LiveInkSession } from '../liveInkDocument';
import { useLiveDocumentStatus } from '../useLiveDocumentStatus';

interface UseInkSessionOptions {
  vault: VaultMeta | null;
  relativePath: string | null;
  markDirty: (path: string) => void;
  markSaved: (path: string, hash: string) => void;
}

export interface InkSession {
  document: InkDocument | null;
  /** Applies an edit and marks the session dirty. Inert while read-only. */
  updateDocument: (updater: (current: InkDocument) => InkDocument) => void;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  saving: boolean;
  status: DocumentStatus;
  /** True for hosted viewers *or* for a document this build may not rewrite. */
  readOnly: boolean;
  schemaSupport: InkSchemaSupport;
  schemaVersion: number | null;
  /** Non-fatal repairs applied when the stored document was opened. */
  warnings: string[];
  save: () => Promise<void>;
  loadRemote: () => void;
  keepLocal: () => void;
  controller: DocumentSessionController<InkDocument>;
  snapshot: DocumentSessionSnapshot<InkDocument>;
  saveMineAsNew: (localContent: string) => Promise<void>;
  liveSession: LiveInkSession | null;
}

export function useInkSession({
  vault,
  relativePath,
  markDirty,
  markSaved,
}: UseInkSessionOptions): InkSession {
  const [document, setDocument] = useState<InkDocument | null>(null);
  // Mirrors `document` so edits can be computed synchronously: an operation
  // that rejects an edit must throw to its caller, not inside a React state
  // updater where it would escape as a render error and take the view down.
  const documentRef = useRef<InkDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [schemaSupport, setSchemaSupport] = useState<InkSchemaSupport>('supported');
  const [schemaVersion, setSchemaVersion] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [restLoaded, setRestLoaded] = useState(false);
  const [liveSession, setLiveSession] = useState<LiveInkSession | null>(null);
  const liveSessionRef = useRef<LiveInkSession | null>(null);

  const vaultReadOnly = isVaultReadOnly(vault);
  const readOnly = vaultReadOnly || schemaSupport === 'newer';
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  const drawingName = useMemo(
    () => relativePath?.split('/').pop()?.replace(/\.ink$/i, '') ?? 'Drawing',
    [relativePath],
  );

  const applyDocument = useCallback((candidate: RemoteCandidate<InkDocument>) => {
    documentRef.current = candidate.document;
    setDocument(candidate.document);
  }, []);

  const { controller, snapshot } = useDocumentSessionController<InkDocument>({
    serialize: serializeInkDocument,
    deserialize: (content) => parseInkDocument(content).document,
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
    // No structural merge yet: a text merge of two drawings would interleave
    // sample arrays into something that parses and is not what either person
    // drew. Phase 6 merges through the CRDT instead; until then a genuine
    // conflict is surfaced for the user to resolve.
    mergeRemote: () => null,
    compareVersions: compareDocumentVersions,
    isLive: () => liveSessionRef.current !== null,
  });

  useLiveDocumentStatus(controller, liveSession);

  useEffect(() => {
    if (!client || !relativePath) {
      setDocument(null);
      setError('No drawing selected');
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
    setRestLoaded(false);

    client.readDocument(relativePath)
      .then((doc) => {
        if (cancelled) return;
        const inspection = normalizeInkDocument(JSON.parse(doc.content));
        setSchemaSupport(inspection.support);
        setSchemaVersion(inspection.schemaVersion);
        setWarnings(inspection.warnings);
        if (inspection.support === 'newer') {
          // Never hand a newer document to the controller: it would serialize
          // it back through this build's normalizer on the next save.
          documentRef.current = inspection.document;
          setDocument(inspection.document);
          return;
        }
        controller.load(doc.content, doc.version, 'rest');
      })
      .catch((reason) => {
        if (cancelled) return;
        setDocument(null);
        setError(
          reason instanceof InkDocumentError || reason instanceof SyntaxError
            ? `This drawing could not be opened: ${reason.message}`
            : String(reason),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setRestLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, controller, relativePath, drawingName]);

  useEffect(() => {
    if (!client || !relativePath || !restLoaded || schemaSupport !== 'supported' || !client.resolveLiveSession) {
      liveSessionRef.current = null;
      setLiveSession(null);
      return;
    }
    let cancelled = false;
    let opened: LiveInkSession | null = null;
    let off: (() => void) | undefined;
    openLiveInkSession(client, relativePath)
      .then((session) => {
        if (cancelled || !session) {
          session?.destroy();
          return;
        }
        const initial = session.readDocument();
        if (!initial) {
          session.discardOfflineState();
          session.destroy();
          return;
        }
        const inspection = normalizeInkDocument(initial);
        if (inspection.support !== 'supported') {
          session.discardOfflineState();
          session.destroy();
          return;
        }
        opened = session;
        liveSessionRef.current = session;
        documentRef.current = inspection.document;
        setDocument(inspection.document);
        off = session.onChange((candidate) => {
          if (cancelled) return;
          const remote = normalizeInkDocument(candidate);
          if (remote.support !== 'supported') return;
          documentRef.current = remote.document;
          setDocument(remote.document);
        });
        setLiveSession(session);
      })
      .catch(() => {
        // Best-effort: the REST controller remains active.
      });
    return () => {
      cancelled = true;
      off?.();
      if (liveSessionRef.current === opened) liveSessionRef.current = null;
      opened?.destroy();
      setLiveSession(null);
    };
  }, [client, relativePath, restLoaded, schemaSupport]);

  useEffect(() => {
    if (!relativePath) return;
    if (liveSession) return;
    if (snapshot.dirty) markDirty(relativePath);
    else if (snapshot.loadedVersion) markSaved(relativePath, `ink:${snapshot.loadedVersion}`);
  }, [liveSession, markDirty, markSaved, relativePath, snapshot.dirty, snapshot.loadedVersion]);

  const updateDocument = useCallback(
    (updater: (current: InkDocument) => InkDocument) => {
      if (readOnly) return;
      const current = documentRef.current;
      if (!current) return;
      // Applied synchronously so a rejected operation throws here, where the
      // caller can turn it into a message.
      const next = updater(current);
      if (next === current) return;
      const stamped: InkDocument = { ...next, updatedAt: new Date().toISOString() };
      documentRef.current = stamped;
      setDocument(stamped);
      if (liveSessionRef.current) liveSessionRef.current.writeDocument(stamped);
      else controller.markLocalChange(stamped);
    },
    [controller, readOnly],
  );

  // Local filesystem watcher: a clean drawing reloads automatically, a dirty
  // one queues the remote version instead of discarding local edits.
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
      if (liveSessionRef.current) return;
      if (!replicaMutationAffectsPath(mutation, relativePath)) return;
      void controller.handleExternalMutation('cache');
    });
  }, [client, controller, relativePath]);

  const save = useCallback(async () => {
    if (readOnly || liveSessionRef.current) return;
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
  };
}
