import { type SetStateAction, useCallback, useEffect, useMemo, useState } from 'react';

import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';

import {
  compareDocumentVersions,
  type DocumentStatus,
  type RemoteCandidate,
  useDocumentSessionController,
} from '../../lib/documentSessionController';
import { parseSvg, serializeScene, SvgParseError } from '../../lib/svgDocument';
import { createVaultClient } from '../../lib/vaultClient';
import { onReplicaMutated, replicaMutationAffectsPath } from '../../lib/vaultReplica';
import type { SvgScene } from '../../types/svg';
import { isVaultReadOnly } from '../../types/vault';
import type { VaultMeta } from '../../types/vault';

interface UseSvgSessionOptions {
  vault: VaultMeta | null;
  relativePath: string | null;
  markDirty: (path: string) => void;
  markSaved: (path: string, hash: string) => void;
}

export interface SvgSession {
  scene: SvgScene | null;
  setScene: React.Dispatch<React.SetStateAction<SvgScene | null>>;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  saving: boolean;
  status: DocumentStatus;
  readOnly: boolean;
  /**
   * True when the file could only be read as a binary asset (a hosted SVG that
   * was imported as an image before SVGs became text documents). Such files open
   * for editing but cannot be saved back through the document-revision path.
   */
  assetBacked: boolean;
  save: () => Promise<void>;
  loadRemote: () => void;
  keepLocal: () => void;
}

/** Decode a `data:` URL (base64 or percent-encoded) to a UTF-8 string. */
function decodeDataUrlText(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return dataUrl;
  const meta = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return decodeURIComponent(payload);
}

/**
 * Load/parse/save lifecycle for the SVG vector editor. Reads the `.svg` as a
 * text document through the active {@link createVaultClient} (so it works for
 * both local and hosted vaults), parses it into an editable {@link SvgScene},
 * and writes changes back through the optimistic text-write path. Editing is
 * disabled (read-only) for hosted viewers via {@link isVaultReadOnly}.
 */
export function useSvgSession({
  vault,
  relativePath,
  markDirty,
  markSaved,
}: UseSvgSessionOptions): SvgSession {
  const [scene, setScene] = useState<SvgScene | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetBacked, setAssetBacked] = useState(false);

  const readOnly = isVaultReadOnly(vault);
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);

  const applySvgDocument = useCallback((candidate: RemoteCandidate<SvgScene>) => {
    setScene(candidate.document);
  }, []);

  const readSvgDocument = useCallback(async (): Promise<{
    content: string;
    version: string | null;
    asset: boolean;
  }> => {
    if (!client || !relativePath) throw new Error('No file selected');
    try {
      const doc = await client.readDocument(relativePath);
      return { content: serializeScene(parseSvg(doc.content)), version: doc.version, asset: false };
    } catch (docError) {
      try {
        const dataUrl = await client.readAssetDataUrl(relativePath);
        return {
          content: serializeScene(parseSvg(decodeDataUrlText(dataUrl))),
          version: null,
          asset: true,
        };
      } catch {
        throw docError;
      }
    }
  }, [client, relativePath]);

  const { controller, snapshot } = useDocumentSessionController<SvgScene>({
    serialize: serializeScene,
    deserialize: parseSvg,
    applyDocument: applySvgDocument,
    read: async () => {
      const loaded = await readSvgDocument();
      if (loaded.asset) return null;
      return { content: loaded.content, version: loaded.version };
    },
    write: async ({ content, expectedVersion, baseContent }) => {
      if (!client || !relativePath || readOnly || assetBacked)
        return { version: expectedVersion ?? '' };
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
    compareVersions: compareDocumentVersions,
    // SVG editing is intentionally manual-save only. The controller still owns
    // dirty/remote/conflict state, but autosave timers are disabled.
    schedule: () => () => {},
  });

  useEffect(() => {
    if (!vault || !relativePath) {
      setScene(null);
      setError('No file selected');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setScene(null);
    setAssetBacked(false);

    // Read as a text document first (the normal path with optimistic locking).
    // Fall back to reading the raw bytes when the file is stored as a binary
    // asset — e.g. a hosted SVG imported as an image before SVGs became text
    // documents — so it still opens for editing (save is then disabled).
    readSvgDocument()
      .then((loaded) => {
        if (cancelled) return;
        setAssetBacked(loaded.asset);
        controller.load(loaded.content, loaded.version, loaded.asset ? 'cache' : 'rest');
      })
      .catch((reason) => {
        if (cancelled) return;
        setScene(null);
        setError(reason instanceof SvgParseError ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [controller, readSvgDocument, relativePath, vault?.path, vault]);

  useEffect(() => {
    if (!relativePath) return;
    if (snapshot.dirty) markDirty(relativePath);
    else if (snapshot.loadedVersion) markSaved(relativePath, `svg:${snapshot.loadedVersion}`);
  }, [markDirty, markSaved, relativePath, snapshot.dirty, snapshot.loadedVersion]);

  const setSceneAndTrack = useCallback(
    (value: SetStateAction<SvgScene | null>) => {
      setScene((current) => {
        const next =
          typeof value === 'function'
            ? (value as (previous: SvgScene | null) => SvgScene | null)(current)
            : value;
        if (next && !readOnly) controller.markLocalChange(next);
        return next;
      });
    },
    [controller, readOnly],
  );

  // Local filesystem watcher: clean SVGs update automatically, dirty SVGs queue
  // the remote version as pending instead of replacing the edited scene.
  useEffect(() => {
    if (!client || !client.capabilities?.filesystemWatch || !relativePath || assetBacked) return;
    let unlisten: (() => void) | undefined;
    listen<{ path: string }>('vault:file-modified', async (event) => {
      if (event.payload?.path !== relativePath) return;
      if (Date.now() - controller.getSnapshot().lastLocalWriteStartedAt < 2000) return;
      await controller.handleExternalMutation('rest');
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, [assetBacked, client, controller, relativePath, vault?.path]);

  // Hosted replica refreshes route through the same safe remote-candidate policy.
  useEffect(() => {
    if (!client || client.kind !== 'hosted' || !relativePath || assetBacked) return;
    return onReplicaMutated(
      async (event) => {
        if (!replicaMutationAffectsPath(event, relativePath)) return;
        await controller.handleExternalMutation('cache');
      },
      { kinds: ['manifest'] },
    );
  }, [assetBacked, client, controller, relativePath]);

  const save = useCallback(async () => {
    if (!vault || !relativePath || !scene || readOnly || snapshot.saving) return;
    if (assetBacked) {
      toast.error(
        'This SVG was imported as an image asset and cannot be saved as a vector document. Re-import it to edit and save it.',
      );
      return;
    }
    try {
      await controller.requestSave('manual');
      const next = controller.getSnapshot();
      if (next.conflicted) {
        toast.error('This SVG changed elsewhere. Review the pending changes before saving again.');
        return;
      }
      if (!next.dirty && next.loadedVersion) markSaved(relativePath, `svg:${next.loadedVersion}`);
      toast.success('SVG saved');
    } catch (reason) {
      toast.error(`Failed to save SVG: ${reason}`);
    }
  }, [assetBacked, controller, markSaved, readOnly, relativePath, scene, snapshot.saving, vault]);

  const loadRemote = useCallback(() => {
    if (snapshot.conflicted) controller.resolveConflict('load-remote');
    else controller.applyRemoteNow();
  }, [controller, snapshot.conflicted]);

  const keepLocal = useCallback(() => {
    if (snapshot.conflicted) controller.resolveConflict('keep-local');
    else controller.discardRemoteCandidate();
  }, [controller, snapshot.conflicted]);

  return {
    scene,
    setScene: setSceneAndTrack,
    loading,
    error,
    dirty: snapshot.dirty,
    saving: snapshot.saving,
    status: snapshot.status,
    readOnly,
    assetBacked,
    save,
    loadRemote,
    keepLocal,
  };
}
