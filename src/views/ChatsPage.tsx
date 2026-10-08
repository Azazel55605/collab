import { ConversationAccounts } from '../components/conversations/ConversationAccounts';
import { useServerStore } from '../store/serverStore';

export default function ChatsPage({ standalone = true }: { standalone?: boolean } = {}) {
  const connections = useServerStore((state) => state.connections);
  return (
    <main className={`desktop-conversations ${standalone ? '' : 'embedded'}`}>
      <ConversationAccounts
        accounts={Object.entries(connections).flatMap(([serverUrl, connection]) =>
          connection.status.user
            ? [
                {
                  serverUrl,
                  accountId: connection.status.user.id,
                  displayName:
                    connection.status.user.displayName || connection.status.user.username,
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
