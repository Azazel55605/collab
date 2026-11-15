import { useEffect, useState } from 'react';

import { Link2 } from 'lucide-react';

import { parseLinkAddress } from '../../lib/deck/links';
import type { DeckLink } from '../../types/deck';
import { ChoiceCard, ChoiceGroup } from '../ui/app-dialog';
import { Button } from '../ui/button';
import { FormDialog, FormField } from '../ui/form-dialog';
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
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="s"
      icon={<Link2 />}
      title="Link"
      description="Link the selected text to a web address or a slide."
      submitLabel="Apply"
      submitDisabled={!link}
      onSubmit={() => {
        if (link) onApply(link);
      }}
      secondary={
        current ? (
          <Button type="button" variant="ghost" onClick={() => onApply(null)}>
            Remove link
          </Button>
        ) : undefined
      }
    >
      <ChoiceGroup
        value={mode}
        onValueChange={(value) => setMode(value as 'url' | 'slide')}
        aria-label="Link to"
        className="grid grid-cols-2 gap-2"
      >
        <ChoiceCard value="url" title="Web address" />
        <ChoiceCard value="slide" title="Slide in this deck" />
      </ChoiceGroup>
      {mode === 'url' ? (
        <FormField
          label="Address"
          htmlFor="deck-link-address"
          error={
            address.trim() !== '' && !link
              ? 'Only http, https, and mailto addresses can be linked.'
              : undefined
          }
        >
          <Input
            id="deck-link-address"
            aria-label="Web address"
            placeholder="https://example.com"
            value={address}
            autoFocus
            onChange={(event) => setAddress(event.target.value)}
          />
        </FormField>
      ) : (
        <FormField label="Slide">
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
        </FormField>
      )}
    </FormDialog>
  );
}
