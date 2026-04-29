import { FileText, GitBranchPlus, Layout, LayoutDashboard, Link2, Paperclip } from 'lucide-react';

import type { FileReference, NoteFile } from '../../types/vault';

interface FileReferencesPanelProps {
  selectedFile: NoteFile;
  references: FileReference[];
  loading: boolean;
  error: string | null;
  onOpenReference: (reference: FileReference) => void;
}

function getReferenceIcon(reference: FileReference) {
  switch (reference.referenceKind) {
    case 'kanban-attachment':
      return <Paperclip size={12} className="text-emerald-400/80" />;
    case 'canvas-file-node':
    case 'canvas-note-node':
      return <Layout size={12} className="text-blue-400/80" />;
    default:
      return <Link2 size={12} className="text-primary/80" />;
  }
}

function getSourceDocumentIcon(reference: FileReference) {
  switch (reference.sourceDocumentType) {
    case 'kanban':
      return <LayoutDashboard size={12} className="text-emerald-400/70" />;
    case 'canvas':
      return <Layout size={12} className="text-blue-400/70" />;
    default:
      return <FileText size={12} className="text-muted-foreground/70" />;
  }
}

function getReferenceKindLabel(reference: FileReference) {
  switch (reference.referenceKind) {
    case 'kanban-attachment':
      return 'Kanban attachment';
    case 'canvas-file-node':
      return 'Canvas file card';
    case 'canvas-note-node':
      return 'Canvas note card';
    case 'note-wikilink':
      return 'Note wikilink';
    default:
      return 'Note link';
  }
}

export default function FileReferencesPanel({
  selectedFile,
  references,
  loading,
  error,
  onOpenReference,
}: FileReferencesPanelProps) {
  return (
    <div className="border-t border-border/30 px-2 py-2">
      <div className="flex items-center gap-2 px-1 pb-2">
        <GitBranchPlus size={13} className="text-primary/80" />
        <div className="min-w-0">
          <div className="truncate text-[11px] font-medium text-foreground">Where referenced?</div>
          <div className="truncate text-[10px] text-muted-foreground">{selectedFile.relativePath}</div>
        </div>
      </div>

      {loading ? (
        <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
          Loading references…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
          {error}
        </div>
      ) : references.length === 0 ? (
        <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
          No references found for this file.
        </div>
      ) : (
        <div className="max-h-56 space-y-1 overflow-y-auto pr-1">
          {references.map((reference, index) => (
            <button
              key={`${reference.sourceRelativePath}:${reference.referenceKind}:${reference.displayLabel ?? ''}:${index}`}
              onClick={() => onOpenReference(reference)}
              className="w-full rounded-xl border border-border/40 bg-background/40 px-2.5 py-2 text-left transition-colors hover:bg-accent/40"
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">{getReferenceIcon(reference)}</span>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
                    {getSourceDocumentIcon(reference)}
                    <span className="truncate">{reference.displayLabel || reference.sourceRelativePath}</span>
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">{reference.sourceRelativePath}</div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span>{getReferenceKindLabel(reference)}</span>
                    {reference.context ? <span className="truncate">· {reference.context}</span> : null}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
