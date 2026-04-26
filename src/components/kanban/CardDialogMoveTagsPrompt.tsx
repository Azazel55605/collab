import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import type { MoveTagsPromptState } from './useCardDialogActions';

type Props = {
  draftTitle: string;
  prompt: MoveTagsPromptState | null;
  onClose: () => void;
  onApplyOnce: () => void;
  onAlwaysApply: () => void;
};

export function CardDialogMoveTagsPrompt({
  draftTitle,
  prompt,
  onClose,
  onApplyOnce,
  onAlwaysApply,
}: Props) {
  if (!prompt) return null;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Apply column tags?</DialogTitle>
          <DialogDescription>
            Review missing default tags before applying them to the moved card.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">{draftTitle}</span> was moved to{' '}
            <span className="font-medium text-foreground">{prompt.destinationColumnTitle}</span>.
          </p>
          <p className="text-muted-foreground">
            This column has default tags that are not yet on the card:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {prompt.missingTags.map((tag) => (
              <span key={tag} className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary/80">
                {tag}
              </span>
            ))}
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onApplyOnce}>
              Apply once
            </Button>
            <Button onClick={onAlwaysApply}>
              Always apply here
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
