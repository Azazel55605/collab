import { useEffect, useState } from 'react';

import { StickyNote, Type } from 'lucide-react';

import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

export interface InkTextDraft {
  kind: 'text' | 'sticky' | 'equation';
  x: number;
  y: number;
  width: number;
  height: number;
}

interface InkTextDialogProps {
  draft: InkTextDraft | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (text: string) => void;
}

export default function InkTextDialog({ draft, onOpenChange, onCreate }: InkTextDialogProps) {
  const [text, setText] = useState('');

  useEffect(() => {
    if (draft) setText('');
  }, [draft]);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    onCreate(value);
  };

  return (
    <Dialog open={draft !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {draft?.kind === 'sticky' ? <StickyNote size={16} /> : <Type size={16} />}
            {draft?.kind === 'sticky'
              ? 'Add sticky note'
              : draft?.kind === 'equation'
                ? 'Add equation'
                : 'Add text'}
          </DialogTitle>
          <DialogDescription>
            Text stays editable after it is placed on the drawing.
          </DialogDescription>
        </DialogHeader>
        <textarea
          autoFocus
          aria-label={
            draft?.kind === 'sticky'
              ? 'Sticky note text'
              : draft?.kind === 'equation'
                ? 'Equation LaTeX'
                : 'Drawing text'
          }
          value={text}
          maxLength={16_384}
          rows={6}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submit();
          }}
          className="w-full resize-y rounded-lg border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!text.trim()} onClick={submit}>
            Add to drawing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
