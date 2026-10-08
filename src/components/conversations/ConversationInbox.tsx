import { useEffect, useRef, useState } from 'react';

import { ArrowLeft, MessageCircle, Plus, RefreshCw, Send, Users } from 'lucide-react';

import {
  conversationMembers,
  conversationRequest,
  conversationTransport,
  getConversation,
  markConversationRead,
} from '../../lib/conversations';
import { tauriCommands } from '../../lib/tauri';
import { useConversationInbox } from '../../lib/useConversationInbox';
import { useHostedChat } from '../../lib/useHostedChat';
import { useConversationNavigation } from '../../store/conversationNavigation';
import type {
  ConversationAccount,
  ConversationMember,
  ConversationSummary,
} from '../../types/conversation';
import type { UserDirectoryEntry } from '../../types/vault';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';

export function ConversationInbox({
  account,
  connected,
  registerBack,
  initialConversationId,
}: {
  account: ConversationAccount;
  connected: boolean;
  registerBack?: (dismiss: () => void) => () => void;
  initialConversationId?: string;
}) {
  const inbox = useConversationInbox(account, connected);
  const [selected, setSelected] = useState<ConversationSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [destinationError, setDestinationError] = useState<string | null>(null);
  useEffect(() => {
    if (!connected || !initialConversationId) return;
    let alive = true;
    void getConversation(account, initialConversationId)
      .then((row) => {
        if (alive) {
          setSelected(row);
          setDestinationError(null);
        }
      })
      .catch((reason) => {
        if (alive) {
          setSelected(null);
          setDestinationError(String(reason));
        }
      });
    return () => {
      alive = false;
    };
  }, [initialConversationId, connected, account]);
  useEffect(() => {
    if (creating) return registerBack?.(() => setCreating(false));
    if (selected)
      return registerBack?.(() => {
        setSelected(null);
        useConversationNavigation.getState().clear();
      });
  }, [selected, creating, registerBack]);
  useEffect(() => {
    setSelected((current) => (current && inbox.removed.includes(current.id) ? null : current));
  }, [inbox.removed]);
  const close = () => {
    setSelected(null);
    useConversationNavigation.getState().clear();
    void inbox.refresh();
  };
  const latest = selected ? (inbox.rows.find((row) => row.id === selected.id) ?? selected) : null;
  if (creating)
    return (
      <NewConversation
        account={account}
        connected={connected}
        close={() => setCreating(false)}
        created={async (id) => {
          const [row] = await Promise.all([getConversation(account, id), inbox.refresh()]);
          setSelected(row);
          setCreating(false);
        }}
      />
    );
  if (latest)
    return (
      <ConversationThread
        key={latest.id}
        account={account}
        connected={connected}
        conversation={latest}
        close={close}
        registerBack={registerBack}
      />
    );
  return (
    <section className="conversation-inbox" aria-label="Chat inbox">
      <header className="conversation-header">
        <h2>
          <MessageCircle size={20} /> Chats
        </h2>
        <Button
          aria-label="Refresh chats"
          disabled={!connected || inbox.busy}
          onClick={() => void inbox.refresh()}
        >
          <RefreshCw size={18} />
        </Button>
        <Button disabled={!connected} onClick={() => setCreating(true)}>
          <Plus size={16} /> New chat
        </Button>
      </header>
      {!connected && <p role="status">Reconnect this server to read conversations.</p>}
      {(inbox.error || destinationError) && <p role="alert">{inbox.error || destinationError}</p>}
      <div className="conversation-scroll">
        {!inbox.busy && !inbox.rows.length && connected && (
          <p>No conversations yet. Start a chat with someone on this server.</p>
        )}
        {inbox.rows.map((row) => (
          <Button
            className="conversation-row"
            variant="ghost"
            key={row.id}
            onClick={() => setSelected(row)}
          >
            <Avatar>
              <AvatarImage src={row.picture ?? undefined} />
              <AvatarFallback>
                {row.kind === 'group' ? <Users size={18} /> : row.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span className="conversation-row-name">
              {row.name}
              <small>
                {row.kind === 'channel'
                  ? 'Team channel'
                  : row.kind === 'group'
                    ? 'Group conversation'
                    : 'Direct conversation'}
              </small>
            </span>
            {row.unread > 0 && (
              <span className="conversation-unread" aria-label={`${row.unread} unread messages`}>
                {row.unread}
              </span>
            )}
          </Button>
        ))}
        {inbox.busy && <p role="status">Loading conversations…</p>}
        <div className="conversation-actions">
          {inbox.older && <Button onClick={() => void inbox.refresh()}>Latest chats</Button>}
          {inbox.rows.length === 50 && (
            <Button
              onClick={() => void inbox.refresh(inbox.rows[inbox.rows.length - 1].updatedCursor)}
            >
              Earlier chats
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

function NewConversation({
  account,
  connected,
  close,
  created,
}: {
  account: ConversationAccount;
  connected: boolean;
  close: () => void;
  created: (id: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<'direct' | 'group'>('direct');
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<UserDirectoryEntry[]>([]);
  const [chosen, setChosen] = useState<UserDirectoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      if (!connected) {
        setPeople([]);
        return;
      }
      void tauriCommands
        .hostedUserDirectory(account.serverUrl, query, account.accountId)
        .then((rows) => {
          if (alive) setPeople(rows.filter((row) => row.userId !== account.accountId));
        })
        .catch((reason) => {
          if (alive) setError(String(reason));
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, connected, account.serverUrl, account.accountId]);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const id =
        createdId ??
        (await conversationRequest<string>(account, 'POST', '', {
          kind,
          name: kind === 'group' ? name : undefined,
          members: chosen.map((person) => person.userId),
        }));
      setCreatedId(id);
      await created(id);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="conversation-inbox" aria-label="New conversation">
      <header className="conversation-header">
        <Button onClick={close} aria-label="Back to chats">
          <ArrowLeft size={18} />
        </Button>
        <h2>New chat</h2>
      </header>
      <div className="conversation-scroll conversation-form">
        <div className="conversation-actions">
          <Button
            disabled={busy || !!createdId}
            aria-pressed={kind === 'direct'}
            onClick={() => {
              setKind('direct');
              setChosen([]);
            }}
          >
            Direct
          </Button>
          <Button
            disabled={busy || !!createdId}
            aria-pressed={kind === 'group'}
            onClick={() => {
              setKind('group');
              setChosen([]);
            }}
          >
            Group
          </Button>
        </div>
        {kind === 'group' && (
          <label>
            Group name
            <Input
              disabled={busy || !!createdId}
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        )}
        <label>
          Find people
          <Input
            disabled={busy || !!createdId}
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name or username"
          />
        </label>
        {!!chosen.length && (
          <p>Selected: {chosen.map((person) => person.displayName).join(', ')}</p>
        )}
        {people.map((person) => (
          <Button
            className="conversation-row"
            disabled={busy || !!createdId}
            key={person.userId}
            aria-pressed={chosen.some((value) => value.userId === person.userId)}
            onClick={() =>
              setChosen((values) =>
                values.some((value) => value.userId === person.userId)
                  ? values.filter((value) => value.userId !== person.userId)
                  : kind === 'direct'
                    ? [person]
                    : values.length < 49
                      ? [...values, person]
                      : values,
              )
            }
          >
            {person.displayName}
            <small>@{person.username}</small>
          </Button>
        ))}
        {error && <p role="alert">{error}</p>}
        <Button
          disabled={busy || !connected || !chosen.length || (kind === 'group' && !name.trim())}
          onClick={() => void submit()}
        >
          {busy ? 'Opening…' : createdId ? 'Open conversation' : 'Create conversation'}
        </Button>
      </div>
    </section>
  );
}

export function ConversationThread({
  account,
  connected,
  conversation,
  close,
  registerBack,
}: {
  account: ConversationAccount;
  connected: boolean;
  conversation: ConversationSummary;
  close: () => void;
  registerBack?: (dismiss: () => void) => () => void;
}) {
  const scope = { ...account, vaultId: conversation.id };
  const chat = useHostedChat(scope, connected, conversationTransport);
  const [text, setText] = useState('');
  const [manage, setManage] = useState(false);
  useEffect(() => {
    if (manage) return registerBack?.(() => setManage(false));
  }, [manage, registerBack]);
  const [readError, setReadError] = useState<string | null>(null);
  const marked = useRef('0');
  const tail = useRef<HTMLDivElement>(null);
  const last = chat.messages[chat.messages.length - 1]?.sequence;
  useEffect(() => {
    if (chat.earlier || !last || !chat.authorized || !connected) return;
    let alive = true;
    const read = () => {
      if (document.visibilityState === 'hidden' || marked.current === last) return;
      void markConversationRead(account, conversation.id, last)
        .then(() => {
          if (alive) {
            marked.current = last;
            setReadError(null);
          }
        })
        .catch((reason) => {
          if (alive) setReadError(String(reason));
        });
    };
    read();
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => {
      alive = false;
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', read);
    };
  }, [last, chat.earlier, chat.authorized, connected, account, conversation.id]);
  useEffect(() => {
    if (!chat.earlier) tail.current?.scrollIntoView({ block: 'end' });
  }, [last, chat.earlier]);
  async function submit() {
    const value = text;
    if (await chat.submit(value)) setText((current) => (current === value ? '' : current));
  }
  if (manage)
    return (
      <GroupMembers
        account={account}
        connected={connected}
        conversation={conversation}
        close={() => setManage(false)}
        left={close}
      />
    );
  return (
    <section className="conversation-inbox" aria-label={`Conversation with ${conversation.name}`}>
      <header className="conversation-header">
        <Button
          aria-label={conversation.kind === 'channel' ? 'Back to teams' : 'Back to chats'}
          onClick={close}
        >
          <ArrowLeft size={18} />
        </Button>
        <h2>
          {conversation.teamName ? `${conversation.teamName} / ` : ''}
          {conversation.name}
        </h2>
        {conversation.kind === 'group' && (
          <Button aria-label="Manage group" onClick={() => setManage(true)}>
            <Users size={18} />
          </Button>
        )}
        <Button
          aria-label="Refresh messages"
          disabled={!connected || chat.busy}
          onClick={() => void chat.refresh()}
        >
          <RefreshCw size={18} />
        </Button>
      </header>
      <div className="conversation-scroll" aria-label="Messages">
        {!connected && (
          <p role="status">
            Reconnect to read and send messages. Saved unsent messages stay private to your account.
          </p>
        )}
        {(chat.error || readError) && <p role="alert">{chat.error || readError}</p>}
        <div className="conversation-actions">
          {chat.before && (
            <Button disabled={chat.busy} onClick={() => void chat.older()}>
              Earlier messages
            </Button>
          )}
          {chat.earlier && <Button onClick={() => void chat.refresh()}>Latest messages</Button>}
        </div>
        {chat.messages.map((message) => (
          <article
            className={`conversation-message ${message.userId === account.accountId ? 'own' : ''}`}
            key={message.id}
          >
            <strong>{message.userName}</strong>
            <time dateTime={new Date(message.timestamp).toISOString()}>
              {new Date(message.timestamp).toLocaleString()}
            </time>
            <p>{message.content}</p>
          </article>
        ))}
        {chat.busy && <p role="status">Loading messages…</p>}
        {!!chat.pending.length && (
          <section aria-label="Unsent messages">
            <h3>Unsent messages</h3>
            {chat.pending.map((message) => (
              <article className="conversation-message" key={message.id}>
                <p>{message.content}</p>
                <Button
                  disabled={!connected || !chat.authorized || !!chat.sending}
                  onClick={() => void chat.retry(message)}
                >
                  Retry
                </Button>
                <Button
                  disabled={chat.sending === message.id}
                  onClick={() => void chat.discard(message.id)}
                >
                  Discard
                </Button>
              </article>
            ))}
          </section>
        )}
        <div ref={tail} />
      </div>
      <form
        className="conversation-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Textarea
          aria-label="Message"
          placeholder="Write a message"
          value={text}
          maxLength={8000}
          disabled={!connected || !chat.authorized}
          onChange={(event) => setText(event.target.value)}
        />
        <Button
          type="submit"
          aria-label="Send message"
          disabled={!connected || !chat.authorized || !text.trim() || !!chat.sending}
        >
          <Send size={18} />
        </Button>
      </form>
    </section>
  );
}

function GroupMembers({
  account,
  connected,
  conversation,
  close,
  left,
}: {
  account: ConversationAccount;
  connected: boolean;
  conversation: ConversationSummary;
  close: () => void;
  left: () => void;
}) {
  const [members, setMembers] = useState<ConversationMember[]>([]);
  const [people, setPeople] = useState<UserDirectoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [name, setName] = useState(conversation.name);
  const [picture, setPicture] = useState(conversation.picture);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const owner = members.some(
    (member) => member.userId === account.accountId && member.role === 'owner',
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!connected) {
      setMembers([]);
      setPeople([]);
      return;
    }
    let current = true;
    const refresh = () => {
      void conversationMembers(account, conversation.id)
        .then((rows) => {
          if (current) setMembers(rows);
        })
        .catch((reason) => {
          if (current) {
            setMembers([]);
            setPeople([]);
            setError(String(reason));
          }
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [account, conversation.id, connected]);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      if (connected && owner)
        void tauriCommands
          .hostedUserDirectory(account.serverUrl, query, account.accountId)
          .then((rows) => {
            if (current)
              setPeople(
                rows.filter((row) => !members.some((member) => member.userId === row.userId)),
              );
          })
          .catch((reason) => {
            if (current) setError(String(reason));
          });
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, owner, members, connected, account.serverUrl, account.accountId]);
  async function mutate(
    method: 'POST' | 'PATCH' | 'DELETE',
    suffix: string,
    body?: unknown,
    leaving = false,
  ) {
    setBusy(true);
    setError(null);
    try {
      await conversationRequest(account, method, `/${conversation.id}${suffix}`, body);
      if (!alive.current) return;
      if (leaving) {
        left();
        return;
      }
      const rows = await conversationMembers(account, conversation.id);
      if (alive.current) {
        setMembers(rows);
        setConfirm(null);
      }
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="conversation-inbox" aria-label="Group members">
      <header className="conversation-header">
        <Button onClick={close} aria-label="Back to conversation">
          <ArrowLeft size={18} />
        </Button>
        <h2>Group members</h2>
      </header>
      <div className="conversation-scroll conversation-form">
        {error && <p role="alert">{error}</p>}
        {owner && (
          <>
            <label>
              Group name
              <Input
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              Group picture (PNG, up to 64 KiB)
              <Input
                type="file"
                accept="image/png"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.type !== 'image/png' || file.size > 65536) {
                    setError('Choose a PNG image of at most 64 KiB.');
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = () => {
                    if (alive.current) setPicture(String(reader.result));
                  };
                  reader.readAsDataURL(file);
                }}
              />
            </label>
            {picture && (
              <>
                <Avatar>
                  <AvatarImage src={picture} />
                  <AvatarFallback>Group</AvatarFallback>
                </Avatar>
                <Button onClick={() => setPicture(null)}>Remove picture</Button>
              </>
            )}
            <Button
              disabled={busy || !connected || !name.trim()}
              onClick={() => void mutate('PATCH', '', { name, picture })}
            >
              Save group
            </Button>
          </>
        )}
        {members.map((member) => (
          <div className="conversation-member" key={member.userId}>
            <span>
              {member.displayName} · {member.role}
              {!member.active ? ' · unavailable' : ''}
            </span>
            {owner && (
              <div className="conversation-actions">
                <Button
                  disabled={busy || !connected || !member.active}
                  onClick={() =>
                    void mutate('PATCH', `/members/${member.userId}`, {
                      userId: member.userId,
                      role: member.role === 'owner' ? 'member' : 'owner',
                    })
                  }
                >
                  {member.role === 'owner' ? 'Make member' : 'Make owner'}
                </Button>
                <Button
                  disabled={busy || !connected}
                  onClick={() => {
                    if (confirm === member.userId)
                      void mutate(
                        'DELETE',
                        `/members/${member.userId}`,
                        undefined,
                        member.userId === account.accountId,
                      );
                    else setConfirm(member.userId);
                  }}
                >
                  {confirm === member.userId ? 'Confirm removal' : 'Remove'}
                </Button>
              </div>
            )}
          </div>
        ))}
        {owner && (
          <>
            <label>
              Add a person
              <Input
                value={query}
                maxLength={200}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            {people.map((person) => (
              <Button
                disabled={busy || !connected}
                key={person.userId}
                onClick={() => void mutate('POST', '/members', { userId: person.userId })}
              >
                Add {person.displayName}
              </Button>
            ))}
          </>
        )}
        <p>
          New members see messages sent after they join. Promote another owner before the last owner
          leaves.
        </p>
        <Button
          disabled={busy || !connected}
          onClick={() => {
            if (confirm === 'leave')
              void mutate('DELETE', `/members/${account.accountId}`, undefined, true);
            else setConfirm('leave');
          }}
        >
          {confirm === 'leave' ? 'Confirm leaving group' : 'Leave group'}
        </Button>
      </div>
    </section>
  );
}
