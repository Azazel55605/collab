import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listen } from '@tauri-apps/api/event';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { yCollab } from 'y-codemirror.next';

import LivePeers from '../components/collaboration/LivePeers';
import { EditorToolbar } from '../components/editor/EditorToolbar';
import { MarkdownEditor, type MarkdownEditorHandle } from '../components/editor/MarkdownEditor';
import { ReadOnlyBanner } from '../components/layout/ReadOnlyBanner';
import { useCollabIdentity } from '../lib/collabIdentity';
import { saveConflictedCopy } from '../lib/conflictedCopy';
import { DOCUMENT_SNAPSHOT_INTERVAL_MS } from '../lib/documentSession';
import {
  compareDocumentVersions,
  type DocumentSessionController,
  type DocumentSessionSnapshot,
  type RemoteCandidate,
  useDocumentSessionController,
} from '../lib/documentSessionController';
import { addTagToContent, ensureTagsLine, setTagsInContent } from '../lib/frontmatter';
import { useLivePeers } from '../lib/liveAwareness';
import { type LiveDocumentSession, openLiveNoteSession } from '../lib/liveDocumentSession';
import { findSearchJumpRange } from '../lib/searchNavigation';
import { mergeText } from '../lib/textMerge';
import { useLiveDocumentStatus } from '../lib/useLiveDocumentStatus';
import { createVaultClient } from '../lib/vaultClient';
import { onReplicaMutated, replicaMutationAffectsPath } from '../lib/vaultReplica';
import { extractHttpUrls, prefetchWebPreviews } from '../lib/webPreviewCache';
import { useDocumentStatusRegistration } from '../store/documentStatusStore';
import { useEditorStore } from '../store/editorStore';
import type { NoteEditorViewState } from '../store/editorStore';
import { useNoteSnippetStore } from '../store/noteSnippetStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';
import { isVaultReadOnly } from '../types/vault';

function extractFirstH1(content: string): string | null {
  for (const line of content.split('\n')) {
    if (line.startsWith('# ')) {
      const heading = line.slice(2).trim();
      return heading || null;
    }
  }
  return null;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export default function NoteView({ relativePath }: { relativePath: string }) {
  const { vault, refreshFileTree } = useVaultStore();
  const markDirty = useEditorStore((state) => state.markDirty);
  const markSaved = useEditorStore((state) => state.markSaved);
  const setSavedHash = useEditorStore((state) => state.setSavedHash);
  const renameTab = useEditorStore((state) => state.renameTab);
  const forceReloadPath = useEditorStore((state) => state.forceReloadPath);
  const setForceReloadPath = useEditorStore((state) => state.setForceReloadPath);
  const revealEditorPath = useEditorStore((state) => state.revealEditorPath);
  const setRevealEditorPath = useEditorStore((state) => state.setRevealEditorPath);
  const pendingSearchJump = useEditorStore((state) => state.pendingSearchJump);
  const setPendingSearchJump = useEditorStore((state) => state.setPendingSearchJump);
  const setNoteViewState = useEditorStore((state) => state.setNoteViewState);
  // Snapshot authorship follows the effective identity: server-authoritative for
  // hosted vaults, local client identity otherwise.
  const { userId: myUserId, userName: myUserName, userColor: myUserColor } = useCollabIdentity();
  const [content, setContent] = useState<string | null>(null);
  const [refreshPulse, setRefreshPulse] = useState(false);
  const { webPreviewsEnabled, hoverWebLinkPreviewsEnabled, backgroundWebPreviewPrefetchEnabled } =
    useUiStore();
  const loadSnippets = useNoteSnippetStore((state) => state.loadSnippets);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const refreshPulseTimerRef = useRef<number | null>(null);
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  const liveVaultKey =
    vault?.kind === 'hosted' ? `${vault.serverUrl}::${vault.hostedVaultId}` : null;
  const liveClient = useMemo(
    () => (vault?.kind === 'hosted' ? createVaultClient(vault) : null),
    [liveVaultKey],
  );
  const readOnly = isVaultReadOnly(vault);
  // Live co-editing session for hosted notes. When present, the Yjs document
  // drives the editor and the server persists edits; the REST autosave path is
  // disabled. When null (local vaults, or the live socket is unreachable), the
  // existing REST optimistic-write path is used.
  const [liveSession, setLiveSession] = useState<LiveDocumentSession | null>(null);
  const collabExtension = useMemo(
    () => (liveSession ? yCollab(liveSession.text, liveSession.awareness) : null),
    [liveSession],
  );
  // Live co-editors of this note (remote awareness peers). Remote cursors/
  // selections already render inline via `yCollab`; this surfaces who is here.
  const livePeers = useLivePeers(liveSession);
  const initialViewState = useMemo<NoteEditorViewState | null>(
    () => useEditorStore.getState().noteViewStates[relativePath] ?? null,
    [relativePath],
  );

  // Periodic collaboration snapshot throttle (manual saves only).
  const lastSnapshotHashRef = useRef<string | null>(null);
  const lastSnapshotTimeRef = useRef(0);
  const shouldCreateSnapshot = (hash: string, now = Date.now()) => {
    if (hash === lastSnapshotHashRef.current) return false;
    if (now - lastSnapshotTimeRef.current < DOCUMENT_SNAPSHOT_INTERVAL_MS) return false;
    lastSnapshotHashRef.current = hash;
    lastSnapshotTimeRef.current = now;
    return true;
  };

  // After a successful save, rename the file to follow the note's first H1 (the
  // title-derived move). Best-effort; a name collision is silently ignored.
  const maybeRenameFromH1 = async (savedContent: string) => {
    if (!client) return;
    const h1 = extractFirstH1(savedContent);
    if (!h1) return;
    const sanitized = sanitizeFilename(h1);
    const parts = relativePath.split('/');
    const currentStem = parts[parts.length - 1].replace(/\.md$/, '');
    if (!sanitized || sanitized === currentStem) return;
    parts[parts.length - 1] = `${sanitized}.md`;
    const newPath = parts.join('/');
    try {
      await client.renameMove(relativePath, newPath);
      renameTab(relativePath, newPath, sanitized);
      await refreshFileTree();
    } catch {
      // Likely a name collision with an existing file — keep the current name.
    }
  };

  // Push an adopted document (initial load, safe remote apply, or backend merge)
  // into the editor and republish the saved version to the tab session.
  const applyNoteDocument = (candidate: RemoteCandidate<string>) => {
    setContent(candidate.content);
    setSavedHash(relativePath, candidate.version ?? '');
  };

  // The shared document session controller owns version/dirty/save/remote/
  // conflict state for the REST fallback path. When a live Yjs session is
  // active, `isLive` disables REST autosave and remote reloads for this note.
  const { controller, snapshot } = useDocumentSessionController<string>({
    serialize: (value) => value,
    deserialize: (value) => value,
    applyDocument: applyNoteDocument,
    read: async () => {
      if (!client) return null;
      const doc = await client.readDocument(relativePath);
      return {
        content: doc.content,
        version: doc.version,
        source: doc.source && doc.source !== 'network' ? 'cache' : 'rest',
      };
    },
    write: async ({ content: toWrite, expectedVersion, baseContent }) => {
      // Viewers have no write access; never attempt a save the server would reject.
      if (!client || readOnly) return { version: expectedVersion ?? '' };
      const result = await client.writeDocument(
        relativePath,
        toWrite,
        expectedVersion ?? undefined,
        baseContent,
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
          conflict: { theirContent: result.conflict.theirContent, baseContent, theirVersion },
        };
      }
      if (result.offlineQueued) return { version: result.version, offlineQueued: true };
      const savedContent = result.mergedContent ?? toWrite;
      await maybeRenameFromH1(savedContent);
      return { version: result.version, mergedContent: result.mergedContent };
    },
    // Dirty note + clean remote change: attempt a line-based three-way merge so
    // disjoint edits reconcile automatically (mirrors the backend auto-merge).
    // Overlapping edits, or a missing common base, fall back to a pending review.
    mergeRemote: ({ base, local, remote }) => {
      if (base === null) return null;
      const merged = mergeText(base, local, remote);
      return merged === null ? null : { document: merged, content: merged };
    },
    isLive: () => liveSession !== null,
    compareVersions: compareDocumentVersions,
    autosaveDebounceMs: 600,
  });
  useLiveDocumentStatus(controller, liveSession);

  // Initial load: establish the session baseline (force explicit reload policy).
  useEffect(() => {
    if (!client || !relativePath) return;
    let cancelled = false;
    setContent(null);
    client
      .readDocument(relativePath)
      .then((doc) => {
        if (cancelled) return;
        controller.load(doc.content, doc.version, 'rest');
      })
      .catch((e) => {
        if (!cancelled) toast.error('Failed to open note: ' + e);
      });
    return () => {
      cancelled = true;
    };
  }, [client, controller, relativePath, vault?.path]);

  // Open a live collaboration session for hosted notes; fall back to REST when
  // unavailable. The session is torn down when the note or vault changes.
  useEffect(() => {
    if (!liveClient || !relativePath || !liveClient.resolveLiveSession) {
      setLiveSession(null);
      return;
    }
    let cancelled = false;
    let opened: LiveDocumentSession | null = null;
    openLiveNoteSession(liveClient, relativePath)
      .then((session) => {
        if (cancelled) {
          session?.destroy();
          return;
        }
        opened = session;
        setLiveSession(session);
      })
      .catch(() => {
        // Live collaboration is best-effort; the REST path remains available.
      });
    return () => {
      cancelled = true;
      opened?.destroy();
      setLiveSession(null);
    };
  }, [liveClient, relativePath]);

  useEffect(() => {
    if (!liveSession) return;
    liveSession.awareness.setLocalStateField('user', {
      id: myUserId,
      name: myUserName,
      color: myUserColor,
    });
    liveSession.awareness.setLocalStateField('document', {
      kind: 'note',
      relativePath,
    });
  }, [liveSession, myUserColor, myUserId, myUserName, relativePath]);

  useEffect(() => {
    if (!client) return;
    // Vault-scoped snippets are a native-filesystem concept; hosted vaults fall
    // back to app-scoped snippets only.
    void loadSnippets(client.capabilities.nativeFilesystem ? vault?.path : null).catch(() => {
      // Snippets are an optional authoring aid and must never prevent a note
      // from opening when their backing store is unavailable.
    });
  }, [client, loadSnippets, vault?.path]);

  useEffect(() => {
    if (
      !content ||
      !webPreviewsEnabled ||
      !hoverWebLinkPreviewsEnabled ||
      !backgroundWebPreviewPrefetchEnabled
    )
      return;
    const urls = extractHttpUrls(content);
    if (urls.length === 0) return;
    prefetchWebPreviews(urls);
  }, [
    backgroundWebPreviewPrefetchEnabled,
    content,
    hoverWebLinkPreviewsEnabled,
    webPreviewsEnabled,
  ]);

  // Command bar insert events
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text;
      if (text && editorRef.current) editorRef.current.insertSnippet(text);
    };
    window.addEventListener('cmdbar:insert', handler);
    return () => window.removeEventListener('cmdbar:insert', handler);
  }, []);

  // Tag event listeners — fired by TagsPanel, EditorToolbar, and MarkdownEditor context menu
  useEffect(() => {
    const onAddTagsLine = () => {
      applyContentTransform(ensureTagsLine);
    };
    const onAddTag = (e: Event) => {
      const tag = (e as CustomEvent<{ tag: string }>).detail?.tag;
      if (!tag) return;
      applyContentTransform((prev) => addTagToContent(prev, tag));
    };
    const onSetTags = (e: Event) => {
      const tags = (e as CustomEvent<{ tags: string[] }>).detail?.tags;
      if (!tags) return;
      applyContentTransform((prev) => setTagsInContent(prev, tags));
    };
    window.addEventListener('tag:add-tags-line', onAddTagsLine);
    window.addEventListener('tag:add-tag', onAddTag);
    window.addEventListener('tag:set-tags', onSetTags);
    return () => {
      window.removeEventListener('tag:add-tags-line', onAddTagsLine);
      window.removeEventListener('tag:add-tag', onAddTag);
      window.removeEventListener('tag:set-tags', onSetTags);
    };
  }, []);

  // Reload when HistoryPanel restores a snapshot for this file (force explicit
  // reload — a user-initiated restore overrides local state).
  useEffect(() => {
    if (forceReloadPath !== relativePath || !client) return;
    setForceReloadPath(null);
    client
      .readDocument(relativePath)
      .then((doc) => controller.load(doc.content, doc.version, 'rest'))
      .catch((e) => toast.error('Failed to reload note: ' + e));
  }, [client, controller, forceReloadPath, relativePath, setForceReloadPath]);

  useEffect(() => {
    if (revealEditorPath !== relativePath || content === null) return;
    const frame = window.requestAnimationFrame(() => {
      editorRef.current?.moveCursorToEnd();
      setRevealEditorPath(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [content, relativePath, revealEditorPath, setRevealEditorPath]);

  useEffect(() => {
    if (pendingSearchJump?.relativePath !== relativePath || content === null) return;
    const frame = window.requestAnimationFrame(() => {
      const range = findSearchJumpRange(content, pendingSearchJump.query);
      if (range) editorRef.current?.revealRange(range.from, range.to);
      else editorRef.current?.revealRange(0, 0);
      setPendingSearchJump(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [content, pendingSearchJump, relativePath, setPendingSearchJump]);

  const pulseRefresh = () => {
    setRefreshPulse(true);
    if (refreshPulseTimerRef.current !== null) window.clearTimeout(refreshPulseTimerRef.current);
    refreshPulseTimerRef.current = window.setTimeout(() => setRefreshPulse(false), 420);
  };

  // Local filesystem watcher: another writer changed this file. The controller
  // auto-applies when clean, queues when dirty, and ignores our own echo/stale.
  useEffect(() => {
    if (!client || !client.capabilities.filesystemWatch) return;
    const unlisten = listen<{ path: string }>('vault:file-modified', async (event) => {
      if (event.payload?.path !== relativePath) return;
      if (Date.now() - controller.getSnapshot().lastLocalWriteStartedAt < 2000) return;
      const decision = await controller.handleExternalMutation('rest');
      if (decision === 'applied') pulseRefresh();
    });
    return () => {
      unlisten.then((u) => u());
    };
  }, [client, controller, relativePath, vault?.path]);

  // Hosted replica refresh: route through the same safe remote policy.
  useEffect(() => {
    if (!client || client.kind !== 'hosted') return;
    return onReplicaMutated(
      async (event) => {
        if (!replicaMutationAffectsPath(event, relativePath)) return;
        const decision = await controller.handleExternalMutation('cache');
        if (decision === 'applied') pulseRefresh();
      },
      { kinds: ['manifest'] },
    );
  }, [client, controller, relativePath]);

  useEffect(
    () => () => {
      if (refreshPulseTimerRef.current !== null) window.clearTimeout(refreshPulseTimerRef.current);
    },
    [],
  );

  // Bridge the controller's dirty/version state to the tab dirty indicator.
  // Live edits do not mark the tab dirty (the CRDT relay persists them).
  useEffect(() => {
    if (liveSession) return;
    if (snapshot.dirty) markDirty(relativePath);
    else if (snapshot.loadedVersion) markSaved(relativePath, snapshot.loadedVersion);
  }, [liveSession, markDirty, markSaved, relativePath, snapshot.dirty, snapshot.loadedVersion]);

  const handleChange = (newContent: string) => {
    setContent(newContent);
    // In a live session the server persists edits via the CRDT relay; there is
    // no local dirty/REST-save bookkeeping. Otherwise route the edit through the
    // controller, which debounces the autosave and serializes writes. A remote
    // apply echoes back through here too, but equals the just-saved content, so
    // the controller correctly treats it as not dirty.
    if (liveSession || readOnly) return;
    controller.markLocalChange(newContent);
  };

  const applyContentTransform = (transform: (value: string) => string) => {
    if (readOnly) return;
    setContent((prev) => {
      if (prev === null) return prev;
      return transform(prev);
    });
  };

  // Manual save (Ctrl/Cmd-S). Serialized through the controller; creates a
  // periodic collaboration snapshot on a successful, non-conflicting write.
  const handleManualSave = async () => {
    if (!client || readOnly || liveSession) return;
    await controller.requestSave('manual');
    const snap = controller.getSnapshot();
    if (
      !snap.conflicted &&
      !snap.offlineQueued &&
      snap.loadedVersion &&
      shouldCreateSnapshot(snap.loadedVersion)
    ) {
      client
        .createSnapshot(relativePath, snap.lastSavedContent ?? '', myUserId, myUserName)
        .catch(() => {});
    }
  };

  const handleSaveAsNew = useCallback(
    async (localContent: string) => {
      if (!client) return;
      await saveConflictedCopy(client, relativePath, localContent);
    },
    [client, relativePath],
  );

  const documentStatus = useMemo(
    () =>
      content !== null
        ? {
            status: snapshot.status,
            controller: controller as DocumentSessionController<unknown>,
            snapshot: snapshot as DocumentSessionSnapshot<unknown>,
            onSaveAsNew: handleSaveAsNew,
            readOnly,
          }
        : null,
    [content, controller, handleSaveAsNew, readOnly, snapshot],
  );
  useDocumentStatusRegistration(relativePath, documentStatus);

  if (content === null && !liveSession) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={16} className="animate-spin" />
        Loading note…
      </div>
    );
  }

  // In a live session the Yjs document is the source of truth for editor content;
  // it seeds the initial doc and is then synced by the CRDT binding.
  const editorContent = liveSession ? liveSession.text.toString() : (content ?? '');

  return (
    <div
      className={`flex flex-col h-full overflow-hidden app-document-ready ${refreshPulse ? 'app-refresh-pulse' : ''}`}
    >
      {readOnly ? (
        <ReadOnlyBanner />
      ) : (
        <EditorToolbar
          relativePath={relativePath}
          editorRef={editorRef}
          documentStatus={snapshot.status}
        />
      )}
      {/* position:relative establishes the containing block for the absolutely-positioned
          CodeMirror container. This avoids flex % height resolution bugs in WebKitGTK
          where height:100% on a flex-1 child resolves to 0 (the flex-basis) rather than
          the final flex-grown height, which shifts getBoundingClientRect().top to 0 and
          causes posAtCoords() to be offset by exactly the toolbar height. */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <div className="absolute top-2 right-3 z-10 flex items-center gap-2">
          {livePeers.length > 0 && (
            <div className="rounded-full bg-card/80 backdrop-blur px-2 py-1 shadow-sm border border-border">
              <LivePeers peers={livePeers} />
            </div>
          )}
        </div>
        <MarkdownEditor
          ref={editorRef}
          content={editorContent}
          onChange={handleChange}
          onSave={handleManualSave}
          readOnly={readOnly}
          collabExtension={collabExtension}
          relativePath={relativePath}
          initialViewState={
            revealEditorPath === relativePath || pendingSearchJump?.relativePath === relativePath
              ? null
              : initialViewState
          }
          onViewStateChange={(viewState) => setNoteViewState(relativePath, viewState)}
        />
      </div>
    </div>
  );
}
