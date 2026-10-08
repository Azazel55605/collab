import { useEffect, useMemo, useState } from 'react';

import { conversationMembers, getConversation } from '../../lib/conversations';
import { tauriCommands } from '../../lib/tauri';
import { nativeTeamRequest } from '../../lib/teams';
import { useConversationNavigation } from '../../store/conversationNavigation';
import type { ConversationAccount } from '../../types/conversation';
import type { ConversationSummary } from '../../types/conversation';
import { TeamWorkspace } from '../teams/TeamWorkspace';
import { Button } from '../ui/button';

import { ConversationThread } from './ConversationInbox';
import { ConversationInbox } from './ConversationInbox';
import './conversations.css';

export function ConversationAccounts({
  accounts,
  registerBack,
}: {
  accounts: (ConversationAccount & { label: string; connected: boolean; serverAdmin?: boolean })[];
  registerBack?: (dismiss: () => void) => () => void;
}) {
  const [section, setSection] = useState<'chats' | 'teams'>('chats');
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
      <div className="conversation-servers" aria-label="Collaboration sections">
        <Button
          variant="outline"
          aria-pressed={section === 'chats' || !!destination}
          onClick={() => {
            setSection('chats');
            useConversationNavigation.getState().clear();
          }}
        >
          Chats
        </Button>
        <Button
          variant="outline"
          aria-pressed={section === 'teams' && !destination}
          onClick={() => {
            setSection('teams');
            useConversationNavigation.getState().clear();
          }}
        >
          Teams
        </Button>
      </div>
      {selected && section === 'teams' && !destination ? (
        <NativeTeams
          key={JSON.stringify([selected.serverUrl, selected.accountId])}
          account={selected}
          connected={selected.connected}
          serverAdmin={!!selected.serverAdmin}
          registerBack={registerBack}
        />
      ) : selected ? (
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

function NativeTeams({
  account,
  connected,
  serverAdmin,
  registerBack,
}: {
  account: ConversationAccount;
  connected: boolean;
  serverAdmin: boolean;
  registerBack?: (dismiss: () => void) => () => void;
}) {
  const request = useMemo(
    () => nativeTeamRequest({ serverUrl: account.serverUrl, accountId: account.accountId }),
    [account.serverUrl, account.accountId],
  );
  const directory = useMemo(
    () => (query: string) =>
      tauriCommands.hostedUserDirectory(account.serverUrl, query, account.accountId),
    [account.serverUrl, account.accountId],
  );
  const channelMembers = useMemo(
    () => (id: string) =>
      conversationMembers({ serverUrl: account.serverUrl, accountId: account.accountId }, id),
    [account.serverUrl, account.accountId],
  );
  const [channel, setChannel] = useState<ConversationSummary | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (channel) return registerBack?.(() => setChannel(null));
  }, [channel, registerBack]);
  if (channel)
    return (
      <ConversationThread
        account={account}
        connected={connected}
        conversation={channel}
        close={() => setChannel(null)}
        registerBack={registerBack}
      />
    );
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <TeamWorkspace
        request={request}
        directory={directory}
        channelMembers={channelMembers}
        accountId={account.accountId}
        connected={connected}
        serverAdmin={serverAdmin}
        registerBack={registerBack}
        openChannel={(ch) => {
          setError('');
          void getConversation(account, ch.id)
            .then(setChannel)
            .catch((reason) => setError(String(reason)));
        }}
      />
    </>
  );
}
