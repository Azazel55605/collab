import { Tags } from 'lucide-react';

import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';

/** After a move: add the destination column's default tags to the card? */
export function ColumnTagsPrompt({
  open,
  cardTitle,
  columnTitle,
  tags,
  onClose,
  onApplyOnce,
  onAlwaysApply,
}: {
  open: boolean;
  cardTitle: string;
  columnTitle: string;
  tags: string[];
  onClose: () => void;
  onApplyOnce: () => void;
  onAlwaysApply: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      icon={<Tags />}
      title="Apply column tags?"
      description={`“${cardTitle}” moved to ${columnTitle}. That column adds these tags, which the card does not have yet:`}
      cancelLabel="Not now"
      confirmLabel="Apply once"
      onConfirm={onApplyOnce}
      secondary={
        <Button variant="outline" onClick={onAlwaysApply}>
          Always apply here
        </Button>
      }
    >
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <span key={tag} className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs text-primary">
            {tag}
          </span>
        ))}
      </div>
    </ConfirmDialog>
  );
}
