import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';

/** Keep Escape/close available while an overlay's content module loads or fails. */
export function DeferredModalStatus({
  title,
  close,
  failed = false,
}: {
  title: string;
  close: () => void;
  failed?: boolean;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {failed
              ? 'Could not load this window. Save your other work and reopen Collab to try again.'
              : 'Loading…'}
          </DialogDescription>
        </DialogHeader>
        <p role={failed ? 'alert' : 'status'} className="text-sm text-muted-foreground">
          {failed ? 'You can close this window and continue working.' : 'Preparing this window.'}
        </p>
      </DialogContent>
    </Dialog>
  );
}
