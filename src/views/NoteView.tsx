import { useEffect, useRef, useState } from 'react';
import { useVaultStore } from '../store/vaultStore';
import { useEditorStore } from '../store/editorStore';
import { useCollabStore } from '../store/collabStore';
import { tauriCommands } from '../lib/tauri';
import { MarkdownEditor, type MarkdownEditorHandle } from '../components/editor/MarkdownEditor';
import { EditorToolbar } from '../components/editor/EditorToolbar';
import { toast } from 'sonner';

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
  const { markDirty, markSaved, setSavedHash, renameTab } = useEditorStore();
  const { addConflict } = useCollabStore();
  const [content, setContent] = useState<string | null>(null);
  const savedHashRef = useRef<string | null>(null);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);

  useEffect(() => {
    if (!vault || !relativePath) return;
    setContent(null);
    tauriCommands.readNote(vault.path, relativePath)
      .then((nc) => {
        setContent(nc.content);
        savedHashRef.current = nc.hash;
        setSavedHash(relativePath, nc.hash);
      })
      .catch((e) => toast.error('Failed to open note: ' + e));
  }, [relativePath, vault?.path]);

  const handleChange = (newContent: string) => {
    setContent(newContent);
    markDirty(relativePath);
  };

  // Autosave 600 ms after the last keystroke
  useEffect(() => {
    if (content === null) return;
    const t = setTimeout(() => { handleSave(content); }, 600);
    return () => clearTimeout(t);
  }, [content]);

  const handleSave = async (newContent: string) => {
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
      markSaved(relativePath, result.hash);

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
      <EditorToolbar editorRef={editorRef} />
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
          onSave={handleSave}
          relativePath={relativePath}
        />
      </div>
    </div>
  );
}
