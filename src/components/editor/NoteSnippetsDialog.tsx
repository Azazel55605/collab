import { useEffect, useMemo, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { useVaultStore } from '../../store/vaultStore';
import { useNoteSnippetStore } from '../../store/noteSnippetStore';
import type { NoteSnippetDraft, NoteSnippetScope } from '../../types/noteSnippet';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { cn } from '../../lib/utils';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (body: string) => void;
};

function createEmptyDraft(scope: NoteSnippetScope): NoteSnippetDraft {
  return {
    name: '',
    description: '',
    scope,
    category: '',
    body: '<placeholder:Snippet content><cursor>',
  };
}

export function NoteSnippetsDialog({ open, onOpenChange, onInsert }: Props) {
  const { vault } = useVaultStore();
  const { snippets, loadSnippets, saveSnippet, deleteSnippet, isLoading } = useNoteSnippetStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteSnippetDraft>(createEmptyDraft('vault'));

  useEffect(() => {
    if (!open || !vault) return;
    void loadSnippets(vault.path);
  }, [loadSnippets, open, vault?.path]);

  const selectedSnippet = useMemo(
    () => snippets.find((entry) => entry.id === selectedId) ?? null,
    [selectedId, snippets],
  );

  useEffect(() => {
    if (!selectedSnippet) return;
    setDraft({
      id: selectedSnippet.id,
      name: selectedSnippet.name,
      description: selectedSnippet.description ?? '',
      scope: selectedSnippet.scope,
      category: selectedSnippet.category ?? '',
      body: selectedSnippet.body,
    });
  }, [selectedSnippet?.id]);

  const resetDraft = (scope: NoteSnippetScope = draft.scope) => {
    setSelectedId(null);
    setDraft(createEmptyDraft(scope));
  };

  const handleSave = async () => {
    if (!vault || !draft.name.trim() || !draft.body.trim()) return;
    try {
      const saved = await saveSnippet(vault.path, draft);
      setSelectedId(saved.id);
      setDraft({
        id: saved.id,
        name: saved.name,
        description: saved.description ?? '',
        scope: saved.scope,
        category: saved.category ?? '',
        body: saved.body,
      });
      toast.success(`Saved snippet "${saved.name}"`);
    } catch (error) {
      toast.error(`Failed to save snippet: ${error}`);
    }
  };

  const handleDelete = async () => {
    if (!vault || !selectedSnippet) return;
    try {
      await deleteSnippet(vault.path, selectedSnippet);
      resetDraft(selectedSnippet.scope);
      toast.success(`Deleted snippet "${selectedSnippet.name}"`);
    } catch (error) {
      toast.error(`Failed to delete snippet: ${error}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl h-[78vh] p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle>Note Snippets</DialogTitle>
          <DialogDescription>
            Create reusable markdown snippets with placeholders and insert them into the current note.
          </DialogDescription>
        </DialogHeader>

        <div className="grid h-full min-h-0 grid-cols-[280px,1fr]">
          <div className="border-r border-border/40 p-3 space-y-3 overflow-y-auto">
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => resetDraft(draft.scope)}
            >
              <Plus size={14} className="mr-1" />
              New snippet
            </Button>

            <div className="space-y-2">
              {isLoading ? (
                <div className="text-xs text-muted-foreground">Loading snippets…</div>
              ) : snippets.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border/50 px-3 py-4 text-xs text-muted-foreground">
                  No snippets yet. Create one on the right.
                </div>
              ) : (
                snippets.map((snippet) => (
                  <div
                    key={snippet.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(snippet.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedId(snippet.id);
                      }
                    }}
                    className={cn(
                      'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                      selectedId === snippet.id
                        ? 'border-primary/50 bg-primary/10'
                        : 'border-border/40 hover:bg-accent/40',
                    )}
                  >
                    <div className="text-sm font-medium text-foreground">{snippet.name}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {snippet.scope === 'vault' ? 'Vault' : 'App'}
                      {snippet.category ? ` · ${snippet.category}` : ''}
                    </div>
                    {snippet.description && (
                      <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground/85">{snippet.description}</div>
                    )}
                    <div className="mt-2 flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px]"
                        onClick={(event) => {
                          event.stopPropagation();
                          onInsert(snippet.body);
                          onOpenChange(false);
                        }}
                      >
                        Insert
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Name</span>
                <Input
                  value={draft.name}
                  onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
                  placeholder="Meeting notes"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Category</span>
                <Input
                  value={draft.category ?? ''}
                  onChange={(event) => setDraft((value) => ({ ...value, category: event.target.value }))}
                  placeholder="Notes"
                />
              </label>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-[1fr,220px]">
              <label className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Description</span>
                <Input
                  value={draft.description ?? ''}
                  onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))}
                  placeholder="Reusable notes for recurring meetings"
                />
              </label>

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted-foreground">Scope</span>
                <div className="flex gap-2">
                  {(['vault', 'app'] as const).map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      onClick={() => setDraft((value) => ({ ...value, scope }))}
                      className={cn(
                        'rounded-lg border px-3 py-2 text-xs font-medium transition-colors',
                        draft.scope === scope
                          ? 'border-primary/50 bg-primary/10 text-primary'
                          : 'border-border/40 text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                      )}
                    >
                      {scope === 'vault' ? 'Vault' : 'App'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <label className="mt-4 flex min-h-0 flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Body
              </span>
              <Textarea
                value={draft.body}
                onChange={(event) => setDraft((value) => ({ ...value, body: event.target.value }))}
                className="min-h-0 flex-1 font-mono text-xs"
                placeholder="<placeholder:Title>\n<cursor>"
              />
              <div className="text-[11px] text-muted-foreground">
                Use <code>&lt;placeholder:Label&gt;</code> for editable fields and <code>&lt;cursor&gt;</code> for the final cursor position.
              </div>
            </label>

            <DialogFooter className="mt-4 border-none bg-transparent px-0 pb-0">
              <div className="mr-auto flex gap-2">
                <Button type="button" variant="outline" onClick={() => onInsert(draft.body)} disabled={!draft.body.trim()}>
                  Insert draft
                </Button>
                {selectedSnippet && (
                  <Button type="button" variant="destructive" onClick={handleDelete}>
                    <Trash2 size={14} className="mr-1" />
                    Delete
                  </Button>
                )}
              </div>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button type="button" onClick={handleSave} disabled={!draft.name.trim() || !draft.body.trim()}>
                <Save size={14} className="mr-1" />
                Save snippet
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
