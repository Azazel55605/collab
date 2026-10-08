import { useEffect, useMemo, useRef, useState } from 'react';

import { MessageCircle, Settings, SlidersHorizontal, UserPlus } from 'lucide-react';

import {
  conversationMembers,
  conversationRequest,
  getConversation,
  pinConversation,
} from '../../lib/conversations';
import { tauriCommands } from '../../lib/tauri';
import { nativeTeamRequest } from '../../lib/teams';
import { useConversationInbox } from '../../lib/useConversationInbox';
import { type ChatPreferences, useChatPreferences } from '../../store/chatPreferences';
import { useConversationNavigation } from '../../store/conversationNavigation';
import type { ConversationSummary } from '../../types/conversation';
import { TeamWorkspace } from '../teams/TeamWorkspace';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

import { ConversationThread, NewConversation } from './ConversationInbox';
import { ConversationList } from './ConversationList';
import './conversations.css';
import { AccountSwitcher, type ChatAccount, PeopleSearch } from './ConversationToolbar';
import { TeamSidebar } from './TeamSidebar';

export function ConversationAccounts({
  accounts,
  registerBack,
  openAccountSettings,
  openChatSettings,
}: {
  accounts: ChatAccount[];
  registerBack?: (dismiss: () => void) => () => void;
  openAccountSettings?: () => void;
  /** Opens the app's Chats settings section. */
  openChatSettings?: () => void;
}) {
  const preferences = useChatPreferences();
  const [chosen, setChosen] = useState<string | null>(null);
  const destination = useConversationNavigation((state) => state.destination);
  const selected =
    accounts.find((account) =>
      destination
        ? account.serverUrl === destination.serverUrl && account.accountId === destination.accountId
        : account.serverUrl === chosen,
    ) ?? accounts[0];
  return (
    <div
      className="conversation-workspace"
      data-density={preferences.density}
      data-previews={preferences.showPreviews ? 'shown' : 'hidden'}
      data-message-style={preferences.messageStyle}
      data-bubble-color={preferences.bubbleColor}
      data-text-size={preferences.textSize}
    >
      {selected ? (
        <AccountWorkspace
          key={JSON.stringify([selected.serverUrl, selected.accountId])}
          account={selected}
          accounts={accounts}
          registerBack={registerBack}
          openAccountSettings={openAccountSettings}
          openChatSettings={openChatSettings}
          preferences={preferences}
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
  openAccountSettings,
  openChatSettings,
  preferences,
}: {
  account: ChatAccount;
  accounts: ChatAccount[];
  selectAccount: (account: ChatAccount) => void;
  registerBack?: (dismiss: () => void) => () => void;
  openAccountSettings?: () => void;
  openChatSettings?: () => void;
  preferences: ChatPreferences & {
    setChatPreference: ReturnType<typeof useChatPreferences.getState>['setChatPreference'];
  };
}) {
  const inbox = useConversationInbox(account, account.connected);
  const [selected, setSelected] = useState<ConversationSummary | null>(null);
  const [panel, setPanel] = useState<'thread' | 'group' | 'manage'>('thread');
  const layout = preferences.sidebarLayout;
  const setPreference = preferences.setChatPreference;
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
  async function togglePin(row: ConversationSummary) {
    setError('');
    try {
      await pinConversation(account, row.id, !row.pinned);
      setSelected((value) => (value?.id === row.id ? { ...value, pinned: !row.pinned } : value));
      await inbox.refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }
  const hasContent = !!selected || panel !== 'thread';
  const current = selected
    ? (inbox.pinned.find((row) => row.id === selected.id) ??
      inbox.rows.find((row) => row.id === selected.id) ??
      selected)
    : null;
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
        <AccountSwitcher
          accounts={accounts}
          selected={account}
          select={selectAccount}
          openSettings={openAccountSettings}
        />
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
              <UserPlus size={18} />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Chat layout">
                  <SlidersHorizontal size={18} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="conversation-layout-menu">
                <DropdownMenuLabel>Sidebar</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={layout}
                  onValueChange={(value) =>
                    setPreference('sidebarLayout', value as ChatPreferences['sidebarLayout'])
                  }
                >
                  <DropdownMenuRadioItem value="combined">
                    Chats and teams together
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="separate">
                    Separate chats and teams
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator className="conversation-menu-separator" />
                <DropdownMenuLabel>Group chats</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={preferences.groupChats}
                  onValueChange={(value) =>
                    setPreference('groupChats', value as ChatPreferences['groupChats'])
                  }
                >
                  <DropdownMenuRadioItem value="mixed">With direct chats</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="separate">
                    In their own section
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator className="conversation-menu-separator" />
                <DropdownMenuLabel>Sort</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={preferences.sortOrder}
                  onValueChange={(value) =>
                    setPreference('sortOrder', value as ChatPreferences['sortOrder'])
                  }
                >
                  <DropdownMenuRadioItem value="recent">Most recent</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="unread">Unread first</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator className="conversation-menu-separator" />
                <DropdownMenuCheckboxItem
                  checked={preferences.density === 'compact'}
                  onCheckedChange={(checked) =>
                    setPreference('density', checked ? 'compact' : 'comfortable')
                  }
                >
                  Compact view
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={preferences.showPreviews}
                  onCheckedChange={(checked) => setPreference('showPreviews', !!checked)}
                >
                  Message previews
                </DropdownMenuCheckboxItem>
                {openChatSettings && (
                  <>
                    <DropdownMenuSeparator className="conversation-menu-separator" />
                    <DropdownMenuItem onSelect={openChatSettings}>
                      <Settings size={15} />
                      All chat settings…
                    </DropdownMenuItem>
                  </>
                )}
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
              <ConversationList
                serverUrl={account.serverUrl}
                rows={inbox.rows}
                pinned={inbox.pinned}
                selectedId={panel === 'thread' ? selected?.id : undefined}
                connected={account.connected}
                preferences={preferences}
                open={(id) => void open(id)}
                togglePin={(row) => void togglePin(row)}
                footer={
                  <>
                    {inbox.busy && !inbox.rows.length && (
                      <p role="status">Loading conversations…</p>
                    )}
                    {!inbox.busy &&
                      !inbox.rows.some((row) => row.kind !== 'channel') &&
                      !inbox.pinned.length &&
                      account.connected && (
                        <p className="conversation-sidebar-hint">
                          Find someone above to start a chat.
                        </p>
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
                  </>
                }
              />
            )}
            {(layout === 'combined' || section === 'teams') && (
              <TeamSidebar
                account={account}
                collapsible={layout === 'combined'}
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
              togglePin={() => void togglePin(current)}
              messagePreferences={preferences}
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
