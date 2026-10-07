import { useEffect, useRef, useState } from 'react';

import { ArrowLeft, MessageCircle, RefreshCw, Send } from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '../../../../src/components/ui/avatar';
import { Button } from '../../../../src/components/ui/button';
import { Textarea } from '../../../../src/components/ui/textarea';
import { readChatAvatar } from '../../../../src/lib/hostedChat';
import { useHostedChat } from '../../../../src/lib/useHostedChat';
import type { HostedChatScope } from '../../../../src/types/chat';
import { Banner, EmptyState, Spinner } from '../components/ui';
import { useMobileStore } from '../state/store';

export function ChatScreen() {
  const selected = useMobileStore((state) => state.selected);
  const status = useMobileStore((state) =>
    selected ? state.statuses[selected.serverUrl] : undefined,
  );
  const close = useMobileStore((state) => state.closeSheet);
  if (!selected || !status?.user)
    return (
      <div className="screen vault-chat">
        <Button onClick={close}>Back to files</Button>
        <Banner tone="info">Reconnect your account to open vault chat.</Banner>
      </div>
    );
  const scope = {
    serverUrl: selected.serverUrl,
    accountId: status.user.id,
    vaultId: selected.vault.id,
  };
  return (
    <VaultChat
      key={JSON.stringify(scope)}
      scope={scope}
      connected={status.connected}
      canSend={selected.vault.capabilities.includes('chat.send')}
      name={selected.vault.name}
      close={close}
    />
  );
}

function VaultChat({
  scope,
  connected,
  canSend,
  name,
  close,
}: {
  scope: HostedChatScope;
  connected: boolean;
  canSend: boolean;
  name: string;
  close: () => void;
}) {
  const chat = useHostedChat(scope, connected);
  const [text, setText] = useState('');
  const [avatars, setAvatars] = useState<Record<string, string>>({});
  const requestedAvatars = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const bottom = useRef<HTMLDivElement>(null);
  const writable = connected && canSend && chat.authorized;

  useEffect(() => {
    const users = chat.messages.filter((message) => message.hasAvatar);
    for (const user of users) {
      const key = `${user.userId}:${user.avatarUpdatedAt}`;
      if (requestedAvatars.current.has(key) || requestedAvatars.current.size >= 8) continue;
      requestedAvatars.current.add(key);
      void readChatAvatar(scope, user.userId)
        .then((avatar) => {
          if (alive.current) setAvatars((value) => ({ ...value, [key]: avatar }));
        })
        .catch(() => {});
    }
    // Scope is fixed for this keyed screen instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.messages]);

  useEffect(() => {
    if (!chat.earlier) bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.messages, chat.pending, chat.earlier]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!writable || !text.trim() || chat.sending) return;
    const draft = text;
    if (await chat.submit(draft)) setText((value) => (value === draft ? '' : value));
  }

  return (
    <div className="screen vault-chat">
      <header className="screen-header">
        <Button variant="ghost" aria-label="Back to files" onClick={close}>
          <ArrowLeft />
        </Button>
        <div className="chat-heading">
          <h1>{name} chat</h1>
          <p>{scope.serverUrl.replace(/^https?:\/\//, '')}</p>
        </div>
        <Button
          variant="ghost"
          aria-label="Refresh chat"
          disabled={chat.busy || !connected}
          onClick={() => void chat.refresh()}
        >
          {chat.busy ? <Spinner /> : <RefreshCw />}
        </Button>
      </header>
      <div className="chat-history" aria-label="Chat history" aria-busy={chat.busy}>
        <div className="chat-notices">
          {!connected ? (
            <Banner tone="info">
              Reconnect to read or send messages. Pending drafts are saved on this device.
            </Banner>
          ) : null}
          {!canSend ? (
            <Banner tone="info">You can read this chat. Sending requires chat permission.</Banner>
          ) : null}
          {chat.error ? <Banner tone="error">{chat.error}</Banner> : null}
        </div>
        <div className="chat-history-actions">
          {chat.before ? (
            <Button
              variant="outline"
              disabled={chat.busy || !connected}
              onClick={() => void chat.older()}
            >
              Earlier messages
            </Button>
          ) : null}
          {chat.earlier ? (
            <Button
              variant="outline"
              disabled={chat.busy || !connected}
              onClick={() => void chat.refresh()}
            >
              Latest messages
            </Button>
          ) : null}
        </div>
        {chat.authorized && !chat.busy && !chat.messages.length ? (
          <EmptyState
            icon={<MessageCircle />}
            title="No messages yet"
            message="Start a conversation in this vault."
          />
        ) : null}
        <ol className="chat-message-list">
          {chat.messages.map((message) => (
            <li
              key={message.id}
              className={`chat-message ${message.userId === scope.accountId ? 'chat-self' : ''}`}
            >
              <Avatar>
                <AvatarImage src={avatars[`${message.userId}:${message.avatarUpdatedAt}`]} alt="" />
                <AvatarFallback>{message.userName.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="chat-message-body">
                <div className="chat-message-meta">
                  <strong>{message.userName}</strong>
                  <time dateTime={new Date(message.timestamp).toISOString()}>
                    {new Date(message.timestamp).toLocaleString()}
                  </time>
                </div>
                <p>{message.content}</p>
              </div>
            </li>
          ))}
        </ol>
        {chat.pending.length ? (
          <section className="chat-pending" aria-label="Pending messages">
            <h2>Pending messages</h2>
            <p>Saved on this device. Retry uses the original message ID.</p>
            {chat.pending.map((message) => (
              <div className="chat-pending-message" key={message.id}>
                <p>{message.content}</p>
                <div className="chat-history-actions">
                  <Button
                    variant="outline"
                    disabled={!writable || !!chat.sending}
                    onClick={() => void chat.retry(message)}
                  >
                    Retry
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!!chat.sending}
                    onClick={() => void chat.discard(message.id)}
                  >
                    Discard draft
                  </Button>
                </div>
              </div>
            ))}
          </section>
        ) : null}
        <div ref={bottom} />
      </div>
      <form className="chat-composer" onSubmit={(event) => void submit(event)}>
        <Textarea
          aria-label="Message"
          rows={3}
          maxLength={4000}
          placeholder={canSend ? 'Message this vault…' : 'Read-only chat'}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={!canSend || !!chat.sending}
        />
        <Button type="submit" disabled={!writable || !text.trim() || !!chat.sending}>
          <Send data-icon="inline-start" />
          Send
        </Button>
      </form>
    </div>
  );
}
