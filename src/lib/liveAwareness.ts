import { useEffect, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type { LiveDocumentHandle } from './liveDocumentSession';

/**
 * Shared consumption side of the Phase 5 ephemeral awareness relay.
 *
 * The live providers in `liveDocumentSession.ts` relay y-protocols awareness
 * states per subscribed document. Each editor publishes its effective identity
 * (`user`), document context (`document`), and any rich per-document interaction
 * fields (`kanban`/`canvas`). This module is the read side: it turns the raw
 * awareness state map into typed remote-peer lists for UI rendering. Awareness
 * is live-only and is never persisted as document content.
 */

/** Effective collaboration identity published by every live editor. */
export interface LiveAwarenessUser {
  id: string;
  name: string;
  color: string;
}

/** Document context so a peer state can be matched to the right document. */
export interface LiveAwarenessDocument {
  kind: 'note' | 'kanban' | 'canvas' | 'logic' | 'sheet';
  relativePath: string;
}

/** Rich Kanban interaction fields (the card a peer currently has open). */
export interface KanbanInteraction {
  /** Card the peer currently has open in the card dialog. */
  editingCardId?: string | null;
}

/** Rich canvas interaction fields (selection/viewport awareness). */
export interface CanvasInteraction {
  selectedNodeIds?: string[];
}

/** Rich sheet interaction fields, expressed with stable document identities. */
export interface SheetInteraction {
  worksheetId: string;
  activeCell?: { rowId: string; columnId: string };
  ranges?: Array<{
    startRowId: string;
    startColumnId: string;
    endRowId: string;
    endColumnId: string;
  }>;
}

/** The full ephemeral state a peer publishes for one document. */
export interface LiveAwarenessState {
  user?: LiveAwarenessUser;
  document?: LiveAwarenessDocument;
  kanban?: KanbanInteraction;
  canvas?: CanvasInteraction;
  sheet?: SheetInteraction;
}

/** A remote peer's awareness state keyed by its Yjs client id. */
export interface LivePeer extends LiveAwarenessState {
  clientId: number;
}

/**
 * Reads remote peers from an awareness instance, excluding the local client and
 * any state that has not yet published an identity. Pure, so it can be reused
 * outside React (tests, non-hook consumers).
 */
export function readRemotePeers(awareness: Awareness): LivePeer[] {
  const localClientId = awareness.clientID;
  const peers: LivePeer[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === localClientId) return;
    const typed = state as LiveAwarenessState | undefined;
    if (!typed || !typed.user) return;
    peers.push({ clientId, ...typed });
  });
  return peers;
}

/**
 * Collapses multiple client ids belonging to the same user (e.g. several open
 * tabs) into a single entry, keyed by user id. Keeps the first-seen state so a
 * presence strip shows each person once.
 */
export function dedupePeersByUser(peers: LivePeer[]): LivePeer[] {
  const byUser = new Map<string, LivePeer>();
  for (const peer of peers) {
    const id = peer.user?.id;
    if (!id) continue;
    if (!byUser.has(id)) byUser.set(id, peer);
  }
  return [...byUser.values()];
}

/**
 * Builds a `cardId -> editor` map from live peers for Kanban "being edited by X"
 * indicators. When several peers report the same card open, the last one in the
 * list wins (the map is small and the indicator only needs one face).
 */
export function buildKanbanCardEditors(peers: LivePeer[]): Map<string, LiveAwarenessUser> {
  const map = new Map<string, LiveAwarenessUser>();
  for (const peer of peers) {
    const cardId = peer.kanban?.editingCardId;
    if (cardId && peer.user) map.set(cardId, peer.user);
  }
  return map;
}

type AwarenessSource = LiveDocumentHandle | { awareness: Awareness } | null | undefined;

/**
 * Subscribes to an awareness instance and returns the current remote peers,
 * re-rendering whenever any peer's ephemeral state changes. Returns an empty
 * list when no live session is available (local vaults, REST fallback).
 */
export function useLivePeers(source: AwarenessSource): LivePeer[] {
  const awareness = source?.awareness ?? null;
  const [peers, setPeers] = useState<LivePeer[]>(() =>
    awareness ? readRemotePeers(awareness) : [],
  );

  useEffect(() => {
    if (!awareness) {
      setPeers([]);
      return;
    }
    const sync = () => setPeers(readRemotePeers(awareness));
    sync();
    awareness.on('change', sync);
    return () => awareness.off('change', sync);
  }, [awareness]);

  return peers;
}
