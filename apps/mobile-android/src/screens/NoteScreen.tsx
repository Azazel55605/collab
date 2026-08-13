import { ArrowLeft, CloudOff, Edit3, Eye, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { yCollab } from 'y-codemirror.next';

import { Banner, ReadOnlyBadge, Spinner } from '../components/ui';
import { MobileMarkdownEditor } from '../components/MobileMarkdownEditor';
import { readMobileAssetDataUrl, isRichViewableFile } from '../lib/assets';
import { fileEntryExtension, isReadOnlyRole } from '../lib/format';
import { isLogicFile } from '../lib/logic';
import {
  isExternalHref,
  readNoteDocument,
  renderMarkdownDocument,
  resolveVaultLink,
  saveNoteDocument,
  type RenderedMarkdownDocument,
} from '../lib/notes';
import {
  describePendingFailure,
  discardPendingOperation,
  enqueueNoteEdit,
  isLikelyConnectivityError,
  pendingEditsForFile,
  retryPendingOperation,
} from '../lib/sync';
import {
  replicaCacheDocument,
  type HostedFileEntry,
  type PendingOperation,
} from '../mobileTauri';
import type { ThemePrefs } from '../lib/theme';
import { openMobileLiveNoteSession, type LiveStatus, type MobileLiveNoteSession } from '../lib/liveNote';
import { useMobileStore } from '../state/store';
import { MathPlot2D } from '../../../../src/components/editor/MathPlot2D';
import { MathPlot3D } from '../../../../src/components/editor/MathPlot3D';
import { renderMermaidBlocks } from '../../../../src/lib/mermaidRenderer';

export function NoteScreen({ file, prefs }: { file: HostedFileEntry; prefs: ThemePrefs }) {
  const selected = useMobileStore((s) => s.selected);
  const statuses = useMobileStore((s) => s.statuses);
  const files = useMobileStore((s) => s.files);
  const closeSheet = useMobileStore((s) => s.closeSheet);
  const openSheet = useMobileStore((s) => s.openSheet);
  const replaceFile = useMobileStore((s) => s.replaceFile);
  const enterFolder = useMobileStore((s) => s.enterFolder);
  const syncServer = useMobileStore((s) => s.syncServer);
  const previewRef = useRef<HTMLElement | null>(null);

  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [currentFile, setCurrentFile] = useState(file);
  const [source, setSource] = useState<'network' | 'cache'>('network');
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const screenRef = useRef<HTMLDivElement | null>(null);

  // Leaving edit mode closes the soft keyboard. A WebView may have scrolled
  // `.app-main` to reveal the caret, and that offset would otherwise persist and
  // hide the note header.
  useEffect(() => {
    if (mode === 'edit') return;
    const main = screenRef.current?.closest<HTMLElement>('.app-main');
    if (main && main.scrollTop !== 0) main.scrollTop = 0;
  }, [mode]);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [liveSession, setLiveSession] = useState<MobileLiveNoteSession | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('disconnected');
  const [pending, setPending] = useState<PendingOperation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connected = selected ? !!statuses[selected.serverUrl]?.connected : false;
  const readOnly = selected ? isReadOnlyRole(selected.vault.role) : true;
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const liveSessionRef = useRef<MobileLiveNoteSession | null>(null);
  liveSessionRef.current = liveSession;
  const liveActive = !!liveSession;
  const dirty = !liveActive && content !== savedContent;
  const pendingFailed = pending?.status === 'failed';
  const statusLabel = pendingFailed
    ? 'Sync failed'
    : pending
      ? 'Queued to sync'
      : liveActive
        ? liveStatus === 'connected'
          ? 'Live'
          : 'Live offline'
      : source === 'cache'
        ? 'Cached note'
        : dirty
          ? 'Unsaved changes'
          : 'Saved';
  const [rendered, setRendered] = useState<RenderedMarkdownDocument>({ html: '', plotBlocks: [] });
  const [renderingPreview, setRenderingPreview] = useState(false);
  const collabExtension = useMemo(
    () => (liveSession ? yCollab(liveSession.text, liveSession.awareness) : null),
    [liveSession],
  );

  useEffect(() => {
    if (busy || mode !== 'preview') return;
    let cancelled = false;
    setRenderingPreview(true);
    const timer = window.setTimeout(() => {
      const next = renderMarkdownDocument(content, prefs);
      if (!cancelled) {
        setRendered(next);
        setRenderingPreview(false);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [busy, content, mode, prefs]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!selected) return;
      if (liveSessionRef.current) return;
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const document = await readNoteDocument(selected.serverUrl, selected.vault.id, file, connected);
        if (cancelled) return;
        if (liveSessionRef.current) return;
        setCurrentFile(document.file);
        setContent(document.content);
        setSavedContent(document.content);
        setSource(document.source);
        const queued = await pendingEditsForFile(selected.serverUrl, selected.vault.id, file.id).catch(
          () => [] as PendingOperation[],
        );
        if (!cancelled) setPending(queued[0] ?? null);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // Keyed on the file *id*, not the entry object. Saving calls `replaceFile`,
    // which hands this screen a fresh `HostedFileEntry` for the same document;
    // depending on that identity reloaded the document after every save. A live
    // session masked it, so it only surfaced offline or where live is
    // unavailable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, file.id, selected?.serverUrl, selected?.vault.id]);

  useEffect(() => {
    if (!selected || readOnly || !connectedRef.current) {
      setLiveSession(null);
      setLiveStatus('disconnected');
      return;
    }
    let cancelled = false;
    let session: MobileLiveNoteSession | null = null;
    let cleanupSession: (() => void) | null = null;
    openMobileLiveNoteSession(selected.serverUrl, selected.vault.id, file.id)
      .then((opened) => {
        if (cancelled) {
          opened?.destroy();
          return;
        }
        if (!opened) return;
        session = opened;
        setLiveSession(opened);
        setLiveStatus(opened.getStatus());
        opened.awareness.setLocalStateField('user', {
          id: 'mobile',
          name: 'Mobile',
          color: 'var(--primary)',
        });
        const syncFromText = () => {
          const next = opened.text.toString();
          setContent(next);
          setSavedContent(next);
          void replicaCacheDocument(selected.serverUrl, selected.vault.id, file.id, next).catch(() => {});
        };
        syncFromText();
        opened.text.observe(syncFromText);
        const unsubscribe = opened.onStatus(setLiveStatus);
        cleanupSession = () => {
          opened.text.unobserve(syncFromText);
          unsubscribe();
          opened.destroy();
        };
      })
      .catch(() => {
        // Live collaboration is best-effort. The REST/offline save path remains.
      });
    return () => {
      cancelled = true;
      if (cleanupSession) cleanupSession();
      else session?.destroy();
      setLiveSession(null);
      setLiveStatus('disconnected');
    };
  }, [file.id, readOnly, selected?.serverUrl, selected?.vault.id]);

  const loadImageSource = useCallback(
    async (target: HostedFileEntry): Promise<string | null> => {
      if (!selected) return null;
      const { serverUrl, vault } = selected;
      return readMobileAssetDataUrl({ serverUrl, vaultId: vault.id, file: target, connected })
        .then((result) => result.dataUrl)
        .catch(() => null);
    },
    [connected, selected],
  );

  useEffect(() => {
    const root = previewRef.current;
    if (!root || mode !== 'preview') return;
    let cancelled = false;
    const mermaidJob = renderMermaidBlocks(root);
    const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'));
    for (const image of images) {
      const rawSrc = image.getAttribute('src') ?? '';
      if (!rawSrc || isExternalHref(rawSrc)) continue;
      const target = resolveVaultLink(files, currentFile.relativePath, rawSrc);
      if (!target || (target.kind !== 'asset' && !(target.kind === 'document' && /\.svg$/i.test(target.name)))) {
        image.dataset.missing = 'true';
        continue;
      }
      image.dataset.loading = 'true';
      void loadImageSource(target).then((src) => {
        if (cancelled) return;
        delete image.dataset.loading;
        if (src) image.src = src;
        else image.dataset.missing = 'true';
      });
    }
    return () => {
      cancelled = true;
      mermaidJob.cancel();
    };
    // `busy` is a dependency because the preview `<article>` (and thus
    // `previewRef`) only mounts once loading finishes; without it this effect
    // would run while the ref is still null and never re-run to resolve images.
  }, [
    busy,
    currentFile.relativePath,
    files,
    loadImageSource,
    mode,
    prefs.accent,
    prefs.theme,
    rendered.html,
  ]);

  function handlePreviewClick(event: MouseEvent<HTMLElement>) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const wiki = target.closest<HTMLElement>('.wikilink[data-path]');
    const anchor = target.closest<HTMLAnchorElement>('a[href]');
    const rawHref = wiki?.dataset.path ?? anchor?.getAttribute('href') ?? null;
    if (!rawHref || isExternalHref(rawHref)) return;

    const linkedFile = resolveVaultLink(files, currentFile.relativePath, rawHref);
    if (!linkedFile) {
      event.preventDefault();
      setError(`Could not find "${rawHref}" in this vault.`);
      return;
    }

    event.preventDefault();
    setError(null);
    if (linkedFile.kind === 'folder') {
      enterFolder({ id: linkedFile.id, name: linkedFile.name });
      closeSheet();
    } else if (isLogicFile(linkedFile)) {
      openSheet({ kind: 'viewer', fileId: linkedFile.id });
    } else if (linkedFile.kind === 'document' && ['md', 'markdown'].includes(fileEntryExtension(linkedFile))) {
      openSheet({ kind: 'note', fileId: linkedFile.id });
    } else if (isRichViewableFile(linkedFile)) {
      openSheet({ kind: 'viewer', fileId: linkedFile.id });
    } else {
      openSheet({ kind: 'fileDetail', fileId: linkedFile.id });
    }
  }

  const queueOffline = useCallback(async () => {
    if (!selected) return;
    const operation = await enqueueNoteEdit(
      selected.serverUrl,
      selected.vault.id,
      currentFile,
      content,
      selected.vault.manifestSequence ?? 0,
    );
    setSavedContent(content);
    setSource('cache');
    setPending(operation);
    setMessage('Saved offline. This note will sync when you reconnect.');
  }, [content, currentFile, selected]);

  async function save() {
    if (liveActive) {
      setSavedContent(content);
      setMessage(liveStatus === 'connected' ? 'Synced live.' : 'Saved to the offline live cache.');
      return;
    }
    if (!selected || readOnly || saving || !dirty) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (connected) {
        try {
          const document = await saveNoteDocument(selected.serverUrl, selected.vault.id, currentFile, content);
          setCurrentFile(document.file);
          setSavedContent(document.content);
          replaceFile(document.file);
          setSource('network');
          setPending(null);
          setMessage('Saved.');
          return;
        } catch (reason) {
          // A live write that fails purely for connectivity reasons still queues
          // offline; anything else (e.g. a revision conflict) is a real error.
          if (!isLikelyConnectivityError(reason)) throw reason;
        }
      }
      await queueOffline();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  function handleEditorChange(next: string) {
    setContent(next);
    if (liveSession && selected) {
      setSavedContent(next);
      void replicaCacheDocument(selected.serverUrl, selected.vault.id, currentFile.id, next).catch(() => {});
    }
  }

  async function retrySync() {
    if (!selected || !pending || recovering) return;
    setRecovering(true);
    setError(null);
    setMessage(null);
    try {
      await retryPendingOperation(selected.serverUrl, selected.vault.id, pending.id);
      await syncServer(selected.serverUrl);
      const queued = await pendingEditsForFile(selected.serverUrl, selected.vault.id, currentFile.id);
      setPending(queued[0] ?? null);
      if (queued.length === 0) {
        const document = await readNoteDocument(selected.serverUrl, selected.vault.id, currentFile, connected);
        setCurrentFile(document.file);
        setContent(document.content);
        setSavedContent(document.content);
        setSource(document.source);
        setMessage('Synced.');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRecovering(false);
    }
  }

  async function discardQueued() {
    if (!selected || !pending || recovering) return;
    setRecovering(true);
    setError(null);
    setMessage(null);
    try {
      await discardPendingOperation(selected.serverUrl, selected.vault.id, pending.id);
      setPending(null);
      // Reload the note so it reflects the last server-known content again.
      const document = await readNoteDocument(selected.serverUrl, selected.vault.id, currentFile, connected);
      setCurrentFile(document.file);
      setContent(document.content);
      setSavedContent(document.content);
      setSource(document.source);
      setMessage('Discarded the queued change.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRecovering(false);
    }
  }

  if (!selected) return null;

  return (
    <div className="screen note-screen" ref={screenRef}>
      <header className="note-header">
        <button type="button" className="icon-button" aria-label="Back" onClick={closeSheet}>
          <ArrowLeft size={18} aria-hidden />
        </button>
        <div className="note-title">
          <h1 className="truncate">{currentFile.name}</h1>
          <p>{statusLabel}</p>
        </div>
        <div className="header-side">
          {readOnly ? <ReadOnlyBadge /> : null}
          {!readOnly ? (
            <button
              type="button"
              className="icon-button"
              aria-label={mode === 'preview' ? 'Edit' : 'Preview'}
              onClick={() => setMode((value) => (value === 'preview' ? 'edit' : 'preview'))}
            >
              {mode === 'preview' ? <Edit3 size={17} aria-hidden /> : <Eye size={17} aria-hidden />}
            </button>
          ) : null}
          {!readOnly ? (
            <button
              type="button"
              className="icon-button"
              aria-label="Save"
              disabled={saving || (!dirty && !liveActive)}
              onClick={() => void save()}
            >
              {saving ? <Spinner size={16} /> : <Save size={17} aria-hidden />}
            </button>
          ) : null}
        </div>
      </header>

      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}

      {pendingFailed ? (
        <div className="banner banner-error sync-recovery">
          <div className="sync-recovery-text">
            <strong>Couldn’t sync this note</strong>
            <span>{describePendingFailure(pending!)}</span>
          </div>
          <div className="sync-recovery-actions">
            <button type="button" className="text-button" onClick={() => void retrySync()} disabled={recovering || !connected}>
              {recovering ? <Spinner size={14} /> : <RefreshCw size={14} aria-hidden />}
              Retry
            </button>
            <button type="button" className="text-button destructive" onClick={() => void discardQueued()} disabled={recovering}>
              <Trash2 size={14} aria-hidden />
              Discard
            </button>
          </div>
        </div>
      ) : pending ? (
        <div className="banner banner-info sync-recovery">
          <div className="sync-recovery-text">
            <span className="sync-recovery-badge">
              <CloudOff size={14} aria-hidden />
              Queued offline
            </span>
            <span>
              {connected
                ? 'Syncing this change to the server…'
                : 'This change will sync automatically when you reconnect.'}
            </span>
          </div>
          <div className="sync-recovery-actions">
            {connected ? (
              <button type="button" className="text-button" onClick={() => void retrySync()} disabled={recovering}>
                {recovering ? <Spinner size={14} /> : <RefreshCw size={14} aria-hidden />}
                Sync now
              </button>
            ) : null}
            <button type="button" className="text-button destructive" onClick={() => void discardQueued()} disabled={recovering}>
              <Trash2 size={14} aria-hidden />
              Discard
            </button>
          </div>
        </div>
      ) : source === 'cache' ? (
        <Banner tone="info">Showing cached content. Changes you make will sync when you reconnect.</Banner>
      ) : null}

      {busy || (mode === 'preview' && renderingPreview) ? (
        <div className="loading-block">
          <Spinner size={22} />
          <span>{busy ? 'Loading note...' : 'Rendering preview...'}</span>
        </div>
      ) : mode === 'edit' && !readOnly ? (
          <MobileMarkdownEditor
            value={content}
            prefs={prefs}
            onChange={handleEditorChange}
            onSave={() => void save()}
            collabExtension={collabExtension}
          />
      ) : (
        <>
          <article
            ref={previewRef}
            className="markdown-preview"
            onClick={handlePreviewClick}
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
          {rendered.plotBlocks.length > 0 ? (
            <div className="markdown-preview-plots">
              {rendered.plotBlocks.map((parsed, blockIndex) => (
                <div key={blockIndex} className="math-plot-stack">
                  {parsed.errors.map((plotError, errorIndex) => (
                    <div key={`error-${errorIndex}`} className="plot-error">
                      {plotError}
                    </div>
                  ))}
                  {parsed.plots.map((plot, plotIndex) =>
                    plot.kind === '2d' ? (
                      <MathPlot2D key={`plot-${plotIndex}`} spec={plot} />
                    ) : (
                      <MathPlot3D key={`plot-${plotIndex}`} spec={plot} />
                    ),
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
