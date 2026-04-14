import { useState, useRef, useEffect, useCallback } from 'react';
import { Send } from 'lucide-react';
import { useCollabStore } from '../../../store/collabStore';
import { useVaultStore } from '../../../store/vaultStore';
import { useUiStore } from '../../../store/uiStore';
import { tauriCommands } from '../../../lib/tauri';
import type { ChatMessage } from '../../../types/collab';
import { Button } from '../../ui/button';
import { Textarea } from '../../ui/textarea';

function MessageRow({ msg, isSelf }: { msg: ChatMessage; isSelf: boolean }) {
  const date = new Date(msg.timestamp);
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`flex gap-2 px-3 py-1.5 ${isSelf ? 'flex-row-reverse' : ''}`}>
      <div
        className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold text-white mt-0.5"
        style={{ backgroundColor: msg.userColor }}
      >
        {msg.userName.slice(0, 1).toUpperCase()}
      </div>
      <div className={`flex flex-col max-w-[75%] ${isSelf ? 'items-end' : ''}`}>
        <div className="flex items-baseline gap-1.5 mb-0.5">
          {!isSelf && <span className="text-xs font-medium">{msg.userName}</span>}
          <span className="text-[10px] text-muted-foreground">{timeStr}</span>
        </div>
        <div
          className={`px-2.5 py-1.5 rounded-xl text-sm break-words whitespace-pre-wrap ${
            isSelf ? 'bg-primary text-primary-foreground' : 'bg-muted'
          }`}
        >
          {msg.content}
        </div>
      </div>
    </div>
  );
}

function TypingIndicator({ users }: { users: Array<{ userId: string; userName: string; userColor: string }> }) {
  const names = users.map((user) => user.userName);
  const label = names.length === 1
    ? `${names[0]} is typing...`
    : names.length === 2
      ? `${names[0]} and ${names[1]} are typing...`
      : `${names[0]} and ${names.length - 1} others are typing...`;

  return (
    <div className="px-3 py-1.5">
      <div className="inline-flex items-center gap-2 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
        <div className="flex -space-x-1">
          {users.slice(0, 3).map((user) => (
            <div
              key={user.userId}
              className="h-5 w-5 rounded-full border border-background text-[10px] font-semibold text-white flex items-center justify-center"
              style={{ backgroundColor: user.userColor }}
              title={user.userName}
            >
              {user.userName.slice(0, 1).toUpperCase()}
            </div>
          ))}
        </div>
        <span>{label}</span>
        <span className="flex items-end gap-0.5">
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60 animate-bounce [animation-delay:-0.3s]" />
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-75 animate-bounce [animation-delay:-0.15s]" />
          <span className="h-1.5 w-1.5 rounded-full bg-current animate-bounce" />
        </span>
      </div>
    </div>
  );
}

export function ChatPanel() {
  const { vault } = useVaultStore();
  const { isSidebarOpen, sidebarPanel, collabTab } = useUiStore();
  const {
    myUserId,
    myUserName,
    myUserColor,
    peers,
    chatMessages,
    appendChatMessage,
    setChatTypingUntil,
  } = useCollabStore();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [typingNow, setTypingNow] = useState(() => Date.now());
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastTypingPublishRef = useRef(0);
  const isChatVisible = isSidebarOpen && sidebarPanel === 'collab' && collabTab === 'chat';
  const typingUsers = peers.filter((peer) => (peer.chatTypingUntil ?? 0) > typingNow);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  useEffect(() => {
    if (!isChatVisible) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isChatVisible]);

  useEffect(() => {
    return () => setChatTypingUntil(null);
  }, [setChatTypingUntil]);

  useEffect(() => {
    if (typingUsers.length === 0) return;
    const interval = window.setInterval(() => setTypingNow(Date.now()), 500);
    return () => window.clearInterval(interval);
  }, [typingUsers.length]);

  const publishTypingState = useCallback((value: string, force = false) => {
    const now = Date.now();
    const nextTypingUntil = value.trim() ? now + 3000 : null;
    if (!force && nextTypingUntil && now - lastTypingPublishRef.current < 1000) {
      return;
    }
    lastTypingPublishRef.current = now;
    setChatTypingUntil(nextTypingUntil);
  }, [setChatTypingUntil]);

  const send = useCallback(async () => {
    const content = text.trim();
    if (!content || !vault || sending) return;
    setText('');
    publishTypingState('', true);
    setSending(true);
    const msg = {
      id: crypto.randomUUID(),
      userId: myUserId,
      userName: myUserName,
      userColor: myUserColor,
      content,
      timestamp: Date.now(),
    };
    // Optimistically show the message immediately; collab:chat-updated will
    // fire after the 500ms watcher debounce and replace the list (idempotent).
    appendChatMessage(msg);
    try {
      await tauriCommands.sendChatMessage(vault.path, msg);
    } catch {
      setText(content);
    } finally {
      setSending(false);
    }
  }, [text, vault, myUserId, myUserName, myUserColor, sending]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto py-2 min-h-0">
        {chatMessages.length === 0 ? (
          <p className="px-3 py-8 text-xs text-muted-foreground text-center">
            No messages yet. Say hello!
          </p>
        ) : (
          chatMessages.map((msg) => (
            <MessageRow key={msg.id} msg={msg} isSelf={msg.userId === myUserId} />
          ))
        )}
        {typingUsers.length > 0 && <TypingIndicator users={typingUsers} />}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-border p-2 flex gap-2 items-end">
        <Textarea
          ref={inputRef}
          className="flex-1 min-h-[36px] max-h-[120px] resize-none bg-muted border-transparent px-3 py-2"
          placeholder="Message... (Enter to send)"
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            publishTypingState(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => publishTypingState('', true)}
          onFocus={() => publishTypingState(text, true)}
          disabled={sending || !vault}
        />
        <Button
          onClick={send}
          disabled={!text.trim() || sending || !vault}
          size="icon"
          className="h-9 w-9 rounded-lg flex-shrink-0"
        >
          <Send size={14} />
        </Button>
      </div>
    </div>
  );
}
