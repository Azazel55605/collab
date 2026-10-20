import type { LiveDocumentHandle } from '../liveDocumentSession';
import { connectLiveProvider } from '../liveDocumentSession';
import type { LiveTarget } from '../liveDocumentSession';
import type { VaultClient } from '../vaultClient';

import { DECK_ROOT_MAP, readDeck, reconcileDeck } from './liveDeckDocument';

/** Origin of this client's own writes, so they are not reported back as remote. */

export interface LiveDeckSession extends LiveDocumentHandle {
  /** Stable hosted identity used to advertise this show to the same account. */
  readonly target: LiveTarget;
  /** The live deck as plain JSON, or null while the room is empty. */
  readDeck(): Record<string, unknown> | null;
  /** A local edit: the whole next deck, reconciled into the live state. */
  writeDeck(deck: object): void;
  /** Remote and seeded changes (never this client's own writes). */
  onChange(callback: (deck: Record<string, unknown>) => void): () => void;
}

/**
 * Opens a hosted `.deck` as one live, offline-backed Yjs session: the normal
 * ticket, state-vector handshake, offline replica, and reconnect merge, with
 * the deck codec (`liveDeckDocument.ts`) over the structured root.
 */
export async function openLiveDeckSession(
  client: VaultClient,
  relativePath: string,
): Promise<LiveDeckSession | null> {
  const provider = await connectLiveProvider(client, relativePath, { offlineReplica: true });
  if (!provider) return null;
  const paneOrigin = Symbol('live-deck-local');
  const doc = provider.doc;
  const root = doc.getMap<unknown>(DECK_ROOT_MAP);
  return {
    ...provider.handle(),
    target: provider.connectionTarget(),
    readDeck: () => readDeck(doc),
    writeDeck: (deck) => reconcileDeck(doc, deck, paneOrigin),
    onChange: (callback) => {
      // Many remote updates can land in one burst; decode once per frame.
      let scheduled = false;
      const flush = () => {
        scheduled = false;
        const deck = readDeck(doc);
        if (deck) callback(deck);
      };
      const observer = (_events: unknown, transaction: { origin: unknown }) => {
        if (transaction.origin === paneOrigin || scheduled) return;
        scheduled = true;
        queueMicrotask(flush);
      };
      root.observeDeep(observer);
      return () => root.unobserveDeep(observer);
    },
  };
}
