import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listen } from '@tauri-apps/api/event';

import type { SheetDocument } from '../../types/sheet';
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
import { type JsonObject, type LiveJsonSession, openLiveJsonSession } from '../liveJsonDocument';
import { useLiveDocumentStatus } from '../useLiveDocumentStatus';
import { createVaultClient } from '../vaultClient';
import { onReplicaMutated, replicaMutationAffectsPath } from '../vaultReplica';

import { mergeSheetDocuments } from './collaboration';
import {
  inspectSheetDocumentText,
  parseSheetDocument,
  serializeSheetDocument,
  SheetDocumentError,
  type SheetSchemaSupport,
} from './document';

interface UseSheetSessionOptions {
  vault: VaultMeta | null;
  relativePath: string | null;
  markDirty: (path: string) => void;
  markSaved: (path: string, hash: string) => void;
}

export interface SheetSession {
  document: SheetDocument | null;
  /** Applies an edit and marks the session dirty. Inert while read-only. */
  updateDocument: (updater: (current: SheetDocument) => SheetDocument) => void;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  saving: boolean;
  status: DocumentStatus;
  /** True for hosted viewers *or* for a workbook this build may not rewrite. */
  readOnly: boolean;
  schemaSupport: SheetSchemaSupport;
  schemaVersion: number | null;
  /** Non-fatal repairs applied when the stored workbook was opened. */
  warnings: string[];
  save: () => Promise<void>;
  loadRemote: () => void;
  keepLocal: () => void;
  /** Hosted structured collaboration session; null for local/REST fallback. */
  liveSession: LiveJsonSession | null;
  controller: DocumentSessionController<SheetDocument>;
  snapshot: DocumentSessionSnapshot<SheetDocument>;
  saveMineAsNew: (localContent: string) => Promise<void>;
  /** Increments only when a live seed/remote update is adopted. */
  remoteRevision: number;
}

function sheetToJson(document: SheetDocument): JsonObject {
  return JSON.parse(JSON.stringify(document)) as JsonObject;
}

/**
 * Load/parse/save lifecycle for `.sheet` workbooks.
 *
 * Reads and writes go through the mode-agnostic {@link createVaultClient}, so
 * local and hosted vaults share one path, and writes use the normal optimistic
 * revision flow with conflict surfacing. Two things make a session read-only:
 * hosted viewer access, and a workbook whose `schemaVersion` is newer than this
 * build understands — rewriting the latter would silently strip fields a newer
 * client wrote.
 */
export function useSheetSession({
  vault,
  relativePath,
  markDirty,
  markSaved,
}: UseSheetSessionOptions): SheetSession {
  const [document, setDocument] = useState<SheetDocument | null>(null);
  // Mirrors `document` so edits can be computed synchronously (see
  // `updateDocument`): an operation that rejects an edit must throw to its
  // caller, not inside a React state updater where it would escape as a render
  // error and take the whole view down.
  const documentRef = useRef<SheetDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [schemaSupport, setSchemaSupport] = useState<SheetSchemaSupport>('supported');
  const [schemaVersion, setSchemaVersion] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [liveSession, setLiveSession] = useState<LiveJsonSession | null>(null);
  const liveSessionRef = useRef<LiveJsonSession | null>(null);
  const restDocumentRef = useRef<SheetDocument | null>(null);
  const [restLoadedPath, setRestLoadedPath] = useState<string | null>(null);
  const [remoteRevision, setRemoteRevision] = useState(0);
  const { userId, userName, userColor } = useCollabIdentity();

  const vaultReadOnly = isVaultReadOnly(vault);
  const readOnly = vaultReadOnly || schemaSupport === 'newer';
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  const workbookName = useMemo(
    () =>
      relativePath
        ?.split('/')
        .pop()
        ?.replace(/\.sheet$/i, '') ?? 'Workbook',
    [relativePath],
  );

  const applyDocument = useCallback((candidate: RemoteCandidate<SheetDocument>) => {
    documentRef.current = candidate.document;
    if (candidate.source !== 'live') restDocumentRef.current = candidate.document;
    setDocument(candidate.document);
  }, []);

  const { controller, snapshot } = useDocumentSessionController<SheetDocument>({
    serialize: serializeSheetDocument,
    deserialize: (content) => parseSheetDocument(content, workbookName),
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
    mergeRemote: ({ base, local, remote }) => {
      if (!base) return null;
      let baseDocument: SheetDocument;
      try {
        baseDocument = parseSheetDocument(base, workbookName);
      } catch {
        return null;
      }
      const merged = mergeSheetDocuments(baseDocument, local, remote);
      if (merged.conflicts.length > 0) return null;
      return {
        document: merged.document,
        content: serializeSheetDocument(merged.document),
      };
    },
    isLive: () => liveSessionRef.current !== null,
    compareVersions: compareDocumentVersions,
  });
  useLiveDocumentStatus(controller, liveSession);

  useEffect(() => {
    if (!client || !relativePath) {
      setDocument(null);
      setError('No workbook selected');
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
        const inspection = inspectSheetDocumentText(doc.content, workbookName);
        setSchemaSupport(inspection.support);
        setSchemaVersion(inspection.schemaVersion);
        setWarnings(inspection.warnings);
        if (inspection.support === 'newer') {
          // Never hand a newer workbook to the session: the controller would
          // serialize it back through this build's normalizer on the next save.
          documentRef.current = inspection.document;
          restDocumentRef.current = inspection.document;
          setDocument(inspection.document);
          return;
        }
        controller.load(doc.content, doc.version, 'rest');
        setRestLoadedPath(relativePath);
      })
      .catch((reason) => {
        if (cancelled) return;
        setDocument(null);
        setError(reason instanceof SheetDocumentError ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, controller, relativePath, workbookName]);

  useEffect(() => {
    if (!relativePath) return;
    if (liveSession) return;
    if (snapshot.dirty) markDirty(relativePath);
    else if (snapshot.loadedVersion) markSaved(relativePath, `sheet:${snapshot.loadedVersion}`);
  }, [liveSession, markDirty, markSaved, relativePath, snapshot.dirty, snapshot.loadedVersion]);

  const updateDocument = useCallback(
    (updater: (current: SheetDocument) => SheetDocument) => {
      if (readOnly) return;
      const current = documentRef.current;
      if (!current) return;
      // Applied synchronously so a rejected operation throws here, where the
      // caller can turn it into a message.
      const next = updater(current);
      if (next === current) return;
      const stamped: SheetDocument = { ...next, updatedAt: new Date().toISOString() };
      documentRef.current = stamped;
      setDocument(stamped);
      if (liveSessionRef.current) {
        liveSessionRef.current.writeJson(sheetToJson(stamped));
      } else {
        controller.markLocalChange(stamped);
      }
    },
    [controller, readOnly],
  );

  // Hosted sheets use the same structured Yjs room and offline replica as
  // Kanban/canvas. REST remains the fallback and initial integrity baseline.
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
    let opened: LiveJsonSession | null = null;
    let off: (() => void) | undefined;

    const adoptLive = (json: JsonObject): boolean => {
      try {
        const next = parseSheetDocument(JSON.stringify(json), workbookName);
        controller.handleRemoteCandidate({
          document: next,
          content: serializeSheetDocument(next),
          version: controller.version,
          source: 'live',
        });
        setRemoteRevision((revision) => revision + 1);
        return true;
      } catch {
        setError(
          'Live workbook state is invalid. The REST revision remains available for recovery.',
        );
        return false;
      }
    };

    openLiveJsonSession(client, relativePath)
      .then((session) => {
        if (cancelled || !session) {
          session?.destroy();
          return;
        }
        opened = session;
        const initialJson = session.readJson();
        if (Object.keys(initialJson).length === 0) {
          session.discardOfflineState();
          session.destroy();
          opened = null;
          return;
        }

        let initial: SheetDocument;
        try {
          initial = parseSheetDocument(JSON.stringify(initialJson), workbookName);
        } catch {
          session.discardOfflineState();
          session.destroy();
          opened = null;
          return;
        }

        const rest = restDocumentRef.current;
        const liveWorksheetIds = new Set(initial.worksheets.map((worksheet) => worksheet.id));
        const lostWorksheet =
          rest?.worksheets.some((worksheet) => !liveWorksheetIds.has(worksheet.id)) ?? false;
        if (initial.id !== rest?.id || initial.worksheets.length === 0 || lostWorksheet) {
          session.discardOfflineState();
          session.destroy();
          opened = null;
          return;
        }

        liveSessionRef.current = session;
        setLiveSession(session);
        if (!adoptLive(initialJson)) {
          session.discardOfflineState();
          session.destroy();
          liveSessionRef.current = null;
          setLiveSession(null);
          opened = null;
          return;
        }
        off = session.onChange((json) => {
          if (!cancelled && !adoptLive(json)) {
            session.destroy();
            liveSessionRef.current = null;
            setLiveSession(null);
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
  }, [client, controller, relativePath, restLoadedPath, schemaSupport, workbookName]);

  useEffect(() => {
    if (!liveSession) return;
    liveSession.awareness.setLocalStateField('user', {
      id: userId,
      name: userName,
      color: userColor,
    });
    liveSession.awareness.setLocalStateField('document', {
      kind: 'sheet',
      relativePath,
    });
  }, [liveSession, relativePath, userColor, userId, userName]);

  // Local filesystem watcher: a clean workbook reloads automatically, a dirty
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
    liveSession,
    controller,
    snapshot,
    saveMineAsNew,
    remoteRevision,
  };
}
