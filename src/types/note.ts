export interface Frontmatter {
  title?: string;
  tags?: string[];
  created?: string;
  modified?: string;
  assignee?: string;
  status?: string;
  [key: string]: unknown;
}

export interface NoteMetadata {
  relativePath: string;
  title: string;
  tags: string[];
  wikilinksOut: string[];
  modifiedAt: number;
  wordCount: number;
  hash: string;
}

export interface SearchResult {
  relativePath: string;
  title: string;
  excerpt: string;
  score: number;
  matchType: string;
}

export interface NoteIndexDelta {
  /** Entire path scopes reconciled, including already-absent native entries. */
  reconciledPaths?: string[];
  upserted: NoteMetadata[];
  removed: string[];
}
export interface SearchPage {
  results: SearchResult[];
  total: number;
  nextOffset: number | null;
}
