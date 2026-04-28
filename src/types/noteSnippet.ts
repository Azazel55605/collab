export type NoteSnippetScope = 'vault' | 'app';

export interface NoteSnippet {
  id: string;
  name: string;
  description?: string | null;
  scope: NoteSnippetScope;
  category?: string | null;
  body: string;
  updatedAt: number;
}

export interface NoteSnippetDraft {
  id?: string | null;
  name: string;
  description?: string | null;
  scope: NoteSnippetScope;
  category?: string | null;
  body: string;
}
