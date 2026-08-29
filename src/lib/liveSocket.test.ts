import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLiveSocket, LIVE_SOCKET_CLOSED, LIVE_SOCKET_OPEN } from './liveSocket';

const mocks = vi.hoisted(() => {
  class FakeChannel<T> {
    static instances: FakeChannel<unknown>[] = [];
    onmessage: ((message: T) => void) | null = null;
    constructor() {
      FakeChannel.instances.push(this as FakeChannel<unknown>);
    }
    emit(message: T) {
      this.onmessage?.(message);
    }
  }
  return {
    FakeChannel,
    liveWsConnect: vi.fn(),
    liveWsSend: vi.fn().mockResolvedValue(undefined),
    liveWsClose: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('./tauri', () => ({
  Channel: mocks.FakeChannel,
  tauriCommands: {
    liveWsConnect: mocks.liveWsConnect,
    liveWsSend: mocks.liveWsSend,
    liveWsClose: mocks.liveWsClose,
  },
}));

function enableTauri() {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
}

describe('createLiveSocket (Tauri transport)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.FakeChannel.instances = [];
    enableTauri();
  });

  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('connects through the backend and reuses the server URL + ws URL', async () => {
    mocks.liveWsConnect.mockResolvedValue(7);
    const socket = createLiveSocket('https://srv', 'wss://srv/ws/v1/vaults/v');
    const opened = vi.fn();
    socket.onopen = opened;

    expect(mocks.liveWsConnect).toHaveBeenCalledWith(
      'https://srv',
      'wss://srv/ws/v1/vaults/v',
      expect.any(mocks.FakeChannel),
    );

    await vi.waitFor(() => expect(socket.readyState).toBe(LIVE_SOCKET_OPEN));
    expect(opened).toHaveBeenCalled();
  });

  it('routes text and binary sends to the backend with the right kind', async () => {
    mocks.liveWsConnect.mockResolvedValue(3);
    const socket = createLiveSocket('https://srv', 'wss://srv/ws');
    await vi.waitFor(() => expect(socket.readyState).toBe(LIVE_SOCKET_OPEN));

    socket.send('hello');
    socket.send(new Uint8Array([1, 2, 3]));

    expect(mocks.liveWsSend).toHaveBeenCalledWith(3, 'text', 'hello');
    expect(mocks.liveWsSend).toHaveBeenCalledWith(3, 'binary', btoa('\x01\x02\x03'));
  });

  it('delivers inbound text/binary frames and close through the channel', async () => {
    mocks.liveWsConnect.mockResolvedValue(1);
    const socket = createLiveSocket('https://srv', 'wss://srv/ws');
    const messages: Array<string | ArrayBuffer> = [];
    socket.onmessage = (event) => messages.push(event.data);
    const closed = vi.fn();
    socket.onclose = closed;
    await vi.waitFor(() => expect(socket.readyState).toBe(LIVE_SOCKET_OPEN));

    const channel = mocks.FakeChannel.instances[0];
    channel.emit({ type: 'text', data: '{"type":"ready"}' });
    channel.emit({ type: 'binary', data: btoa('\x02\x00') });
    channel.emit({ type: 'closed', code: 1006 });

    expect(messages[0]).toBe('{"type":"ready"}');
    expect(new Uint8Array(messages[1] as ArrayBuffer)).toEqual(new Uint8Array([2, 0]));
    expect(closed).toHaveBeenCalledWith({ code: 1006 });
    expect(socket.readyState).toBe(LIVE_SOCKET_CLOSED);
  });

  it('surfaces a failed backend connect as an abnormal close (REST fallback)', async () => {
    mocks.liveWsConnect.mockRejectedValue(new Error('tls'));
    const socket = createLiveSocket('https://srv', 'wss://srv/ws');
    const closed = vi.fn();
    socket.onclose = closed;

    await vi.waitFor(() => expect(closed).toHaveBeenCalledWith({ code: 1006 }));
    expect(socket.readyState).toBe(LIVE_SOCKET_CLOSED);
  });

  it('closes the backend socket via live_ws_close', async () => {
    mocks.liveWsConnect.mockResolvedValue(9);
    const socket = createLiveSocket('https://srv', 'wss://srv/ws');
    await vi.waitFor(() => expect(socket.readyState).toBe(LIVE_SOCKET_OPEN));
    socket.close();
    expect(mocks.liveWsClose).toHaveBeenCalledWith(9);
    expect(socket.readyState).toBe(LIVE_SOCKET_CLOSED);
  });
});
