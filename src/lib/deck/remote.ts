/**
 * Remote control of a running slide show from another of the presenter's own
 * devices (the Android companion), over the live awareness relay.
 *
 * Awareness carries state, not events, and a receiver can see only the latest
 * state after a burst. So a remote publishes its last few commands, each with
 * a sequence number, and the presenter applies every command it has not yet
 * applied. Commands name the show they are for (a fresh id per show), so a
 * command sent to an earlier show is never replayed into a new one.
 *
 * Trust: the presenter accepts commands only while it has opted in, and only
 * from peers signed in as the same account. The relay already limits a room to
 * members of the vault; this keeps another member from driving someone's show.
 * Nothing here writes to the deck.
 */
import type {
  DeckRemoteAction,
  DeckRemoteCommand,
  DeckRemoteState,
  DeckShowState,
  LivePeer,
} from '../liveAwareness';

import type { PlaybackAction } from './playback';

/** How many recent commands a remote keeps published. */
export const REMOTE_COMMAND_WINDOW = 8;

export function newShowId(random: () => number = Math.random): string {
  return `show-${Date.now().toString(36)}-${Math.floor(random() * 1e9).toString(36)}`;
}

/** The playback action a remote command stands for. */
export function remoteCommandAction(command: DeckRemoteCommand): PlaybackAction | null {
  switch (command.action) {
    case 'next':
    case 'previous':
    case 'first':
    case 'last':
      return { type: command.action };
    case 'goto':
      return Number.isInteger(command.index) && (command.index ?? -1) >= 0
        ? { type: 'goto', index: command.index! }
        : null;
    case 'black':
    case 'white':
      return { type: 'blank', blank: command.action };
    default:
      return null;
  }
}

/** The next published remote state after sending `action`. */
export function appendRemoteCommand(
  previous: DeckRemoteState | null,
  showId: string,
  action: DeckRemoteAction,
  index?: number,
): DeckRemoteState {
  const commands = previous?.showId === showId ? previous.commands : [];
  const seq = (commands[commands.length - 1]?.seq ?? 0) + 1;
  const command: DeckRemoteCommand = action === 'goto' ? { seq, action, index } : { seq, action };
  return {
    ...(previous?.showId === showId ? previous : {}),
    showId,
    commands: [...commands, command].slice(-REMOTE_COMMAND_WINDOW),
  };
}

/**
 * Commands to apply now, in order, and the advanced per-peer cursors.
 * `applied` maps a peer's client id to the last sequence applied from it.
 */
export function takeRemoteCommands(
  peers: readonly LivePeer[],
  show: { id: string; userId: string; allowed: boolean },
  applied: ReadonlyMap<number, number>,
): { commands: DeckRemoteCommand[]; applied: Map<number, number> } {
  const next = new Map(applied);
  const commands: DeckRemoteCommand[] = [];
  for (const peer of peers) {
    const remote = peer.deck?.remote;
    if (!remote || remote.showId !== show.id) continue;
    if (!peer.user || peer.user.id !== show.userId) continue;
    const last = next.get(peer.clientId) ?? 0;
    let cursor = last;
    for (const command of remote.commands ?? []) {
      if (!Number.isInteger(command?.seq) || command.seq <= cursor) continue;
      commands.push(command);
      cursor = command.seq;
    }
    if (cursor !== last) next.set(peer.clientId, cursor);
  }
  // Commands sent while remote control is off are consumed, not queued, so
  // turning it on never replays them.
  return { commands: show.allowed ? commands : [], applied: next };
}

/** A show this device may drive: one the same account is presenting with remote on. */
export interface RemotableShow {
  clientId: number;
  name: string;
  show: DeckShowState;
}

export function remotableShows(
  peers: readonly LivePeer[],
  userId: string,
  relativePath: string,
): RemotableShow[] {
  return peers
    .filter(
      (peer) =>
        peer.user?.id === userId &&
        peer.document?.kind === 'deck' &&
        peer.document.relativePath === relativePath &&
        peer.deck?.presenting &&
        peer.deck.show?.remote,
    )
    .map((peer) => ({ clientId: peer.clientId, name: peer.user!.name, show: peer.deck!.show! }));
}

/** Any peer presenting this deck, remote or not, for a "following" view. */
export function presentingShows(peers: readonly LivePeer[], relativePath: string): RemotableShow[] {
  return peers
    .filter(
      (peer) =>
        peer.user &&
        peer.document?.kind === 'deck' &&
        peer.document.relativePath === relativePath &&
        peer.deck?.presenting &&
        peer.deck.show,
    )
    .map((peer) => ({ clientId: peer.clientId, name: peer.user!.name, show: peer.deck!.show! }));
}
