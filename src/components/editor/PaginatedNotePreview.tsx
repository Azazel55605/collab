import { useCallback, useEffect, useRef, useState } from 'react';

import { notePageGeometry, type NotePageSettings } from '../../lib/notePageLayout';
import { paginateNote } from '../../lib/paginateNote';

import { MarkdownPreview } from './MarkdownPreview';

export function PaginatedNotePreview({
  content,
  relativePath,
  settings,
  onReady,
}: {
  content: string;
  relativePath: string;
  settings: NotePageSettings;
  onReady?: (pages: number) => void;
}) {
  const sourceRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [readyRevision, setReadyRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const markReady = useCallback(() => setReadyRevision((revision) => revision + 1), []);
  const geometry = notePageGeometry(settings);

  useEffect(() => {
    if (!readyRevision) return;
    setError(null);
    let cancelled = false;
    let frame = 0;
    const paginate = async () => {
      await Promise.race([
        document.fonts?.ready,
        new Promise((resolve) => setTimeout(resolve, 1600)),
      ]);
      if (cancelled) return;
      frame = requestAnimationFrame(() => {
        if (cancelled || !sourceRef.current || !pagesRef.current) return;
        try {
          const pages = paginateNote(sourceRef.current, pagesRef.current, settings);
          onReady?.(pages);
        } catch (error) {
          pagesRef.current.replaceChildren();
          setError(`Could not prepare pages: ${String(error)}`);
        }
      });
    };
    void paginate();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [readyRevision, settings, onReady]);

  return (
    <div className="note-pagination-host">
      {error && <div role="alert">{error}</div>}
      <div
        ref={sourceRef}
        className="note-print-document note-pagination-source"
        aria-hidden="true"
        style={{ width: geometry.contentWidth }}
      >
        <MarkdownPreview
          content={content}
          currentDocumentRelativePath={relativePath}
          className="note-print-markdown"
          onReady={markReady}
        />
      </div>
      <div
        ref={pagesRef}
        className="note-print-document note-paged-preview"
        aria-label="Paginated note preview"
      />
    </div>
  );
}
