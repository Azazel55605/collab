import type { DeckRemoteAction } from '../liveAwareness';

export type DirectRemoteMessage =
  | { type: 'command'; action: DeckRemoteAction; index?: number }
  | { type: 'pointer'; active: boolean; x: number; y: number };

const REMOTE_ACTIONS = new Set<DeckRemoteAction>([
  'next',
  'previous',
  'first',
  'last',
  'goto',
  'black',
  'white',
]);
export const MAX_DIRECT_SDP_BYTES = 64 * 1_024;

export function validDirectSdp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_DIRECT_SDP_BYTES;
}

export function parseDirectRemoteMessage(value: unknown): DirectRemoteMessage | null {
  if (typeof value !== 'string' || value.length > 1_024) return null;
  try {
    const message = JSON.parse(value) as Record<string, unknown>;
    if (message.type === 'command' && REMOTE_ACTIONS.has(message.action as DeckRemoteAction)) {
      if (
        message.action === 'goto' &&
        (!Number.isInteger(message.index) || (message.index as number) < 0)
      ) {
        return null;
      }
      return {
        type: 'command',
        action: message.action as DeckRemoteAction,
        ...(message.action === 'goto' ? { index: message.index as number } : {}),
      };
    }
    if (
      message.type === 'pointer' &&
      typeof message.active === 'boolean' &&
      typeof message.x === 'number' &&
      typeof message.y === 'number' &&
      Number.isFinite(message.x) &&
      Number.isFinite(message.y)
    ) {
      return {
        type: 'pointer',
        active: message.active,
        x: Math.min(1, Math.max(0, message.x)),
        y: Math.min(1, Math.max(0, message.y)),
      };
    }
  } catch {
    // Invalid or hostile data-channel payloads are ignored.
  }
  return null;
}

export function directRemoteMessage(message: DirectRemoteMessage): string {
  return JSON.stringify(message);
}

export function supportsDirectRemote(): boolean {
  return typeof RTCPeerConnection !== 'undefined';
}

export async function waitForIceGathering(
  connection: RTCPeerConnection,
  timeoutMs = 4_000,
): Promise<void> {
  if (connection.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      connection.removeEventListener('icegatheringstatechange', changed);
      resolve();
    };
    const changed = () => {
      if (connection.iceGatheringState === 'complete') finish();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    connection.addEventListener('icegatheringstatechange', changed);
  });
}

export async function createDirectRemoteOffer(): Promise<{
  connection: RTCPeerConnection;
  channel: RTCDataChannel;
  sdp: string;
}> {
  const connection = new RTCPeerConnection({ iceServers: [] });
  const channel = connection.createDataChannel('collab-presentation-remote', { ordered: true });
  await connection.setLocalDescription(await connection.createOffer());
  await waitForIceGathering(connection);
  const sdp = connection.localDescription?.sdp;
  if (!validDirectSdp(sdp)) {
    connection.close();
    throw new Error('The direct presentation offer could not be created.');
  }
  return { connection, channel, sdp };
}

export async function acceptDirectRemoteOffer(
  sdp: string,
  onChannel: (channel: RTCDataChannel) => void,
): Promise<{ connection: RTCPeerConnection; sdp: string }> {
  if (!validDirectSdp(sdp)) throw new Error('The direct presentation offer is invalid.');
  const connection = new RTCPeerConnection({ iceServers: [] });
  connection.addEventListener('datachannel', (event) => onChannel(event.channel), { once: true });
  try {
    await connection.setRemoteDescription({ type: 'offer', sdp });
    await connection.setLocalDescription(await connection.createAnswer());
    await waitForIceGathering(connection);
    const answer = connection.localDescription?.sdp;
    if (!validDirectSdp(answer)) {
      throw new Error('The direct presentation answer could not be created.');
    }
    return { connection, sdp: answer };
  } catch (error) {
    connection.close();
    throw error;
  }
}
