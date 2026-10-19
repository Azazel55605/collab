import { type Event, listen } from '@tauri-apps/api/event';

/** Cleanup remains valid even when native registration completes after disposal. */
export function listenSafely<T>(
  name: string,
  handler: (event: Event<T>) => void,
  onReady?: () => void,
): () => void {
  let disposed = false;
  let cleanup: (() => void) | undefined;
  void listen<T>(name, (event) => {
    if (!disposed) handler(event);
  })
    .then((unlisten) => {
      if (disposed) unlisten();
      else {
        cleanup = unlisten;
        onReady?.();
      }
    })
    .catch((error) => console.error(`Could not subscribe to ${name}`, error));
  return () => {
    disposed = true;
    cleanup?.();
    cleanup = undefined;
  };
}
