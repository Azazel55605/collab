import { useEffect, useMemo, useState } from 'react';

import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import type { NoteFile } from '../../types/vault';

export type PdfSendTarget =
  | { kind: 'note-current'; relativePath: string }
  | { kind: 'note-other'; relativePath: string }
  | { kind: 'canvas-current'; relativePath: string };

interface PdfSendTargetDialogProps {
  open: boolean;
  mode: 'quote' | 'snapshot';
  currentNotePath: string | null;
  currentCanvasPath: string | null;
  availableNotes: NoteFile[];
  onConfirm: (target: PdfSendTarget) => void;
  onClose: () => void;
}

export function PdfSendTargetDialog({
  open,
  mode,
  currentNotePath,
  currentCanvasPath,
  availableNotes,
  onConfirm,
  onClose,
}: PdfSendTargetDialogProps) {
  const [targetKind, setTargetKind] = useState<'note-current' | 'note-other' | 'canvas-current'>(
    currentNotePath ? 'note-current' : currentCanvasPath ? 'canvas-current' : 'note-other',
  );
  const [notePath, setNotePath] = useState<string>(availableNotes[0]?.relativePath ?? '');

  useEffect(() => {
    if (!open) return;
    setTargetKind(currentNotePath ? 'note-current' : currentCanvasPath ? 'canvas-current' : 'note-other');
    setNotePath(availableNotes[0]?.relativePath ?? '');
  }, [availableNotes, currentCanvasPath, currentNotePath, open]);

  const canSubmit = useMemo(() => {
    if (targetKind === 'note-current') return !!currentNotePath;
    if (targetKind === 'canvas-current') return !!currentCanvasPath;
    return !!notePath;
  }, [currentCanvasPath, currentNotePath, notePath, targetKind]);

  const submit = () => {
    if (targetKind === 'note-current' && currentNotePath) {
      onConfirm({ kind: 'note-current', relativePath: currentNotePath });
      return;
    }
    if (targetKind === 'canvas-current' && currentCanvasPath) {
      onConfirm({ kind: 'canvas-current', relativePath: currentCanvasPath });
      return;
    }
    if (notePath) {
      onConfirm({ kind: 'note-other', relativePath: notePath });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'quote' ? 'Send quote' : 'Send snapshot'}</DialogTitle>
          <DialogDescription>
            Choose where to insert this PDF {mode === 'quote' ? 'selection' : 'snapshot'}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {currentNotePath && (
            <button
              type="button"
              className={`w-full rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                targetKind === 'note-current'
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border/60 bg-muted/20 text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              }`}
              onClick={() => setTargetKind('note-current')}
            >
              Current note
              <div className="mt-1 text-xs opacity-80">{currentNotePath}</div>
            </button>
          )}

          {currentCanvasPath && (
            <button
              type="button"
              className={`w-full rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                targetKind === 'canvas-current'
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border/60 bg-muted/20 text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              }`}
              onClick={() => setTargetKind('canvas-current')}
            >
              Current canvas
              <div className="mt-1 text-xs opacity-80">{currentCanvasPath}</div>
            </button>
          )}

          <div className={`rounded-xl border px-3 py-3 ${targetKind === 'note-other' ? 'border-primary bg-primary/5' : 'border-border/60 bg-muted/20'}`}>
            <button
              type="button"
              className="w-full text-left text-sm font-medium text-foreground"
              onClick={() => setTargetKind('note-other')}
            >
              Another note
            </button>
            <Select value={notePath} onValueChange={setNotePath}>
              <SelectTrigger className="mt-2 w-full justify-between bg-background">
                <SelectValue placeholder="Choose a note" />
              </SelectTrigger>
              <SelectContent>
                {availableNotes.map((note) => (
                  <SelectItem key={note.relativePath} value={note.relativePath}>
                    {note.relativePath}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit}>Insert</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
