import { useState } from 'react';

import { useConversationNavigation } from '../../store/conversationNavigation';
import type { ConversationAccount } from '../../types/conversation';
import { Button } from '../ui/button';

import { ConversationInbox } from './ConversationInbox';
import './conversations.css';

export function ConversationAccounts({
  accounts,
  registerBack,
}: {
  accounts: (ConversationAccount & { label: string; connected: boolean })[];
  registerBack?: (dismiss: () => void) => () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const destination = useConversationNavigation((state) => state.destination);
  const selected =
    accounts.find((account) => account.serverUrl === (destination?.serverUrl ?? chosen)) ??
    accounts[0];
  return (
    <div className="conversation-workspace">
      <div className="conversation-servers" aria-label="Chat servers">
        {accounts.map((account) => (
          <Button
            key={account.serverUrl}
            variant="outline"
            aria-pressed={account.serverUrl === selected?.serverUrl}
            onClick={() => {
              setChosen(account.serverUrl);
              useConversationNavigation.getState().clear();
            }}
          >
            {account.label}
            {!account.connected ? ' · offline' : ''}
          </Button>
        ))}
      </div>
      {selected ? (
        <ConversationInbox
          key={JSON.stringify([selected.serverUrl, selected.accountId])}
          account={selected}
          connected={selected.connected}
          registerBack={registerBack}
          initialConversationId={
            destination?.serverUrl === selected.serverUrl &&
            destination.accountId === selected.accountId
              ? destination.conversationId
              : undefined
          }
        />
      ) : (
        <p>Connect to a server to start chatting. Conversations are independent of your vaults.</p>
      )}
    </div>
  );
}
