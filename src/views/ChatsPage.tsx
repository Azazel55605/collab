import { ArrowLeft } from 'lucide-react';

import { ConversationAccounts } from '../components/conversations/ConversationAccounts';
import { Button } from '../components/ui/button';
import { useServerStore } from '../store/serverStore';
import { useUiStore } from '../store/uiStore';

export default function ChatsPage({ standalone = true }: { standalone?: boolean } = {}) {
  const connections = useServerStore((state) => state.connections);
  return (
    <main className={`desktop-conversations ${standalone ? '' : 'embedded'}`}>
      <header className="conversation-header">
        <Button onClick={() => useUiStore.getState().setActiveView('editor')}>
          <ArrowLeft size={18} /> Back to files
        </Button>
        <h1>Chats</h1>
      </header>
      <ConversationAccounts
        accounts={Object.entries(connections).flatMap(([serverUrl, connection]) =>
          connection.status.user
            ? [
                {
                  serverUrl,
                  accountId: connection.status.user.id,
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
