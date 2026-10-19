import { useEffect } from 'react';

import { toast } from 'sonner';

import { runDocumentNavigation } from './documentNavigation';
import { listenSafely } from './nativeSubscription';
import { tauriCommands } from './tauri';

/** Native close/tray quit waits for the same save boundary as tab navigation. */
export function useDesktopQuitGuard() {
  useEffect(() => {
    let disposed = false;
    let pending = false;
    const requestQuit = () => {
      if (pending) return;
      pending = true;
      void (async () => {
        try {
          const allowed = await runDocumentNavigation(() => {});
          await tauriCommands.backgroundCompleteQuit(allowed && !disposed);
        } catch (error) {
          toast.error('Could not finish closing Collab. Your documents remain open.', {
            description: String(error),
          });
        } finally {
          pending = false;
        }
      })();
    };
    const off = listenSafely('background:quit-requested', requestQuit, () => {
      // A tray/window request can arrive before the renderer listener is ready.
      void tauriCommands
        .backgroundQuitPending()
        .then((requested) => {
          if (requested && !disposed) requestQuit();
        })
        .catch((error) => console.error('Could not inspect pending quit request', error));
    });
    return () => {
      disposed = true;
      off();
    };
  }, []);
}
