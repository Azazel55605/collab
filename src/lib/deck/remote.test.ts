import { describe, expect, it } from 'vitest';

import type { LivePeer } from '../liveAwareness';

import {
  appendRemoteCommand,
  presentingShows,
  remotableShows,
  REMOTE_COMMAND_WINDOW,
  remoteCommandAction,
  takeRemoteCommands,
} from './remote';

const SHOW = { id: 'show-1', userId: 'me', allowed: true };

function phone(clientId: number, userId: string, remote: LivePeer['deck']): LivePeer {
  return {
    clientId,
    user: { id: userId, name: userId, color: '#000' },
    document: { kind: 'deck', relativePath: 'Talk.deck' },
    deck: remote,
  };
}

describe('remote control protocol', () => {
  it('numbers commands per show and keeps a bounded window', () => {
    let state = appendRemoteCommand(null, 'show-1', 'next');
    state = appendRemoteCommand(state, 'show-1', 'goto', 4);
    expect(state.commands).toEqual([
      { seq: 1, action: 'next' },
      { seq: 2, action: 'goto', index: 4 },
    ]);
    // A new show starts again from one.
    expect(appendRemoteCommand(state, 'show-2', 'previous').commands).toEqual([
      { seq: 1, action: 'previous' },
    ]);
    for (let i = 0; i < 20; i += 1) state = appendRemoteCommand(state, 'show-1', 'next');
    expect(state.commands).toHaveLength(REMOTE_COMMAND_WINDOW);
    expect(state.commands[state.commands.length - 1].seq).toBe(22);
  });

  it('maps commands to playback actions and rejects a bad goto', () => {
    expect(remoteCommandAction({ seq: 1, action: 'next' })).toEqual({ type: 'next' });
    expect(remoteCommandAction({ seq: 1, action: 'black' })).toEqual({
      type: 'blank',
      blank: 'black',
    });
    expect(remoteCommandAction({ seq: 1, action: 'goto', index: 2 })).toEqual({
      type: 'goto',
      index: 2,
    });
    expect(remoteCommandAction({ seq: 1, action: 'goto', index: -1 })).toBeNull();
    expect(remoteCommandAction({ seq: 1, action: 'goto' })).toBeNull();
  });

  it('applies each command once, in order, across bursts', () => {
    let remote = appendRemoteCommand(null, 'show-1', 'next');
    remote = appendRemoteCommand(remote, 'show-1', 'next');
    const first = takeRemoteCommands([phone(7, 'me', { targetId: null, remote })], SHOW, new Map());
    expect(first.commands.map((c) => c.seq)).toEqual([1, 2]);
    // The same state again applies nothing; a later command applies alone.
    expect(
      takeRemoteCommands([phone(7, 'me', { targetId: null, remote })], SHOW, first.applied)
        .commands,
    ).toEqual([]);
    remote = appendRemoteCommand(remote, 'show-1', 'previous');
    const second = takeRemoteCommands(
      [phone(7, 'me', { targetId: null, remote })],
      SHOW,
      first.applied,
    );
    expect(second.commands).toEqual([{ seq: 3, action: 'previous' }]);
  });

  it('ignores other accounts, other shows, and commands sent while remote control is off', () => {
    const remote = appendRemoteCommand(null, 'show-1', 'next');
    expect(
      takeRemoteCommands([phone(7, 'someone-else', { targetId: null, remote })], SHOW, new Map())
        .commands,
    ).toEqual([]);
    const stale = appendRemoteCommand(null, 'show-0', 'next');
    expect(
      takeRemoteCommands([phone(7, 'me', { targetId: null, remote: stale })], SHOW, new Map())
        .commands,
    ).toEqual([]);
    const off = takeRemoteCommands(
      [phone(7, 'me', { targetId: null, remote })],
      { ...SHOW, allowed: false },
      new Map(),
    );
    expect(off.commands).toEqual([]);
    // Consumed, so turning remote control on later does not replay it.
    expect(
      takeRemoteCommands([phone(7, 'me', { targetId: null, remote })], SHOW, off.applied).commands,
    ).toEqual([]);
  });

  it('lists shows a device may drive or follow', () => {
    const show = {
      id: 'show-1',
      slideId: 's1',
      position: 1,
      total: 3,
      blank: null,
      remote: true,
    };
    const peers = [
      phone(1, 'me', { targetId: 's1', presenting: true, show }),
      phone(2, 'other', { targetId: 's1', presenting: true, show: { ...show, id: 'show-2' } }),
      phone(3, 'me', { targetId: 's1', presenting: true, show: { ...show, remote: false } }),
      phone(4, 'me', { targetId: 's1' }),
    ];
    expect(remotableShows(peers, 'me', 'Talk.deck').map((entry) => entry.clientId)).toEqual([1]);
    expect(remotableShows(peers, 'me', 'Other.deck')).toEqual([]);
    expect(presentingShows(peers, 'Talk.deck').map((entry) => entry.clientId)).toEqual([1, 2, 3]);
  });
});
