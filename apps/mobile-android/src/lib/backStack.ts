/**
 * Back-press dismiss stack.
 *
 * Android dispatches every back press to the app before the WebView history can
 * finish the activity, and `useMobileStore.goBack` decides what it means. That
 * only ever knew about store navigation (the active file sheet, the folder
 * trail, the current tab), so anything a screen kept in local state — the
 * Settings category detail, a bottom sheet, a popover menu — was invisible to
 * it, and back jumped straight to the quit prompt instead of stepping back.
 *
 * Screens register a dismiss callback here while such a surface is open.
 * `goBack` runs the most recently registered one first, so back unwinds in the
 * order things were opened.
 */
import { useEffect, useRef } from 'react';

type Dismiss = () => void;

interface Registration {
  id: number;
  dismiss: Dismiss;
}

const stack: Registration[] = [];
let nextId = 1;

/** Registers a dismiss callback. Returns the unregister function. */
export function pushBackDismiss(dismiss: Dismiss): () => void {
  const registration: Registration = { id: nextId++, dismiss };
  stack.push(registration);
  return () => {
    const index = stack.findIndex((entry) => entry.id === registration.id);
    if (index >= 0) stack.splice(index, 1);
  };
}

/**
 * Runs the topmost dismiss callback. Returns true when one handled the press,
 * so the caller knows not to navigate further.
 */
export function runTopBackDismiss(): boolean {
  const registration = stack.pop();
  if (!registration) return false;
  registration.dismiss();
  return true;
}

/** Test helper: drop every registration. */
export function clearBackDismissStack(): void {
  stack.length = 0;
}

export function backDismissDepth(): number {
  return stack.length;
}

/**
 * Registers `dismiss` for the back press while `active` is true.
 *
 * The callback is read through a ref so re-renders never re-register — that
 * would reorder the stack and make back unwind surfaces out of order.
 */
export function useBackDismiss(active: boolean, dismiss: Dismiss): void {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (!active) return;
    return pushBackDismiss(() => dismissRef.current());
  }, [active]);
}
