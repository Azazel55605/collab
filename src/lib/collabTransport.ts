import type { ChatMessage, PresenceEntry } from '../types/collab';
import type { HostedVaultMeta, VaultConfig, VaultMeta } from '../types/vault';

import { subscribeBackgroundPoll } from './backgroundPolls';
import { listenSafely } from './nativeSubscription';
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
  clearPresence(userId: string): Promise<void>;

  sendChatMessage(msg: ChatMessage): Promise<void>;
  readChatMessages(limit: number): Promise<ChatMessage[]>;
  readVaultConfig(): Promise<VaultConfig>;

  onPresenceChanged(cb: () => void): Unsubscribe;
  onChatUpdated(cb: () => void): Unsubscribe;
  onConfigChanged(cb: () => void): Unsubscribe;
}

export class FileSystemTransport implements CollabTransport {
  constructor(private vaultPath: string) {}

  broadcastPresence(entry: PresenceEntry) {
    return tauriCommands.writePresence(this.vaultPath, entry.userId, entry);
  }

  readPresence() {
    return tauriCommands.readAllPresence(this.vaultPath);
  }

  clearPresence(userId: string) {
    return tauriCommands.clearPresence(this.vaultPath, userId);
  }

  sendChatMessage(msg: ChatMessage) {
    return tauriCommands.sendChatMessage(this.vaultPath, msg);
  }

  readChatMessages(limit: number) {
    return tauriCommands.readChatMessages(this.vaultPath, limit);
  }

  readVaultConfig() {
    return tauriCommands.getVaultConfig(this.vaultPath);
  }

  onPresenceChanged(cb: () => void): Unsubscribe {
    return listenSafely('collab:presence-changed', cb);
  }

  onChatUpdated(cb: () => void): Unsubscribe {
    return listenSafely('collab:chat-updated', cb);
  }

  onConfigChanged(cb: () => void): Unsubscribe {
    return listenSafely('collab:config-changed', cb);
  }
}

export class HostedServerTransport implements CollabTransport {
  constructor(private vault: HostedVaultMeta) {}

  async broadcastPresence(entry: PresenceEntry) {
    await tauriCommands.hostedVaultRequest<void>(
      this.vault.serverUrl,
      'PUT',
      `/api/v1/vaults/${this.vault.hostedVaultId}/presence`,
      {
        activeFile: entry.activeFile,
        cursorLine: entry.cursorLine,
        chatTypingUntil: entry.chatTypingUntil,
        appVersion: entry.appVersion,
      },
    );
  }

  readPresence() {
    return tauriCommands.hostedVaultRequest<PresenceEntry[]>(
      this.vault.serverUrl,
      'GET',
      `/api/v1/vaults/${this.vault.hostedVaultId}/presence`,
    );
  }

  async clearPresence(_userId: string) {
    await tauriCommands.hostedVaultRequest<void>(
      this.vault.serverUrl,
      'DELETE',
      `/api/v1/vaults/${this.vault.hostedVaultId}/presence`,
    );
  }

  async sendChatMessage(msg: ChatMessage) {
    await tauriCommands.hostedVaultRequest<ChatMessage>(
      this.vault.serverUrl,
      'POST',
      `/api/v1/vaults/${this.vault.hostedVaultId}/chat`,
      { id: msg.id, content: msg.content },
    );
  }

  readChatMessages(limit: number) {
    return tauriCommands.hostedVaultRequest<ChatMessage[]>(
      this.vault.serverUrl,
      'GET',
      `/api/v1/vaults/${this.vault.hostedVaultId}/chat?limit=${encodeURIComponent(String(limit))}`,
    );
  }

  readVaultConfig(): Promise<VaultConfig> {
    return Promise.resolve({
      id: this.vault.hostedVaultId,
      name: this.vault.name,
      knownUsers: [],
      owner: '',
      members: [],
    });
  }

  onPresenceChanged(cb: () => void): Unsubscribe {
    return subscribeBackgroundPoll(cb, 3000);
  }

  onChatUpdated(cb: () => void): Unsubscribe {
    return subscribeBackgroundPoll(cb, 5000);
  }

  onConfigChanged(_cb: () => void): Unsubscribe {
    return () => {};
  }
}

export function createCollabTransport(vault: VaultMeta): CollabTransport {
  return vault.kind === 'hosted'
    ? new HostedServerTransport(vault)
    : new FileSystemTransport(vault.path);
}
