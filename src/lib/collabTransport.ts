import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ChatMessage, PresenceEntry, SnapshotMeta } from '../types/collab';
import { tauriCommands } from './tauri';

export type Unsubscribe = () => void;

/**
 * All collab I/O goes through this interface.
 *
 * FileSystemTransport (this file) wraps Tauri commands and file-watcher events.
 * A future WebSocketTransport can replace it by implementing this same interface —
 * CollabProvider only needs to change which concrete class it instantiates.
 */
export interface CollabTransport {
  broadcastPresence(entry: PresenceEntry): Promise<void>;
  readPresence(): Promise<PresenceEntry[]>;

  sendChatMessage(msg: ChatMessage): Promise<void>;
  readChatMessages(limit: number): Promise<ChatMessage[]>;

  createSnapshot(
    relativePath: string,
    content: string,
    authorId: string,
    authorName: string,
    label?: string,
  ): Promise<SnapshotMeta>;
  listSnapshots(relativePath: string): Promise<SnapshotMeta[]>;
  readSnapshot(relativePath: string, snapshotId: string): Promise<string>;

  onPresenceChanged(cb: () => void): Unsubscribe;
  onChatUpdated(cb: () => void): Unsubscribe;
}

export class FileSystemTransport implements CollabTransport {
  constructor(private vaultPath: string) {}

  broadcastPresence(entry: PresenceEntry) {
    return tauriCommands.writePresence(this.vaultPath, entry.userId, entry);
  }

  readPresence() {
    return tauriCommands.readAllPresence(this.vaultPath);
  }

  sendChatMessage(msg: ChatMessage) {
    return tauriCommands.sendChatMessage(this.vaultPath, msg);
  }

  readChatMessages(limit: number) {
    return tauriCommands.readChatMessages(this.vaultPath, limit);
  }

  createSnapshot(
    relativePath: string,
    content: string,
    authorId: string,
    authorName: string,
    label?: string,
  ) {
    return tauriCommands.createSnapshot(this.vaultPath, relativePath, content, authorId, authorName, label);
  }

  listSnapshots(relativePath: string) {
    return tauriCommands.listSnapshots(this.vaultPath, relativePath);
  }

  readSnapshot(relativePath: string, snapshotId: string) {
    return tauriCommands.readSnapshot(this.vaultPath, relativePath, snapshotId);
  }

  onPresenceChanged(cb: () => void): Unsubscribe {
    let unsub: UnlistenFn | undefined;
    listen('collab:presence-changed', cb).then((u) => { unsub = u; });
    return () => unsub?.();
  }

  onChatUpdated(cb: () => void): Unsubscribe {
    let unsub: UnlistenFn | undefined;
    listen('collab:chat-updated', cb).then((u) => { unsub = u; });
    return () => unsub?.();
  }
}
