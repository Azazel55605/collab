import { Sigma, StickyNote, Type } from 'lucide-react';

import { PromptDialog } from '../ui/form-dialog';

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
  const kind = draft?.kind ?? 'text';
  return (
    <PromptDialog
      open={draft !== null}
      onOpenChange={onOpenChange}
      multiline
      icon={kind === 'sticky' ? <StickyNote /> : kind === 'equation' ? <Sigma /> : <Type />}
      title={kind === 'sticky' ? 'Add sticky note' : kind === 'equation' ? 'Add equation' : 'Add text'}
      description="It stays editable after it is placed on the drawing. Ctrl+Enter adds it."
      label={
        kind === 'sticky' ? 'Sticky note text' : kind === 'equation' ? 'Equation LaTeX' : 'Drawing text'
      }
      placeholder={kind === 'equation' ? 'x^2 + y^2 = r^2' : undefined}
      submitLabel="Add to drawing"
      onSubmit={onCreate}
    />
  );
}
