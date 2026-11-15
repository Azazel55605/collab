import { useEffect, useMemo, useState } from 'react';

import { Send } from 'lucide-react';

import type { NoteFile } from '../../types/vault';
import { ChoiceCard, ChoiceGroup } from '../ui/app-dialog';
import { FormDialog, FormField } from '../ui/form-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

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
    setTargetKind(
      currentNotePath ? 'note-current' : currentCanvasPath ? 'canvas-current' : 'note-other',
    );
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
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="s"
      icon={<Send />}
      title={mode === 'quote' ? 'Send quote' : 'Send snapshot'}
      description={`Choose where to insert this PDF ${mode === 'quote' ? 'selection' : 'snapshot'}.`}
      submitLabel="Insert"
      submitDisabled={!canSubmit}
      onSubmit={submit}
    >
      <ChoiceGroup
        value={targetKind}
        onValueChange={(value) => setTargetKind(value as typeof targetKind)}
        aria-label="Insert into"
      >
        {currentNotePath && (
          <ChoiceCard value="note-current" title="Current note" description={currentNotePath} />
        )}
        {currentCanvasPath && (
          <ChoiceCard
            value="canvas-current"
            title="Current canvas"
            description={currentCanvasPath}
          />
        )}
        <ChoiceCard value="note-other" title="Another note" />
      </ChoiceGroup>
      {targetKind === 'note-other' && (
        <FormField label="Note">
          <Select value={notePath} onValueChange={setNotePath}>
            <SelectTrigger className="w-full" aria-label="Note">
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
        </FormField>
      )}
    </FormDialog>
  );
}
