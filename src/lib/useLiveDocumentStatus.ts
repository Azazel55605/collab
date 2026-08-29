import { useEffect, useState } from 'react';

import type { DocumentSessionController } from './documentSessionController';
import type { LiveDocumentHandle, LiveStatus } from './liveDocumentSession';

function toControllerLiveState(status: LiveStatus) {
  return status === 'connected' ? 'live-connected' : 'live-reconnecting';
}

export function useLiveDocumentStatus<TDocument>(
  controller: DocumentSessionController<TDocument>,
  liveSession: LiveDocumentHandle | null,
) {
  const [status, setStatus] = useState<LiveStatus | null>(() => liveSession?.getStatus() ?? null);

  useEffect(() => {
    if (!liveSession) {
      setStatus(null);
      controller.setLiveState(null);
      return;
    }

    const sync = (next: LiveStatus) => {
      setStatus(next);
      controller.setLiveState(toControllerLiveState(next));
    };

    sync(liveSession.getStatus());
    return liveSession.onStatus(sync);
  }, [controller, liveSession]);

  return status;
}
