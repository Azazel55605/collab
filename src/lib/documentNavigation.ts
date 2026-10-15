import { toast } from 'sonner';

import { useDocumentStatusStore } from '../store/documentStatusStore';

let pending: Array<{ action: () => void; resolve: (allowed: boolean) => void }> = [];
let flushing = false;

/** Keep the mounted editor until its latest content is saved or durably queued. */
export function runDocumentNavigation(action: () => void): Promise<boolean> {
  if (
    Object.values(useDocumentStatusStore.getState().statuses).some((entry) => {
      const snapshot = entry.controller?.getSnapshot();
      return entry.readOnly && snapshot?.dirty && !snapshot.offlineQueued;
    })
  ) {
    toast.error(
      'This document has unsaved edits but is now read-only. Recover your edits before leaving.',
    );
    return Promise.resolve(false);
  }
  const controllers = [
    ...new Set(
      Object.values(useDocumentStatusStore.getState().statuses)
        .filter((entry) => !entry.readOnly)
        .map((entry) => entry.controller)
        .filter((controller) => controller !== undefined),
    ),
  ];
  const dirty = controllers.filter((controller) => {
    const snapshot = controller.getSnapshot();
    return (snapshot.dirty || snapshot.saving) && !snapshot.liveState && !snapshot.offlineQueued;
  });
  const preparers = Object.values(useDocumentStatusStore.getState().statuses).flatMap((entry) =>
    entry.beforeLeave ? [entry.beforeLeave] : [],
  );
  if (!flushing && dirty.length === 0 && preparers.length === 0) {
    action();
    return Promise.resolve(true);
  }
  const result = new Promise<boolean>((resolve) => pending.push({ action, resolve }));
  if (flushing) return result;
  flushing = true;
  void (async () => {
    try {
      if (preparers.length) await Promise.all(preparers.map((prepare) => prepare()));
      // A preparer can materialize a paused gesture after the initial snapshot.
      for (const controller of controllers) {
        const state = controller.getSnapshot();
        if (
          (state.dirty || state.saving) &&
          !state.liveState &&
          !state.offlineQueued &&
          !dirty.includes(controller)
        )
          dirty.push(controller);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        await Promise.all(dirty.map((controller) => controller.requestSave('flush')));
        if (
          dirty.every((controller) => {
            const state = controller.getSnapshot();
            return state.conflicted || !state.dirty || state.offlineQueued;
          })
        )
          break;
      }
      if (
        dirty.some((controller) => {
          const state = controller.getSnapshot();
          return state.conflicted || (state.dirty && !state.offlineQueued);
        })
      )
        throw new Error(
          'The document still has unsaved or conflicting edits. Finish saving before leaving.',
        );
      const actions = pending;
      pending = [];
      actions.forEach(({ action, resolve }) => {
        action();
        resolve(true);
      });
    } catch (error) {
      pending.forEach(({ resolve }) => resolve(false));
      pending = [];
      toast.error('Could not save before leaving. Your edits are still open.', {
        description: String(error),
      });
    } finally {
      flushing = false;
    }
  })();
  return result;
}
