import { useEffect, useRef, useState } from 'react';

import { ArrowLeft, Hash, RefreshCw, SendHorizontal, Users, X } from 'lucide-react';

import {
  conversationMembers,
  conversationRequest,
  conversationTransport,
  markConversationRead,
} from '../../lib/conversations';
import { tauriCommands } from '../../lib/tauri';
import { useHostedChat } from '../../lib/useHostedChat';
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

import { messageTime, NameAvatar } from './ConversationVisuals';

/** Consecutive messages from one sender within this window share a header. */
const GROUP_WINDOW = 5 * 60_000;

export function NewConversation({
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
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<UserDirectoryEntry[]>([]);
  const [chosen, setChosen] = useState<UserDirectoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
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
          kind: 'group',
          name,
          members: chosen.map((person) => person.userId),
        }));
      if (!active.current) return;
      setCreatedId(id);
      await created(id);
    } catch (reason) {
      if (active.current) setError(String(reason));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <section className="conversation-inbox" aria-label="New conversation">
      <header className="conversation-header">
        <Button onClick={close} aria-label="Back to chats">
          <ArrowLeft size={18} />
        </Button>
        <h2>New group chat</h2>
      </header>
      <div className="conversation-scroll conversation-form">
        <label>
          Group name
          <Input
            disabled={busy || !!createdId}
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
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
          <div className="conversation-chosen" aria-label="Selected people">
            {chosen.map((person) => (
              <Button
                key={person.userId}
                variant="outline"
                disabled={busy || !!createdId}
                aria-label={`Remove ${person.displayName}`}
                onClick={() =>
                  setChosen((values) => values.filter((value) => value.userId !== person.userId))
                }
              >
                {person.displayName}
                <X size={14} />
              </Button>
            ))}
          </div>
        )}
        <div className="conversation-candidates">
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
        </div>
      </div>
      <footer className="conversation-create-footer">
        {error && <p role="alert">{error}</p>}
        <Button
          disabled={busy || !connected || !chosen.length || !name.trim()}
          onClick={() => void submit()}
        >
          {busy ? 'Opening…' : createdId ? 'Open conversation' : 'Create conversation'}
        </Button>
      </footer>
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
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [text]);
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
      <header className="conversation-header conversation-thread-header">
        <Button
          className="conversation-thread-back"
          variant="ghost"
          aria-label={conversation.kind === 'channel' ? 'Back to teams' : 'Back to chats'}
          onClick={close}
        >
          <ArrowLeft size={18} />
        </Button>
        <NameAvatar name={conversation.name} picture={conversation.picture} size="lg">
          {conversation.kind === 'group' ? (
            <Users size={20} />
          ) : conversation.kind === 'channel' ? (
            <Hash size={20} />
          ) : undefined}
        </NameAvatar>
        <div className="conversation-title">
          <h2>{conversation.name}</h2>
          <small>
            {conversation.kind === 'channel'
              ? `${conversation.teamName ?? 'Team'} channel`
              : conversation.kind === 'group'
                ? 'Group chat'
                : 'Direct chat'}
            {!connected ? ' · offline' : ''}
          </small>
        </div>
        {conversation.kind === 'group' && (
          <Button variant="ghost" aria-label="Manage group" onClick={() => setManage(true)}>
            <Users size={18} />
          </Button>
        )}
        <Button
          aria-label="Refresh messages"
          variant="ghost"
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
        {chat.messages.map((message, index) => {
          const own = message.userId === account.accountId;
          const previous = chat.messages[index - 1];
          const continued =
            !!previous &&
            previous.userId === message.userId &&
            message.timestamp - previous.timestamp < GROUP_WINDOW;
          return (
            <article
              className={`conversation-message ${own ? 'own' : ''} ${continued ? 'continued' : ''}`}
              key={message.id}
            >
              {!own && !continued && <NameAvatar name={message.userName} />}
              <div className="conversation-message-body">
                <header className={continued ? 'conversation-visually-hidden' : undefined}>
                  <strong className={own ? 'conversation-visually-hidden' : undefined}>
                    {own ? 'You' : message.userName}
                  </strong>
                  <time dateTime={new Date(message.timestamp).toISOString()}>
                    {messageTime(message.timestamp)}
                  </time>
                </header>
                <p>{message.content}</p>
              </div>
            </article>
          );
        })}
        {chat.busy && <p role="status">Loading messages…</p>}
        {!!chat.pending.length && (
          <section aria-label="Unsent messages">
            <h3>Unsent messages</h3>
            {chat.pending.map((message) => (
              <article className="conversation-message own pending" key={message.id}>
                <div className="conversation-message-body">
                  <p>{message.content}</p>
                </div>
                <div className="conversation-actions">
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
                </div>
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
        <div className="conversation-composer-field">
          <Textarea
            ref={field}
            rows={1}
            aria-label="Message"
            placeholder={`Message ${conversation.kind === 'channel' ? '#' : ''}${conversation.name}…`}
            value={text}
            maxLength={8000}
            disabled={!connected || !chat.authorized}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter keeps writing; never interrupt IME composition.
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (text.trim() && !chat.sending) void submit();
            }}
          />
        </div>
        <Button
          type="submit"
          className="conversation-send"
          aria-label="Send message"
          disabled={!connected || !chat.authorized || !text.trim() || !!chat.sending}
        >
          <SendHorizontal size={20} />
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
