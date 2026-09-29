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
 * Live co-editing is presentation Phase 6 (`LiveDocumentKind::Deck` and the
 * `Y.Text` codec in `liveText.ts`). Until then a concurrent edit surfaces as a
 * conflict rather than being text-merged: interleaving two decks' JSON would
 * parse and be neither person's slides.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listen } from '@tauri-apps/api/event';

import type { DeckDocument } from '../../types/deck';
import { isVaultReadOnly } from '../../types/vault';
import type { VaultMeta } from '../../types/vault';
import { saveConflictedCopy } from '../conflictedCopy';
import {
  compareDocumentVersions,
  type DocumentSessionController,
  type DocumentSessionSnapshot,
  type DocumentStatus,
  type RemoteCandidate,
  useDocumentSessionController,
} from '../documentSessionController';
import { createVaultClient } from '../vaultClient';
import { onReplicaMutated, replicaMutationAffectsPath } from '../vaultReplica';

import {
  DeckDocumentError,
  type DeckSchemaSupport,
  normalizeDeckDocument,
  parseDeckDocument,
} from './document';
import { serializeDeck } from './validate';

interface UseDeckSessionOptions {
  vault: VaultMeta | null;
  relativePath: string | null;
  markDirty: (path: string) => void;
  markSaved: (path: string, hash: string) => void;
}

export interface DeckSession {
  document: DeckDocument | null;
  /** Applies an edit and marks the session dirty. Inert while read-only. */
  updateDocument: (updater: (current: DeckDocument) => DeckDocument) => void;
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

  const vaultReadOnly = isVaultReadOnly(vault);
  const readOnly = vaultReadOnly || schemaSupport === 'newer';
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);

  const applyDocument = useCallback((candidate: RemoteCandidate<DeckDocument>) => {
    documentRef.current = candidate.document;
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
    isLive: () => false,
  });

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
    if (snapshot.dirty) markDirty(relativePath);
    else if (snapshot.loadedVersion) markSaved(relativePath, `deck:${snapshot.loadedVersion}`);
  }, [markDirty, markSaved, relativePath, snapshot.dirty, snapshot.loadedVersion]);

  const updateDocument = useCallback(
    (updater: (current: DeckDocument) => DeckDocument) => {
      if (readOnly) return;
      const current = documentRef.current;
      if (!current) return;
      const next = updater(current);
      if (next === current) return;
      // Validated here so an operation can never persist a deck the server
      // would refuse; the caller turns the throw into a message.
      const checked = normalizeDeckDocument({ ...next, updatedAt: new Date().toISOString() });
      documentRef.current = checked.document;
      setDocument(checked.document);
      controller.markLocalChange(checked.document);
    },
    [controller, readOnly],
  );

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
  };
}
