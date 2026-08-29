import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { openLiveNoteSession } from './liveDocumentSession';
import { type JsonObject, openLiveJsonSession, toShared } from './liveJsonDocument';
import { tauriCommands } from './tauri';
import type { VaultClient } from './vaultClient';

vi.mock('./tauri', () => ({
  tauriCommands: {
    hostedWsTicket: vi.fn(),
    replicaReadCrdtState: vi.fn().mockResolvedValue(null),
    replicaCacheCrdtState: vi.fn().mockResolvedValue(undefined),
    replicaClearCrdtState: vi.fn().mockResolvedValue(undefined),
  },
}));

/** Encode a Y.Doc whose `content` text holds `value`, as the replica would cache it. */
function seedBase64(value: string): string {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, value);
  return updateToBase64(Y.encodeStateAsUpdate(doc));
}

/** Encode a Y.Doc whose `doc` map holds `value`, as the structured replica would cache it. */
function seedJsonBase64(value: JsonObject): string {
  const doc = new Y.Doc();
  const root = doc.getMap<unknown>('doc');
  doc.transact(() => {
    for (const [key, child] of Object.entries(value)) root.set(key, toShared(child));
  });
  return updateToBase64(Y.encodeStateAsUpdate(doc));
}

function updateToBase64(update: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < update.length; i += 1) binary += String.fromCharCode(update[i]);
  return btoa(binary);
}

const SYNC_UPDATE = 2;
const AWARENESS = 3;
const HEADER_LEN = 17;
const FILE_ID = '00000000-0000-0000-0000-000000000001';

/** Controllable WebSocket stand-in (jsdom has no WebSocket). */
class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  binaryType = 'blob';
  readyState = MockWebSocket.CONNECTING;
  sent: Array<string | Uint8Array> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string | Uint8Array) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({});
  }

  // Test helpers
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}

function frame(tag: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(HEADER_LEN + payload.length);
  out[0] = tag;
  // file id bytes are not validated by the client; zero-fill is fine.
  out.set(payload, HEADER_LEN);
  return out.buffer;
}

function hostedClient(
  target: { serverUrl: string; vaultId: string; fileId: string } | null,
): VaultClient {
  return {
    resolveLiveSession: vi.fn().mockResolvedValue(target),
  } as unknown as VaultClient;
}

/** Drives the handshake to a connected session and returns it. */
async function connectSession() {
  vi.mocked(tauriCommands.hostedWsTicket).mockResolvedValue({
    ticket: 'ticket-1',
    websocketUrl: 'ws://server/ws/v1/vaults/v',
    protocolVersion: 1,
  });
  const client = hostedClient({ serverUrl: 'https://server', vaultId: 'v', fileId: FILE_ID });
  const promise = openLiveNoteSession(client, 'note.md');

  await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
  const socket = MockWebSocket.instances[0];
  socket.open();
  // Client authenticates first.
  expect(JSON.parse(socket.sent[0] as string)).toMatchObject({
    type: 'authenticate',
    ticket: 'ticket-1',
  });
  socket.emit(
    JSON.stringify({ type: 'ready', manifestSequence: 0, protocolVersion: 1, role: 'editor' }),
  );
  // Client subscribes after ready.
  expect(JSON.parse(socket.sent[1] as string)).toMatchObject({
    type: 'document.subscribe',
    fileId: FILE_ID,
  });
  socket.emit(JSON.stringify({ type: 'document.subscribed', fileId: FILE_ID }));
  // The provider is not ready until the server responds to its state-vector
  // request, preventing an empty local Y.Doc from binding over seeded content.
  socket.emit(frame(SYNC_UPDATE, new Uint8Array([0, 0])));

  const session = await promise;
  expect(session).not.toBeNull();
  return { session: session!, socket };
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.clearAllMocks();
  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
});

describe('openLiveNoteSession', () => {
  it('returns null for clients without live support (local vaults)', async () => {
    const client = {} as unknown as VaultClient;
    expect(await openLiveNoteSession(client, 'note.md')).toBeNull();
  });

  it('returns null when the target cannot be resolved', async () => {
    expect(await openLiveNoteSession(hostedClient(null), 'note.md')).toBeNull();
  });

  it('returns null when the socket never reaches a subscription (REST fallback)', async () => {
    vi.mocked(tauriCommands.hostedWsTicket).mockResolvedValue({
      ticket: 't',
      websocketUrl: 'ws://server/ws',
      protocolVersion: 1,
    });
    const client = hostedClient({ serverUrl: 'https://server', vaultId: 'v', fileId: FILE_ID });
    const promise = openLiveNoteSession(client, 'note.md');
    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    MockWebSocket.instances[0].open();
    // Server rejects authentication before any subscription.
    MockWebSocket.instances[0].emit(
      JSON.stringify({ type: 'error', code: 'authentication_invalid', message: 'no' }),
    );
    expect(await promise).toBeNull();
  });

  it('does not subscribe and falls back to REST when the server protocol version differs', async () => {
    vi.mocked(tauriCommands.hostedWsTicket).mockResolvedValue({
      ticket: 'ticket-1',
      websocketUrl: 'ws://server/ws/v1/vaults/v',
      protocolVersion: 1,
    });
    const client = hostedClient({ serverUrl: 'https://server', vaultId: 'v', fileId: FILE_ID });
    const promise = openLiveNoteSession(client, 'note.md');
    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const socket = MockWebSocket.instances[0];
    socket.open();
    expect(JSON.parse(socket.sent[0] as string)).toMatchObject({ type: 'authenticate' });
    // Server accepts a version this client does not speak.
    socket.emit(
      JSON.stringify({ type: 'ready', manifestSequence: 0, protocolVersion: 2, role: 'editor' }),
    );
    expect(await promise).toBeNull();
    const subscribed = socket.sent.some(
      (m) => typeof m === 'string' && JSON.parse(m).type === 'document.subscribe',
    );
    expect(subscribed).toBe(false);
  });

  it('does not reconnect after a fatal protocol_version_unsupported error', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(tauriCommands.hostedWsTicket).mockResolvedValue({
        ticket: 'ticket-1',
        websocketUrl: 'ws://server/ws/v1/vaults/v',
        protocolVersion: 1,
      });
      const client = hostedClient({ serverUrl: 'https://server', vaultId: 'v', fileId: FILE_ID });
      const promise = openLiveNoteSession(client, 'note.md');
      await vi.advanceTimersByTimeAsync(0); // flush the awaited ticket -> socket constructed
      expect(MockWebSocket.instances.length).toBe(1);
      MockWebSocket.instances[0].open();
      MockWebSocket.instances[0].emit(
        JSON.stringify({ type: 'error', code: 'protocol_version_unsupported', message: 'no' }),
      );
      expect(await promise).toBeNull();
      // Past the maximum reconnect backoff: a fatal version error must not retry.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(MockWebSocket.instances.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes the authenticate/subscribe handshake and exposes the document', async () => {
    const { session } = await connectSession();
    expect(session.getStatus()).toBe('connected');
    session.destroy();
  });

  it('does not expose the live session before the initial sync response arrives', async () => {
    vi.mocked(tauriCommands.hostedWsTicket).mockResolvedValue({
      ticket: 'ticket-1',
      websocketUrl: 'ws://server/ws/v1/vaults/v',
      protocolVersion: 1,
    });
    const client = hostedClient({ serverUrl: 'https://server', vaultId: 'v', fileId: FILE_ID });
    let resolved = false;
    const promise = openLiveNoteSession(client, 'note.md').then((session) => {
      resolved = true;
      return session;
    });
    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const socket = MockWebSocket.instances[0];
    socket.open();
    socket.emit(
      JSON.stringify({ type: 'ready', manifestSequence: 0, protocolVersion: 1, role: 'editor' }),
    );
    socket.emit(JSON.stringify({ type: 'document.subscribed', fileId: FILE_ID }));

    await Promise.resolve();
    expect(resolved).toBe(false);

    const seeded = new Y.Doc();
    seeded.getText('content').insert(0, 'existing body');
    socket.emit(frame(SYNC_UPDATE, Y.encodeStateAsUpdate(seeded)));
    const session = await promise;
    expect(session?.text.toString()).toBe('existing body');
    session?.destroy();
  });

  it('applies remote CRDT updates into the shared document', async () => {
    const { session, socket } = await connectSession();
    const remote = new Y.Doc();
    remote.getText('content').insert(0, 'hello world');
    const update = Y.encodeStateAsUpdate(remote);
    socket.emit(frame(SYNC_UPDATE, update));
    expect(session.text.toString()).toBe('hello world');
    session.destroy();
  });

  it('sends local edits as CRDT update frames without echoing remote ones', async () => {
    const { session, socket } = await connectSession();

    // A remote update must not be re-sent back to the server.
    const remote = new Y.Doc();
    remote.getText('content').insert(0, 'abc');
    const sentBefore = socket.sent.filter(
      (d) => d instanceof Uint8Array && d[0] === SYNC_UPDATE,
    ).length;
    socket.emit(frame(SYNC_UPDATE, Y.encodeStateAsUpdate(remote)));
    const sentAfterRemote = socket.sent.filter(
      (d) => d instanceof Uint8Array && d[0] === SYNC_UPDATE,
    ).length;
    expect(sentAfterRemote).toBe(sentBefore);

    // A local edit is broadcast as a binary update frame.
    session.text.insert(session.text.length, '!');
    const localFrames = socket.sent.filter((d) => d instanceof Uint8Array && d[0] === SYNC_UPDATE);
    expect(localFrames.length).toBe(sentAfterRemote + 1);
    session.destroy();
  });

  it('relays local awareness and applies remote awareness without echoing it', async () => {
    const { session, socket } = await connectSession();
    const awarenessFrames = () =>
      socket.sent.filter((data) => data instanceof Uint8Array && data[0] === AWARENESS);

    const sentBeforeLocal = awarenessFrames().length;
    session.awareness.setLocalStateField('user', { id: 'local', name: 'Alice' });
    expect(awarenessFrames().length).toBe(sentBeforeLocal + 1);

    const remoteDoc = new Y.Doc();
    const remoteAwareness = new Awareness(remoteDoc);
    remoteAwareness.setLocalStateField('user', { id: 'remote', name: 'Bob' });
    const remoteUpdate = encodeAwarenessUpdate(remoteAwareness, [remoteDoc.clientID]);
    const sentBeforeRemote = awarenessFrames().length;

    socket.emit(frame(AWARENESS, remoteUpdate));

    expect(session.awareness.getStates().get(remoteDoc.clientID)).toMatchObject({
      user: { id: 'remote', name: 'Bob' },
    });
    expect(awarenessFrames().length).toBe(sentBeforeRemote);

    remoteAwareness.destroy();
    remoteDoc.destroy();
    session.destroy();
  });

  it('ignores malformed peer awareness without interrupting the session', async () => {
    const { session, socket } = await connectSession();

    expect(() => socket.emit(frame(AWARENESS, new Uint8Array([255])))).not.toThrow();
    expect(session.getStatus()).toBe('connected');

    session.text.insert(0, 'still live');
    expect(socket.sent.some((data) => data instanceof Uint8Array && data[0] === SYNC_UPDATE)).toBe(
      true,
    );
    session.destroy();
  });
});

/** Drives the handshake to a connected structured (JSON) session. */
async function connectJsonSession() {
  vi.mocked(tauriCommands.hostedWsTicket).mockResolvedValue({
    ticket: 'ticket-1',
    websocketUrl: 'ws://server/ws/v1/vaults/v',
    protocolVersion: 1,
  });
  const client = hostedClient({ serverUrl: 'https://server', vaultId: 'v', fileId: FILE_ID });
  const promise = openLiveJsonSession(client, 'Boards/test.kanban');

  await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
  const socket = MockWebSocket.instances[0];
  socket.open();
  socket.emit(
    JSON.stringify({ type: 'ready', manifestSequence: 0, protocolVersion: 1, role: 'editor' }),
  );
  socket.emit(JSON.stringify({ type: 'document.subscribed', fileId: FILE_ID }));
  socket.emit(frame(SYNC_UPDATE, new Uint8Array([0, 0])));

  const session = await promise;
  expect(session).not.toBeNull();
  return { session: session!, socket };
}

describe('openLiveJsonSession offline replica reconnect sync', () => {
  it('seeds the structured document from the replica before connecting', async () => {
    vi.mocked(tauriCommands.replicaReadCrdtState).mockResolvedValue(
      seedJsonBase64({ columns: [{ id: 'c1', name: 'To Do', cards: [] }] }),
    );
    const { session } = await connectJsonSession();
    // The seeded offline board survives the empty server handshake update.
    expect(session.readJson()).toEqual({ columns: [{ id: 'c1', name: 'To Do', cards: [] }] });
    session.destroy();
  });

  it('discards the offline state and skips persist-on-destroy when rejected', async () => {
    vi.mocked(tauriCommands.replicaReadCrdtState).mockResolvedValue(
      seedJsonBase64({ columns: [{ id: 'c1', name: 'Stale', cards: [] }] }),
    );
    const { session } = await connectJsonSession();

    session.discardOfflineState();
    expect(tauriCommands.replicaClearCrdtState).toHaveBeenCalledWith(
      'https://server',
      'v',
      FILE_ID,
    );

    vi.mocked(tauriCommands.replicaCacheCrdtState).mockClear();
    session.destroy();
    // A discarded (degenerate) seed must not be flushed back to the replica.
    expect(tauriCommands.replicaCacheCrdtState).not.toHaveBeenCalled();
  });
});

describe('openLiveNoteSession offline replica reconnect sync', () => {
  it('seeds the document from the replica before connecting so offline edits reconcile', async () => {
    vi.mocked(tauriCommands.replicaReadCrdtState).mockResolvedValue(seedBase64('offline edit'));
    const { session } = await connectSession();
    // The seeded offline content is present in the merged document; the empty
    // server update from the handshake did not clobber it.
    expect(session.text.toString()).toBe('offline edit');
    session.destroy();
  });

  it('persists merged CRDT state to the offline replica after a local edit', async () => {
    vi.mocked(tauriCommands.replicaReadCrdtState).mockResolvedValue(null);
    const { session } = await connectSession();

    session.text.insert(0, 'typed offline');
    await vi.waitFor(() => expect(tauriCommands.replicaCacheCrdtState).toHaveBeenCalled(), {
      timeout: 2000,
    });
    const calls = vi.mocked(tauriCommands.replicaCacheCrdtState).mock.calls;
    const call = calls[calls.length - 1];
    expect(call[0]).toBe('https://server');
    expect(call[1]).toBe('v');
    expect(call[2]).toBe(FILE_ID);
    expect(typeof call[3]).toBe('string');
    session.destroy();
  });
});
