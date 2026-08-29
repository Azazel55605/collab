import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  buildKanbanCardEditors,
  dedupePeersByUser,
  type LivePeer,
  readRemotePeers,
  useLivePeers,
} from './liveAwareness';

function makeAwarenessPair() {
  // Two awareness instances over separate docs, manually cross-fed, to emulate
  // remote peers without a real socket.
  const localDoc = new Y.Doc();
  const local = new Awareness(localDoc);
  const remoteDoc = new Y.Doc();
  const remote = new Awareness(remoteDoc);
  return { local, remote };
}

function inject(target: Awareness, clientId: number, state: Record<string, unknown>) {
  // Reach into the awareness state map the way applyAwarenessUpdate would.
  const states = target.getStates();
  states.set(clientId, state);
  target.emit('change', [{ added: [clientId], updated: [], removed: [] }, 'test']);
}

describe('readRemotePeers', () => {
  it('excludes the local client and identity-less states', () => {
    const { local } = makeAwarenessPair();
    local.setLocalStateField('user', { id: 'me', name: 'Me', color: '#fff' });
    inject(local, 101, { user: { id: 'a', name: 'Ann', color: '#f00' } });
    inject(local, 102, { document: { kind: 'note', relativePath: 'x.md' } }); // no user

    const peers = readRemotePeers(local);
    expect(peers.map((p) => p.user?.id)).toEqual(['a']);
    expect(peers[0].clientId).toBe(101);
  });
});

describe('dedupePeersByUser', () => {
  it('keeps one entry per user id', () => {
    const peers: LivePeer[] = [
      { clientId: 1, user: { id: 'a', name: 'Ann', color: '#f00' } },
      { clientId: 2, user: { id: 'a', name: 'Ann', color: '#f00' } },
      { clientId: 3, user: { id: 'b', name: 'Bob', color: '#0f0' } },
    ];
    expect(dedupePeersByUser(peers).map((p) => p.user?.id)).toEqual(['a', 'b']);
  });
});

describe('buildKanbanCardEditors', () => {
  it('maps each open card to its editing peer and ignores peers with no open card', () => {
    const peers: LivePeer[] = [
      {
        clientId: 1,
        user: { id: 'a', name: 'Ann', color: '#f00' },
        kanban: { editingCardId: 'c1' },
      },
      {
        clientId: 2,
        user: { id: 'b', name: 'Bob', color: '#0f0' },
        kanban: { editingCardId: null },
      },
      { clientId: 3, user: { id: 'c', name: 'Cy', color: '#00f' } },
    ];
    const map = buildKanbanCardEditors(peers);
    expect(map.size).toBe(1);
    expect(map.get('c1')?.name).toBe('Ann');
  });

  it('last peer wins when two report the same card', () => {
    const peers: LivePeer[] = [
      {
        clientId: 1,
        user: { id: 'a', name: 'Ann', color: '#f00' },
        kanban: { editingCardId: 'c1' },
      },
      {
        clientId: 2,
        user: { id: 'b', name: 'Bob', color: '#0f0' },
        kanban: { editingCardId: 'c1' },
      },
    ];
    expect(buildKanbanCardEditors(peers).get('c1')?.name).toBe('Bob');
  });
});

describe('useLivePeers', () => {
  it('returns [] when no awareness source is given', () => {
    const { result } = renderHook(() => useLivePeers(null));
    expect(result.current).toEqual([]);
  });

  it('tracks remote peer changes', () => {
    const { local } = makeAwarenessPair();
    const { result } = renderHook(() => useLivePeers({ awareness: local }));
    expect(result.current).toEqual([]);

    act(() =>
      inject(local, 200, {
        user: { id: 'a', name: 'Ann', color: '#f00' },
        kanban: { editingCardId: 'c1' },
      }),
    );
    expect(result.current).toHaveLength(1);
    expect(result.current[0].kanban?.editingCardId).toBe('c1');
  });
});
