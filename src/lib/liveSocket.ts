import { Channel, type LiveWsEvent, tauriCommands } from './tauri';

/**
 * Minimal transport abstraction the live provider (`liveDocumentSession.ts`)
 * drives instead of a raw `WebSocket`. Two implementations back it:
 *
 * - {@link TauriLiveSocket}: the real desktop transport. The socket lives in the
 *   Rust backend (`commands/live_ws.rs`) so it reuses the connected server's TLS
 *   configuration, including the per-session untrusted-certificate opt-in. The
 *   webview's own `WebSocket` cannot reach a self-signed / hostname-mismatched
 *   server, which is why live co-editing failed against private servers while
 *   REST worked.
 * - {@link BrowserLiveSocket}: a thin wrapper over the platform `WebSocket`, used
 *   in the (non-Tauri) test environment so the existing provider tests keep
 *   exercising the handshake through a mockable `WebSocket`.
 *
 * The surface mirrors just the parts of the `WebSocket` API the provider uses.
 */

export const LIVE_SOCKET_CONNECTING = 0;
export const LIVE_SOCKET_OPEN = 1;
export const LIVE_SOCKET_CLOSED = 3;

export interface LiveSocketMessage {
  /** String for text control frames, ArrayBuffer for binary CRDT frames. */
  data: string | ArrayBuffer;
}

export interface LiveSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: LiveSocketMessage) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Live socket whose actual connection is held in the Rust backend. */
class TauriLiveSocket implements LiveSocket {
  readyState = LIVE_SOCKET_CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: LiveSocketMessage) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  private id: number | null = null;
  private closed = false;

  constructor(serverUrl: string, websocketUrl: string) {
    const channel = new Channel<LiveWsEvent>();
    channel.onmessage = (event) => this.handleEvent(event);
    tauriCommands
      .liveWsConnect(serverUrl, websocketUrl, channel)
      .then((id) => {
        if (this.closed) {
          // Closed before the connection resolved: tear the backend socket down.
          void tauriCommands.liveWsClose(id).catch(() => {});
          return;
        }
        this.id = id;
        this.readyState = LIVE_SOCKET_OPEN;
        this.onopen?.();
      })
      .catch(() => {
        // Mirror a native WebSocket connection failure (abnormal close) so the
        // provider falls back to REST / schedules a reconnect.
        this.readyState = LIVE_SOCKET_CLOSED;
        this.onerror?.();
        this.onclose?.({ code: 1006 });
      });
  }

  private handleEvent(event: LiveWsEvent) {
    if (this.closed) return;
    switch (event.type) {
      case 'text':
        this.onmessage?.({ data: event.data });
        break;
      case 'binary':
        this.onmessage?.({ data: base64ToArrayBuffer(event.data) });
        break;
      case 'closed':
        this.readyState = LIVE_SOCKET_CLOSED;
        // The backend socket ended on its own (server close / network drop).
        // Drop the backend registry entry so it does not leak across reconnects;
        // the provider opens a fresh socket for any reconnect.
        if (this.id !== null) {
          const id = this.id;
          this.id = null;
          void tauriCommands.liveWsClose(id).catch(() => {});
        }
        this.onclose?.({ code: event.code ?? undefined });
        break;
    }
  }

  send(data: string | Uint8Array): void {
    if (this.id === null || this.readyState !== LIVE_SOCKET_OPEN) return;
    if (typeof data === 'string') {
      void tauriCommands.liveWsSend(this.id, 'text', data).catch(() => {});
    } else {
      void tauriCommands.liveWsSend(this.id, 'binary', bytesToBase64(data)).catch(() => {});
    }
  }

  close(): void {
    this.closed = true;
    this.readyState = LIVE_SOCKET_CLOSED;
    if (this.id !== null) {
      const id = this.id;
      this.id = null;
      void tauriCommands.liveWsClose(id).catch(() => {});
    }
  }
}

/** Live socket backed by the platform `WebSocket` (test / non-Tauri path). */
class BrowserLiveSocket implements LiveSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: LiveSocketMessage) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  private socket: WebSocket;

  constructor(websocketUrl: string) {
    this.socket = new WebSocket(websocketUrl);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = () => this.onopen?.();
    this.socket.onmessage = (event) =>
      this.onmessage?.({ data: event.data as string | ArrayBuffer });
    this.socket.onclose = (event) => this.onclose?.({ code: (event as CloseEvent)?.code });
    this.socket.onerror = () => this.onerror?.();
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: string | Uint8Array): void {
    this.socket.send(data);
  }

  close(): void {
    this.socket.close();
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Creates a live socket for the resolved target. Uses the backend-proxied
 * transport in the desktop app (so TLS matches REST) and the plain-`WebSocket`
 * transport elsewhere (tests).
 */
export function createLiveSocket(serverUrl: string, websocketUrl: string): LiveSocket {
  if (isTauriRuntime()) return new TauriLiveSocket(serverUrl, websocketUrl);
  return new BrowserLiveSocket(websocketUrl);
}
