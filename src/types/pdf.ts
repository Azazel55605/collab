import type { InkAnnotationDocument } from './ink';

export const PDF_SIDECAR_SCHEMA_VERSION = 2;

export interface PdfHighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfBookmark {
  id: string;
  page: number;
  label?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PdfHighlight {
  id: string;
  page: number;
  text: string;
  rects: PdfHighlightRect[];
  color?: string | null;
  note?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PdfTextAnnotation {
  id: string;
  page: number;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  color?: string | null;
  backgroundColor?: string | null;
  textColor?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PdfPageComment {
  id: string;
  page: number;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface PdfViewerState {
  lastPage?: number | null;
  lastZoomMode?: 'custom' | 'fit-width' | 'fit-height' | 'fit-page' | null;
  lastZoom?: number | null;
  lastLayoutMode?: 'single' | 'scroll' | 'spread' | null;
  lastRotation?: number | null;
  lastBookmarksOpen?: boolean | null;
}

export interface PdfSidecarState {
  /** Added in v2. Missing means a legacy v1 sidecar and is migrated on read. */
  schemaVersion?: number;
  bookmarks: PdfBookmark[];
  highlights: PdfHighlight[];
  textAnnotations: PdfTextAnnotation[];
  pageComments: PdfPageComment[];
  /** Editable pressure ink and vector objects anchored to immutable PDF pages. */
  ink?: InkAnnotationDocument;
  viewerState?: PdfViewerState | null;
}
