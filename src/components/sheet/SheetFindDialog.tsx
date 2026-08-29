import { useEffect, useState } from 'react';

import { ArrowDown, ArrowUp, MapPin, Replace, ReplaceAll } from 'lucide-react';

import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';

interface Props {
  open: boolean;
  readOnly?: boolean;
  resultLabel: string;
  onOpenChange: (open: boolean) => void;
  onFind: (
    query: string,
    options: { matchCase: boolean; wholeCell: boolean },
    direction: 'next' | 'previous',
  ) => void;
  onReplace: (
    query: string,
    replacement: string,
    options: { matchCase: boolean; wholeCell: boolean },
  ) => void;
  onReplaceAll: (
    query: string,
    replacement: string,
    options: { matchCase: boolean; wholeCell: boolean },
  ) => void;
  onGoTo: (reference: string) => void;
}

export default function SheetFindDialog({
  open,
  readOnly,
  resultLabel,
  onOpenChange,
  onFind,
  onReplace,
  onReplaceAll,
  onGoTo,
}: Props) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [reference, setReference] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeCell, setWholeCell] = useState(false);
  const options = { matchCase, wholeCell };

  useEffect(() => {
    if (!open) return;
    const handle = window.setTimeout(() => {
      document.querySelector<HTMLInputElement>('#sheet-find-query')?.focus();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Find and replace</DialogTitle>
          <DialogDescription>
            Search the current worksheet or jump to an A1 range.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid grid-cols-[1fr_auto_auto] gap-2">
            <Input
              id="sheet-find-query"
              aria-label="Find"
              placeholder="Find"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter')
                  onFind(query, options, event.shiftKey ? 'previous' : 'next');
              }}
            />
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Previous match"
              onClick={() => onFind(query, options, 'previous')}
            >
              <ArrowUp />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Next match"
              onClick={() => onFind(query, options, 'next')}
            >
              <ArrowDown />
            </Button>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={matchCase}
                onCheckedChange={(checked) => setMatchCase(checked === true)}
              />
              Match case
            </label>
            <label className="flex items-center gap-2">
              <Checkbox
                checked={wholeCell}
                onCheckedChange={(checked) => setWholeCell(checked === true)}
              />
              Whole cell
            </label>
            <span className="ml-auto text-muted-foreground" role="status">
              {resultLabel}
            </span>
          </div>
          <div className="grid grid-cols-[1fr_auto_auto] gap-2">
            <Input
              aria-label="Replace with"
              placeholder="Replace with"
              value={replacement}
              disabled={readOnly}
              onChange={(event) => setReplacement(event.target.value)}
            />
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Replace match"
              disabled={readOnly || !query}
              onClick={() => onReplace(query, replacement, options)}
            >
              <Replace />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Replace all matches"
              disabled={readOnly || !query}
              onClick={() => onReplaceAll(query, replacement, options)}
            >
              <ReplaceAll />
            </Button>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2 border-t border-border/60 pt-3">
            <Input
              aria-label="Go to cell or range"
              placeholder="A1 or A1:C8"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onGoTo(reference);
              }}
            />
            <Button
              type="button"
              size="icon"
              variant="outline"
              aria-label="Go to range"
              onClick={() => onGoTo(reference)}
            >
              <MapPin />
            </Button>
          </div>
        </div>

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
