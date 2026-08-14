import { useEffect, useState } from 'react';
import { PenLine } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { cn } from '../../lib/utils';
import { INK_PAGE_PRESETS } from '../../types/ink';
import type { InkBackgroundPattern, InkPageMode, InkPagePresetId } from '../../types/ink';
import { loadInkTemplates } from '../../lib/ink/templates';

const labelClass = 'text-xs font-medium text-muted-foreground';

/**
 * The New Drawing dialog.
 *
 * Paper choice matters more here than in any other Collab document: ruled paper
 * is what makes handwriting sit straight, and a graph or staff background is
 * the difference between the tool being usable for its purpose and not. So the
 * creation step asks, rather than defaulting to blank A4 and burying the choice
 * in a settings panel.
 *
 * Backgrounds are ordinary document content — a page records its own pattern —
 * so every choice here stays editable afterwards.
 */

export interface NewDrawingChoice {
  name: string;
  mode: InkPageMode;
  preset: InkPagePresetId;
  landscape: boolean;
  pattern: InkBackgroundPattern;
  templateId?: string;
}

const PAPERS: Array<{ id: InkBackgroundPattern; label: string; hint: string }> = [
  { id: 'blank', label: 'Blank', hint: 'Nothing but the page' },
  { id: 'ruled', label: 'Ruled', hint: 'Lines for handwriting' },
  { id: 'grid', label: 'Graph', hint: 'Squares for diagrams' },
  { id: 'dotted', label: 'Dotted', hint: 'Dots for bullet layouts' },
  { id: 'staff', label: 'Music staff', hint: 'Five-line staves' },
  { id: 'storyboard', label: 'Storyboard', hint: 'Framed panels' },
];

const SIZES: Array<{ id: InkPagePresetId; label: string }> = [
  { id: 'a4', label: 'A4' },
  { id: 'a5', label: 'A5' },
  { id: 'letter', label: 'Letter' },
  { id: 'legal', label: 'Legal' },
  { id: 'ratio4x3', label: '4:3' },
  { id: 'ratio16x9', label: '16:9' },
];

interface NewDrawingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (choice: NewDrawingChoice) => void;
}

export default function NewDrawingDialog({
  open,
  onOpenChange,
  onCreate,
}: NewDrawingDialogProps) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState<InkPageMode>('fixed');
  const [preset, setPreset] = useState<InkPagePresetId>('a4');
  const [landscape, setLandscape] = useState(false);
  const [pattern, setPattern] = useState<InkBackgroundPattern>('blank');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState(() => loadInkTemplates());

  useEffect(() => {
    if (!open) return;
    setName('');
    setMode('fixed');
    setPreset('a4');
    setLandscape(false);
    setPattern('blank');
    setTemplateId('');
    setTemplates(loadInkTemplates());
  }, [open]);

  const submit = () => {
    onCreate({
      name: name.trim() || 'Untitled Drawing',
      mode,
      preset,
      landscape,
      pattern,
      ...(templateId ? { templateId } : {}),
    });
  };

  const size = INK_PAGE_PRESETS[preset];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PenLine size={16} />
            New drawing
          </DialogTitle>
          <DialogDescription>
            Choose the paper now — every part of it stays editable later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="ink-name" className={labelClass}>Drawing name</label>
            <Input
              id="ink-name"
              value={name}
              autoFocus
              placeholder="Untitled Drawing"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') submit();
              }}
            />
          </div>

          {templates.length > 0 && (
            <div className="space-y-1.5">
              <label htmlFor="ink-template" className={labelClass}>Saved template</label>
              <select
                id="ink-template"
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-xs"
              >
                <option value="">Use the paper settings below</option>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <span className={labelClass}>Paper</span>
            <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Paper">
              {PAPERS.map((paper) => (
                <button
                  key={paper.id}
                  type="button"
                  role="radio"
                  aria-checked={pattern === paper.id}
                  onClick={() => setPattern(paper.id)}
                  className={cn(
                    'rounded-lg border p-2 text-left text-xs transition-colors app-motion-fast',
                    pattern === paper.id
                      ? 'border-primary bg-primary/10'
                      : 'border-border/60 hover:bg-accent/50',
                  )}
                >
                  <div className="font-medium text-foreground">{paper.label}</div>
                  <div className="text-[11px] text-muted-foreground">{paper.hint}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <span className={labelClass}>Surface</span>
            <div className="flex gap-1.5" role="radiogroup" aria-label="Surface">
              {(['fixed', 'infinite'] as InkPageMode[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={mode === option}
                  onClick={() => setMode(option)}
                  className={cn(
                    'flex-1 rounded-lg border px-3 py-2 text-xs transition-colors app-motion-fast',
                    mode === option
                      ? 'border-primary bg-primary/10'
                      : 'border-border/60 hover:bg-accent/50',
                  )}
                >
                  {option === 'fixed' ? 'Fixed page' : 'Infinite canvas'}
                </button>
              ))}
            </div>
          </div>

          {mode === 'fixed' && (
            <div className="space-y-1.5">
              <span className={labelClass}>Page size</span>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Page size">
                {SIZES.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    role="radio"
                    aria-checked={preset === entry.id}
                    onClick={() => setPreset(entry.id)}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-xs transition-colors app-motion-fast',
                      preset === entry.id
                        ? 'border-primary bg-primary/10'
                        : 'border-border/60 hover:bg-accent/50',
                    )}
                  >
                    {entry.label}
                  </button>
                ))}
                <button
                  type="button"
                  role="radio"
                  aria-checked={landscape}
                  onClick={() => setLandscape((current) => !current)}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-xs transition-colors app-motion-fast',
                    landscape
                      ? 'border-primary bg-primary/10'
                      : 'border-border/60 hover:bg-accent/50',
                  )}
                >
                  Landscape
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {landscape
                  ? `${Math.round(size.height / 64)} x ${Math.round(size.width / 64)} pt`
                  : `${Math.round(size.width / 64)} x ${Math.round(size.height / 64)} pt`}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
