import { ConversationAccounts } from '../components/conversations/ConversationAccounts';
import { useServerStore } from '../store/serverStore';
import { useUiStore } from '../store/uiStore';

function openSettingsTab(tab: 'profile' | 'chats') {
  useUiStore.getState().openSettings();
  // The modal mounts its tab listener on open, so request the tab afterwards.
  window.setTimeout(() =>
    window.dispatchEvent(new CustomEvent('settings:open-tab', { detail: { tab } })),
  );
}

export default function ChatsPage({ standalone = true }: { standalone?: boolean } = {}) {
  const connections = useServerStore((state) => state.connections);
  return (
    <main className={`desktop-conversations ${standalone ? '' : 'embedded'}`}>
      <ConversationAccounts
        openAccountSettings={() => openSettingsTab('profile')}
        openChatSettings={() => openSettingsTab('chats')}
        accounts={Object.entries(connections).flatMap(([serverUrl, connection]) =>
          connection.status.user
            ? [
                {
                  serverUrl,
                  accountId: connection.status.user.id,
                  displayName:
                    connection.status.user.displayName || connection.status.user.username,
                  username: connection.status.user.username,
                  hasAvatar: connection.status.user.hasAvatar,
                  avatarUpdatedAt: connection.status.user.avatarUpdatedAt,
                  label: connection.status.user.displayName + ' · ' + serverUrl,
                  connected: connection.status.connected,
                  serverAdmin: connection.status.user.role === 'admin',
                },
              ]
            : [],
        )}
      />
    </main>
  );
}
