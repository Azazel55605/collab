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
