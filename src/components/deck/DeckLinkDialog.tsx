import { useEffect, useState } from 'react';

import { parseLinkAddress } from '../../lib/deck/links';
import type { DeckLink } from '../../types/deck';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

interface DeckLinkDialogProps {
  open: boolean;
  current: DeckLink | null;
  slides: Array<{ id: string; label: string }>;
  onOpenChange: (open: boolean) => void;
  onApply: (link: DeckLink | null) => void;
}

/** Link to a web address or another slide, or remove a link. */
export function DeckLinkDialog({
  open,
  current,
  slides,
  onOpenChange,
  onApply,
}: DeckLinkDialogProps) {
  const [mode, setMode] = useState<'url' | 'slide'>('url');
  const [address, setAddress] = useState('');
  const [slideId, setSlideId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    setMode(current?.kind === 'slide' ? 'slide' : 'url');
    setAddress(current?.kind === 'url' ? current.href : '');
    setSlideId(current?.kind === 'slide' ? current.slideId : slides[0]?.id);
  }, [current, open, slides]);

  const link: DeckLink | null =
    mode === 'url' ? parseLinkAddress(address) : slideId ? { kind: 'slide', slideId } : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link</DialogTitle>
          <DialogDescription>Link the selected text to a web address or a slide.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={mode === 'url' ? 'secondary' : 'ghost'}
            onClick={() => setMode('url')}
          >
            Web address
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === 'slide' ? 'secondary' : 'ghost'}
            onClick={() => setMode('slide')}
          >
            Slide in this deck
          </Button>
        </div>
        {mode === 'url' ? (
          <div className="space-y-1">
            <Input
              aria-label="Web address"
              placeholder="https://example.com"
              value={address}
              autoFocus
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && link) onApply(link);
              }}
            />
            {address.trim() !== '' && !link && (
              <p className="text-xs text-destructive">
                Only http, https, and mailto addresses can be linked.
              </p>
            )}
          </div>
        ) : (
          <Select value={slideId} onValueChange={setSlideId}>
            <SelectTrigger aria-label="Slide" className="w-full">
              <SelectValue placeholder="Choose a slide" />
            </SelectTrigger>
            <SelectContent>
              {slides.map((slide) => (
                <SelectItem key={slide.id} value={slide.id}>
                  {slide.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <DialogFooter>
          {current && (
            <Button type="button" variant="ghost" onClick={() => onApply(null)}>
              Remove link
            </Button>
          )}
          <Button type="button" disabled={!link} onClick={() => link && onApply(link)}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
