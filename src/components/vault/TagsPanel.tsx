import { useState, useCallback } from 'react';
import { Plus, X, ChevronRight, ChevronDown, Check, Tag } from 'lucide-react';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import { tauriCommands } from '../../lib/tauri';
import { addTagToContent, removeTagFromContent, getTagsFromContent } from '../../lib/frontmatter';
import { Input } from '../ui/input';
import { toast } from 'sonner';
import type { NoteMetadata } from '../../types/note';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Mutate tags on a note that is NOT the active editor tab (read → write via IPC). */
async function patchNoteTag(
  vaultPath: string,
  note: NoteMetadata,
  action: 'add' | 'remove',
  tag: string,
  updateNote: (path: string, meta: NoteMetadata) => void,
): Promise<void> {
  const nc = await tauriCommands.readNote(vaultPath, note.relativePath);
  const patched =
    action === 'add'
      ? addTagToContent(nc.content, tag)
      : removeTagFromContent(nc.content, tag);
  const result = await tauriCommands.writeNote(vaultPath, note.relativePath, patched, nc.hash);
  if (result.conflict) {
    toast.error(`Conflict saving ${note.title} — please reload it.`);
    return;
  }
  const newTags = getTagsFromContent(patched);
  updateNote(note.relativePath, { ...note, tags: newTags, hash: result.hash });
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function TagsPanel() {
  const { notes, updateNote } = useNoteIndexStore();
  const { openTab, activeTabPath } = useEditorStore();
  const { setActiveView } = useUiStore();
  const { vault } = useVaultStore();

  const [filter, setFilter] = useState('');
  const [newTag, setNewTag] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null); // tag+path key to prevent double-clicks

  // Build tag → notes map
  const tagMap = new Map<string, NoteMetadata[]>();
  for (const note of notes) {
    for (const tag of note.tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(note);
    }
  }

  // Filter + sort by count descending
  const q = filter.toLowerCase().trim();
  const tags = [...tagMap.entries()]
    .filter(([tag]) => !q || tag.toLowerCase().includes(q))
    .sort((a, b) => b[1].length - a[1].length);

  const activeNote = notes.find((n) => n.relativePath === activeTabPath);

  // Toggle tag expansion
  const toggle = (tag: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(tag) ? next.delete(tag) : next.add(tag);
      return next;
    });

  // Add a tag to the current active note
  const addTagToActive = useCallback((tag: string) => {
    if (!tag.trim()) return;
    window.dispatchEvent(new CustomEvent('tag:add-tag', { detail: { tag: tag.trim() } }));
  }, []);

  // Add new tag from input field
  const handleNewTag = useCallback(() => {
    const t = newTag.trim();
    if (!t) return;
    addTagToActive(t);
    setNewTag('');
  }, [newTag, addTagToActive]);

  // Add/remove tag on a specific (possibly non-active) note
  const handleTagOnNote = useCallback(async (
    note: NoteMetadata,
    tag: string,
    action: 'add' | 'remove',
  ) => {
    if (!vault) return;
    const key = `${action}:${tag}:${note.relativePath}`;
    if (busy === key) return;

    if (note.relativePath === activeTabPath) {
      // Active note — use the CustomEvent so NoteView handles it (avoids hash conflicts)
      if (action === 'add') {
        window.dispatchEvent(new CustomEvent('tag:add-tag', { detail: { tag } }));
      } else {
        const currentTags = activeNote?.tags ?? [];
        window.dispatchEvent(new CustomEvent('tag:set-tags', {
          detail: { tags: currentTags.filter((t) => t !== tag) },
        }));
      }
    } else {
      setBusy(key);
      try {
        await patchNoteTag(vault.path, note, action, tag, updateNote);
      } catch (e) {
        toast.error('Failed to update tags: ' + e);
      } finally {
        setBusy(null);
      }
    }
  }, [vault, activeTabPath, activeNote, busy, updateNote]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header: filter + new tag input ── */}
      <div className="flex flex-col gap-1.5 p-2 border-b border-border/50">
        <Input
          placeholder="Filter tags…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="h-7 text-xs"
        />
        <div className="flex gap-1">
          <Input
            placeholder="Add tag to current note…"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleNewTag()}
            className="h-7 text-xs flex-1"
            disabled={!activeTabPath}
          />
          <button
            onClick={handleNewTag}
            disabled={!newTag.trim() || !activeTabPath}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40 transition-colors"
            title="Add tag to current note"
          >
            <Plus size={12} />
          </button>
        </div>
      </div>

      {/* ── Tag list ── */}
      <div className="flex-1 overflow-y-auto p-1">
        {tags.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
            <Tag size={20} className="opacity-40" />
            <p className="text-xs text-center">
              {q ? `No tags matching "${filter}"` : 'No tags found'}
            </p>
          </div>
        )}

        {tags.map(([tag, tagNotes]) => {
          const isOpen = expanded.has(tag);
          const activeAlreadyHas = activeNote?.tags.includes(tag) ?? false;

          return (
            <div key={tag} className="mb-0.5">
              {/* Tag row */}
              <div className="group flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent/50">
                {/* Expand/collapse toggle */}
                <button
                  onClick={() => toggle(tag)}
                  className="flex flex-1 items-center gap-1 min-w-0 text-left"
                >
                  {isOpen
                    ? <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
                    : <ChevronRight size={12} className="shrink-0 text-muted-foreground" />
                  }
                  <span className="text-xs font-medium truncate">#{tag}</span>
                  <span className="ml-1 text-[10px] text-muted-foreground shrink-0">{tagNotes.length}</span>
                </button>

                {/* Add to current note button */}
                {activeTabPath && (
                  <button
                    onClick={() => handleTagOnNote(activeNote ?? tagNotes[0], tag, activeAlreadyHas ? 'remove' : 'add')}
                    title={activeAlreadyHas ? 'Remove from current note' : 'Add to current note'}
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors opacity-0 group-hover:opacity-100 ${
                      activeAlreadyHas
                        ? 'text-primary hover:bg-primary/10'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }`}
                    disabled={!activeNote && !activeAlreadyHas}
                  >
                    {activeAlreadyHas ? <Check size={11} /> : <Plus size={11} />}
                  </button>
                )}
              </div>

              {/* Note list under tag */}
              {isOpen && (
                <div className="ml-4 mb-1">
                  {tagNotes.map((note) => (
                    <div
                      key={note.relativePath}
                      className="group/note flex items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent/30"
                    >
                      <button
                        className="flex-1 truncate text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => {
                          openTab(note.relativePath, note.title, 'note');
                          setActiveView('editor');
                        }}
                      >
                        {note.title}
                      </button>
                      <button
                        onClick={() => handleTagOnNote(note, tag, 'remove')}
                        title={`Remove #${tag} from this note`}
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 group-hover/note:opacity-100 hover:bg-destructive/15 hover:text-destructive transition-colors"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
