import { useEffect, useMemo, useRef, useState } from 'react';

import { MessageCircle, Settings2, Users, UsersRound } from 'lucide-react';

import { conversationMembers, conversationRequest, getConversation } from '../../lib/conversations';
import { tauriCommands } from '../../lib/tauri';
import { nativeTeamRequest } from '../../lib/teams';
import { useConversationInbox } from '../../lib/useConversationInbox';
import { useConversationNavigation } from '../../store/conversationNavigation';
import type { ConversationSummary } from '../../types/conversation';
import { TeamWorkspace } from '../teams/TeamWorkspace';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

import { ConversationThread, NewConversation } from './ConversationInbox';
import { type ChatLayout, readChatLayout, saveChatLayout } from './ConversationPreferences';
import './conversations.css';
import { AccountSwitcher, type ChatAccount, PeopleSearch } from './ConversationToolbar';
import { TeamSidebar } from './TeamSidebar';

export function ConversationAccounts({
  accounts,
  registerBack,
}: {
  accounts: ChatAccount[];
  registerBack?: (dismiss: () => void) => () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const destination = useConversationNavigation((state) => state.destination);
  const selected =
    accounts.find((account) =>
      destination
        ? account.serverUrl === destination.serverUrl && account.accountId === destination.accountId
        : account.serverUrl === chosen,
    ) ?? accounts[0];
  return (
    <div className="conversation-workspace">
      {selected ? (
        <AccountWorkspace
          key={JSON.stringify([selected.serverUrl, selected.accountId])}
          account={selected}
          accounts={accounts}
          registerBack={registerBack}
          selectAccount={(account) => {
            setChosen(account.serverUrl);
            useConversationNavigation.getState().clear();
          }}
        />
      ) : (
        <p>Connect to a server to start chatting. Conversations are independent of your vaults.</p>
      )}
    </div>
  );
}
function AccountWorkspace({
  account,
  accounts,
  selectAccount,
  registerBack,
}: {
  account: ChatAccount;
  accounts: ChatAccount[];
  selectAccount: (account: ChatAccount) => void;
  registerBack?: (dismiss: () => void) => () => void;
}) {
  const inbox = useConversationInbox(account, account.connected);
  const [selected, setSelected] = useState<ConversationSummary | null>(null);
  const [panel, setPanel] = useState<'thread' | 'group' | 'manage'>('thread');
  const [layout, setLayout] = useState(readChatLayout);
  const [section, setSection] = useState<'chats' | 'teams'>('chats');
  const [error, setError] = useState('');
  const destination = useConversationNavigation((state) => state.destination);
  const ticket = useRef(0);
  useEffect(
    () => () => {
      ticket.current++;
    },
    [],
  );
  const request = useMemo(
    () => nativeTeamRequest({ serverUrl: account.serverUrl, accountId: account.accountId }),
    [account.serverUrl, account.accountId],
  );
  const directory = useMemo(
    () => (query: string) =>
      tauriCommands.hostedUserDirectory(account.serverUrl, query, account.accountId),
    [account.serverUrl, account.accountId],
  );
  const members = useMemo(
    () => (id: string) =>
      conversationMembers({ serverUrl: account.serverUrl, accountId: account.accountId }, id),
    [account.serverUrl, account.accountId],
  );
  async function open(id: string) {
    const current = ++ticket.current;
    setError('');
    try {
      const row = await getConversation(account, id);
      if (current === ticket.current) {
        setSelected(row);
        setPanel('thread');
        setSection(row.kind === 'channel' ? 'teams' : 'chats');
        return true;
      }
    } catch (reason) {
      if (current === ticket.current) {
        setSelected(null);
        setError(String(reason));
      }
    }
    return false;
  }
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (
      destination?.serverUrl === account.serverUrl &&
      destination.accountId === account.accountId &&
      account.connected
    )
      void openRef.current(destination.conversationId);
  }, [destination, account.serverUrl, account.accountId, account.connected]);
  useEffect(() => {
    setSelected((value) => (value && inbox.removed.includes(value.id) ? null : value));
  }, [inbox.removed]);
  function close() {
    ticket.current++;
    setSelected(null);
    setPanel('thread');
    useConversationNavigation.getState().clear();
    void inbox.refresh();
  }
  useEffect(() => {
    if (selected || panel !== 'thread')
      return registerBack?.(() => {
        ticket.current++;
        setSelected(null);
        setPanel('thread');
        useConversationNavigation.getState().clear();
      });
  }, [selected, panel, registerBack]);
  const hasContent = !!selected || panel !== 'thread';
  const current = selected ? (inbox.rows.find((row) => row.id === selected.id) ?? selected) : null;
  return (
    <>
      <header className="conversation-toolbar">
        <PeopleSearch
          account={account}
          openPerson={async (person) => {
            const currentTicket = ++ticket.current;
            const id = await conversationRequest<string>(account, 'POST', '', {
              kind: 'direct',
              members: [person.userId],
            });
            if (ticket.current !== currentTicket) return;
            if (!(await open(id))) throw new Error('Unable to open this conversation. Try again.');
            void inbox.refresh();
          }}
        />
        <AccountSwitcher accounts={accounts} selected={account} select={selectAccount} />
      </header>
      <div className={`conversation-split ${hasContent ? 'has-content' : ''}`}>
        <aside className="conversation-sidebar" aria-label="Chats and teams">
          <header className="conversation-sidebar-heading">
            <h1>{layout === 'combined' ? 'Chats' : section === 'chats' ? 'Chats' : 'Teams'}</h1>
            <Button
              variant="ghost"
              size="icon"
              aria-label="New group chat"
              disabled={!account.connected}
              onClick={() => {
                ticket.current++;
                setPanel('group');
              }}
            >
              <UsersRound size={18} />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Chat layout">
                  <Settings2 size={18} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="conversation-layout-menu">
                <DropdownMenuRadioGroup
                  value={layout}
                  onValueChange={(value) => {
                    setLayout(value as ChatLayout);
                    saveChatLayout(value as ChatLayout);
                  }}
                >
                  <DropdownMenuRadioItem value="combined">
                    Chats and teams together
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="separate">
                    Separate chats and teams
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>
          {layout === 'separate' && (
            <div className="conversation-section-tabs" aria-label="Collaboration sections">
              <Button
                variant="ghost"
                aria-pressed={section === 'chats'}
                onClick={() => setSection('chats')}
              >
                Chats
              </Button>
              <Button
                variant="ghost"
                aria-pressed={section === 'teams'}
                onClick={() => setSection('teams')}
              >
                Teams
              </Button>
            </div>
          )}
          <div className="conversation-sidebar-scroll">
            {!account.connected && (
              <p role="status">Reconnect this server to read conversations.</p>
            )}
            {inbox.error && <p role="alert">{inbox.error}</p>}
            {(layout === 'combined' || section === 'chats') && (
              <nav aria-label="Conversations">
                {inbox.rows
                  .filter((row) => row.kind !== 'channel')
                  .map((row) => (
                    <Button
                      key={row.id}
                      variant="ghost"
                      className="conversation-row"
                      aria-pressed={selected?.id === row.id && panel === 'thread'}
                      disabled={!account.connected}
                      onClick={() => void open(row.id)}
                    >
                      <Avatar>
                        <AvatarImage src={row.picture ?? undefined} />
                        <AvatarFallback>
                          {row.kind === 'group' ? (
                            <Users size={18} />
                          ) : (
                            row.name.slice(0, 2).toUpperCase()
                          )}
                        </AvatarFallback>
                      </Avatar>
                      <span className="conversation-row-name">
                        {row.name}
                        <small>{row.kind === 'group' ? 'Group chat' : 'Direct chat'}</small>
                      </span>
                      {row.unread > 0 && (
                        <span
                          className="conversation-unread"
                          aria-label={`${row.unread} unread messages`}
                        >
                          {row.unread}
                        </span>
                      )}
                    </Button>
                  ))}
                {inbox.busy && <p role="status">Loading conversations…</p>}
                {!inbox.busy &&
                  !inbox.rows.some((row) => row.kind !== 'channel') &&
                  account.connected && (
                    <p className="conversation-sidebar-hint">Find someone above to start a chat.</p>
                  )}
                {inbox.older && (
                  <Button variant="ghost" onClick={() => void inbox.refresh()}>
                    Latest chats
                  </Button>
                )}
                {inbox.rows.length === 50 && (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void inbox.refresh(inbox.rows[inbox.rows.length - 1].updatedCursor)
                    }
                  >
                    Earlier chats
                  </Button>
                )}
              </nav>
            )}
            {(layout === 'combined' || section === 'teams') && (
              <TeamSidebar
                account={account}
                selected={selected?.id}
                open={(id) => void open(id)}
                manage={() => {
                  ticket.current++;
                  setPanel('manage');
                }}
              />
            )}
          </div>
        </aside>
        <div className="conversation-detail">
          {error && <p role="alert">{error}</p>}
          {panel === 'group' ? (
            <NewConversation
              account={account}
              connected={account.connected}
              close={close}
              created={async (id) => {
                if (!(await open(id))) throw new Error('Unable to open this group. Try again.');
                void inbox.refresh();
              }}
            />
          ) : panel === 'manage' ? (
            <>
              <header className="conversation-header">
                <Button variant="ghost" onClick={close}>
                  Close team management
                </Button>
              </header>
              <TeamWorkspace
                request={request}
                directory={directory}
                channelMembers={members}
                accountId={account.accountId}
                connected={account.connected}
                serverAdmin={!!account.serverAdmin}
                registerBack={registerBack}
                openChannel={(ch) => void open(ch.id)}
              />
            </>
          ) : current ? (
            <ConversationThread
              key={current.id}
              account={account}
              connected={account.connected}
              conversation={current}
              close={close}
              registerBack={registerBack}
            />
          ) : (
            <div className="conversation-empty">
              <MessageCircle size={40} />
              <h2>Your conversations</h2>
              <p>Choose a chat or search for someone on this server.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
