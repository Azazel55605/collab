import { useEffect, useMemo, useState } from 'react';

import { Save, Scissors, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { createVaultClient } from '../../lib/vaultClient';
import { useNoteSnippetStore } from '../../store/noteSnippetStore';
import { useVaultStore } from '../../store/vaultStore';
import type { NoteSnippet, NoteSnippetDraft, NoteSnippetScope } from '../../types/noteSnippet';
import { ChoiceCard, ChoiceGroup } from '../ui/app-dialog';
import { Button } from '../ui/button';
import { FormField, FormRow } from '../ui/form-dialog';
import { Input } from '../ui/input';
import { ListDetailDialog, ListDetailRow, useKeepSelection } from '../ui/list-detail-dialog';
import { Textarea } from '../ui/textarea';

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

function toDraft(snippet: NoteSnippet): NoteSnippetDraft {
  return {
    id: snippet.id,
    name: snippet.name,
    description: snippet.description ?? '',
    scope: snippet.scope,
    category: snippet.category ?? '',
    body: snippet.body,
  };
}

export function NoteSnippetsDialog({ open, onOpenChange, onInsert }: Props) {
  const { vault } = useVaultStore();
  // Vault-scoped snippets live on the local filesystem; hosted vaults only have
  // app-scoped snippets (a null vault path targets app scope).
  const supportsLocalSnippets = vault
    ? createVaultClient(vault).capabilities.nativeFilesystem
    : false;
  const snippetVaultPath = supportsLocalSnippets && vault ? vault.path : null;
  const { snippets, loadSnippets, saveSnippet, deleteSnippet, isLoading } = useNoteSnippetStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<NoteSnippetDraft>(
    createEmptyDraft(supportsLocalSnippets ? 'vault' : 'app'),
  );
  const scopeOptions: NoteSnippetScope[] = supportsLocalSnippets ? ['vault', 'app'] : ['app'];

  useEffect(() => {
    if (!open || !vault) return;
    void loadSnippets(snippetVaultPath);
  }, [loadSnippets, open, snippetVaultPath, vault]);

  const needle = query.trim().toLowerCase();
  const shown = useMemo(
    () =>
      needle
        ? snippets.filter((entry) =>
            [entry.name, entry.category, entry.description]
              .join(' ')
              .toLowerCase()
              .includes(needle),
          )
        : snippets,
    [needle, snippets],
  );
  useKeepSelection(shown, (entry) => entry.id, selectedId, setSelectedId, open && !creating);
  const selectedSnippet = useMemo(
    () => snippets.find((entry) => entry.id === selectedId) ?? null,
    [selectedId, snippets],
  );

  useEffect(() => {
    if (selectedSnippet) setDraft(toDraft(selectedSnippet));
  }, [selectedSnippet?.id]);

  const startNew = () => {
    setCreating(true);
    setSelectedId(null);
    setDraft(createEmptyDraft(draft.scope));
  };

  const handleSave = async () => {
    if (!vault || !draft.name.trim() || !draft.body.trim()) return;
    const effectiveDraft = supportsLocalSnippets ? draft : { ...draft, scope: 'app' as const };
    try {
      const saved = await saveSnippet(snippetVaultPath, effectiveDraft);
      setCreating(false);
      setSelectedId(saved.id);
      setDraft(toDraft(saved));
      toast.success(`Saved snippet "${saved.name}"`);
    } catch (error) {
      toast.error(`Failed to save snippet: ${error}`);
    }
  };

  const handleDelete = async () => {
    if (!vault || !selectedSnippet) return;
    try {
      await deleteSnippet(snippetVaultPath, selectedSnippet);
      setSelectedId(null);
      toast.success(`Deleted snippet "${selectedSnippet.name}"`);
    } catch (error) {
      toast.error(`Failed to delete snippet: ${error}`);
    }
  };

  const insert = () => {
    onInsert(draft.body);
    onOpenChange(false);
  };

  const editor = (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <FormRow>
        <FormField label="Name" htmlFor="snippet-name">
          <Input
            id="snippet-name"
            value={draft.name}
            onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
            placeholder="Meeting notes"
          />
        </FormField>
        <FormField label="Category" htmlFor="snippet-category">
          <Input
            id="snippet-category"
            value={draft.category ?? ''}
            onChange={(event) => setDraft((value) => ({ ...value, category: event.target.value }))}
            placeholder="Notes"
          />
        </FormField>
      </FormRow>
      <FormField label="Description" htmlFor="snippet-description">
        <Input
          id="snippet-description"
          value={draft.description ?? ''}
          onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))}
          placeholder="Reusable notes for recurring meetings"
        />
      </FormField>
      {scopeOptions.length > 1 && (
        <FormField label="Saved in">
          <ChoiceGroup
            value={draft.scope}
            onValueChange={(scope) =>
              setDraft((value) => ({ ...value, scope: scope as NoteSnippetScope }))
            }
            aria-label="Saved in"
            className="grid grid-cols-2 gap-2"
          >
            <ChoiceCard value="vault" title="This vault" description="Shared with everyone here" />
            <ChoiceCard value="app" title="This app" description="Yours, in every vault" />
          </ChoiceGroup>
        </FormField>
      )}
      <FormField
        label="Body"
        htmlFor="snippet-body"
        hint={
          <>
            <code>&lt;placeholder:Label&gt;</code> marks an editable field,{' '}
            <code>&lt;cursor&gt;</code> where the cursor ends up.
          </>
        }
      >
        <Textarea
          id="snippet-body"
          value={draft.body}
          onChange={(event) => setDraft((value) => ({ ...value, body: event.target.value }))}
          className="min-h-40 font-mono text-xs"
          placeholder="<placeholder:Title>\n<cursor>"
        />
      </FormField>
      <div className="mt-auto flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={insert} disabled={!draft.body.trim()}>
          Insert
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={!draft.name.trim() || !draft.body.trim()}
        >
          <Save />
          {creating ? 'Save snippet' : 'Save changes'}
        </Button>
      </div>
    </div>
  );

  return (
    <ListDetailDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<Scissors />}
      title="Note snippets"
      description="Reusable markdown with placeholders, inserted into the current note."
      items={shown}
      getKey={(snippet) => snippet.id}
      selectedKey={selectedId}
      onSelect={(id) => {
        setCreating(false);
        setSelectedId(id);
      }}
      renderRow={(snippet) => (
        <ListDetailRow
          title={snippet.name}
          summary={[
            snippet.scope === 'vault' ? 'Vault' : 'App',
            snippet.category,
            snippet.description,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      )}
      renderDetail={() => editor}
      detailOverride={creating || snippets.length === 0 ? editor : undefined}
      filter={{ value: query, onChange: setQuery, placeholder: 'Filter snippets' }}
      newLabel="New snippet"
      onNew={startNew}
      placeholder={isLoading ? 'Loading snippets…' : undefined}
      footerStart={
        selectedSnippet && !creating ? (
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={handleDelete}
          >
            <Trash2 />
            Delete snippet
          </Button>
        ) : undefined
      }
    />
  );
}
