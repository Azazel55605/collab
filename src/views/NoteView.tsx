import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useVaultStore } from '../store/vaultStore';
import { useEditorStore } from '../store/editorStore';
import { useCollabStore } from '../store/collabStore';
import { tauriCommands } from '../lib/tauri';
import { MarkdownEditor, type MarkdownEditorHandle } from '../components/editor/MarkdownEditor';
import { EditorToolbar } from '../components/editor/EditorToolbar';
import { toast } from 'sonner';
import { ensureTagsLine, addTagToContent, setTagsInContent } from '../lib/frontmatter';

const SNAPSHOT_INTERVAL_MS = 60_000;

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
  const { markDirty, markSaved, setSavedHash, renameTab, forceReloadPath, setForceReloadPath } = useEditorStore();
  const { addConflict, myUserId, myUserName } = useCollabStore();
  const [content, setContent] = useState<string | null>(null);
  const savedHashRef = useRef<string | null>(null);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const lastSnapshotHashRef = useRef<string | null>(null);
  const lastSnapshotTimeRef = useRef<number>(0);

  const loadNote = () => {
    if (!vault || !relativePath) return;
    setContent(null);
    tauriCommands.readNote(vault.path, relativePath)
      .then((nc) => {
        setContent(nc.content);
        savedHashRef.current = nc.hash;
        setSavedHash(relativePath, nc.hash);
      })
      .catch((e) => toast.error('Failed to open note: ' + e));
  };

  useEffect(() => { loadNote(); }, [relativePath, vault?.path]);

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
      setContent((prev) => {
        if (prev === null) return prev;
        return ensureTagsLine(prev);
      });
    };
    const onAddTag = (e: Event) => {
      const tag = (e as CustomEvent<{ tag: string }>).detail?.tag;
      if (!tag) return;
      setContent((prev) => {
        if (prev === null) return prev;
        return addTagToContent(prev, tag);
      });
    };
    const onSetTags = (e: Event) => {
      const tags = (e as CustomEvent<{ tags: string[] }>).detail?.tags;
      if (!tags) return;
      setContent((prev) => {
        if (prev === null) return prev;
        return setTagsInContent(prev, tags);
      });
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

  // Reload when HistoryPanel restores a snapshot for this file
  useEffect(() => {
    if (forceReloadPath === relativePath) {
      setForceReloadPath(null);
      loadNote();
    }
  }, [forceReloadPath]);

  // Auto-reload when another user edits the same file (no local dirty changes)
  const isDirtyRef = useRef(false);
  useEffect(() => {
    if (!vault) return;
    const unlisten = listen<{ path: string }>('vault:file-modified', async (event) => {
      const changedPath = event.payload?.path;
      if (changedPath !== relativePath) return;
      // Don't overwrite local unsaved changes — let the conflict dialog handle it
      if (isDirtyRef.current) return;
      try {
        const nc = await tauriCommands.readNote(vault.path, relativePath);
        // Only reload if disk content actually changed vs what we last saved
        if (nc.hash !== savedHashRef.current) {
          setContent(nc.content);
          savedHashRef.current = nc.hash;
          setSavedHash(relativePath, nc.hash);
        }
      } catch {}
    });
    return () => { unlisten.then((u) => u()); };
  }, [relativePath, vault?.path]);

  const handleChange = (newContent: string) => {
    setContent(newContent);
    isDirtyRef.current = true;
    markDirty(relativePath);
  };

  // Autosave 600 ms after the last keystroke
  useEffect(() => {
    if (content === null) return;
    const t = setTimeout(() => { handleSave(content); }, 600);
    return () => clearTimeout(t);
  }, [content]);

  const handleSave = async (newContent: string, manual = false) => {
    if (!vault) return;
    try {
      const result = await tauriCommands.writeNote(
        vault.path,
        relativePath,
        newContent,
        savedHashRef.current ?? undefined,
      );
      if (result.conflict) {
        addConflict({ ...result.conflict, ourContent: newContent });
        return;
      }

      savedHashRef.current = result.hash;
      isDirtyRef.current = false;
      markSaved(relativePath, result.hash);

      // Create a snapshot on manual saves if content changed and interval has passed
      if (manual) {
        const now = Date.now();
        if (
          result.hash !== lastSnapshotHashRef.current &&
          now - lastSnapshotTimeRef.current >= SNAPSHOT_INTERVAL_MS
        ) {
          lastSnapshotHashRef.current = result.hash;
          lastSnapshotTimeRef.current = now;
          tauriCommands.createSnapshot(vault.path, relativePath, newContent, myUserId, myUserName)
            .catch(() => {});
        }
      }

      // Auto-rename: keep filename in sync with the first H1 heading
      const h1 = extractFirstH1(newContent);
      if (h1) {
        const sanitized = sanitizeFilename(h1);
        const parts = relativePath.split('/');
        const currentStem = parts[parts.length - 1].replace(/\.md$/, '');
        if (sanitized && sanitized !== currentStem) {
          parts[parts.length - 1] = sanitized + '.md';
          const newPath = parts.join('/');
          try {
            await tauriCommands.renameNote(vault.path, relativePath, newPath);
            renameTab(relativePath, newPath, sanitized);
            await refreshFileTree();
          } catch {
            // Silently ignore — likely a name collision with an existing file
          }
        }
      }
    } catch (e) {
      toast.error('Failed to save: ' + e);
    }
  };

  if (content === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <EditorToolbar relativePath={relativePath} editorRef={editorRef} />
      {/* position:relative establishes the containing block for the absolutely-positioned
          CodeMirror container. This avoids flex % height resolution bugs in WebKitGTK
          where height:100% on a flex-1 child resolves to 0 (the flex-basis) rather than
          the final flex-grown height, which shifts getBoundingClientRect().top to 0 and
          causes posAtCoords() to be offset by exactly the toolbar height. */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <MarkdownEditor
          ref={editorRef}
          content={content}
          onChange={handleChange}
          onSave={(c) => handleSave(c, true)}
          relativePath={relativePath}
        />
      </div>
    </div>
  );
}
