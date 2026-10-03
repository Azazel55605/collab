import type { ActivePresentation } from '../../../../src/types/activePresentation';
import { hostedRequest } from '../mobileTauri';

export const ACTIVE_PRESENTATION_POLL_MS = 3_000;

export function listActivePresentations(serverUrl: string): Promise<ActivePresentation[]> {
  return hostedRequest<ActivePresentation[]>(serverUrl, 'GET', '/api/v1/presentations/active');
}

/** Newest remotely enabled show across every connected account. */
export function preferredRemotePresentation(
  shows: Array<ActivePresentation & { serverUrl: string }>,
): (ActivePresentation & { serverUrl: string }) | null {
  return (
    shows
      .filter((show) => show.remoteEnabled)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  );
}
