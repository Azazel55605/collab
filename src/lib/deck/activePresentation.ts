/** Server-backed discovery for a running presentation. */
import type {
  ActivePresentation,
  ActivePresentationHeartbeat,
} from '../../types/activePresentation';
import { tauriCommands } from '../tauri';

export const ACTIVE_PRESENTATION_HEARTBEAT_MS = 5_000;

export function publishActivePresentation(
  serverUrl: string,
  showId: string,
  heartbeat: ActivePresentationHeartbeat,
): Promise<ActivePresentation> {
  return tauriCommands.hostedVaultRequest<ActivePresentation>(
    serverUrl,
    'PUT',
    `/api/v1/presentations/active/${encodeURIComponent(showId)}`,
    heartbeat,
  );
}

export function stopPublishingActivePresentation(serverUrl: string, showId: string): Promise<void> {
  return tauriCommands.hostedVaultRequest<void>(
    serverUrl,
    'DELETE',
    `/api/v1/presentations/active/${encodeURIComponent(showId)}`,
  );
}
