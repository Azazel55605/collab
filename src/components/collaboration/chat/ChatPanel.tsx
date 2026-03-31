import { useState, useRef, useEffect, useCallback } from 'react';
import { Send } from 'lucide-react';
import { useCollabStore } from '../../../store/collabStore';
import { useVaultStore } from '../../../store/vaultStore';
import { tauriCommands } from '../../../lib/tauri';
import type { ChatMessage } from '../../../types/collab';

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

export function ChatPanel() {
  const { vault } = useVaultStore();
  const { myUserId, myUserName, myUserColor, chatMessages, appendChatMessage } = useCollabStore();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const send = useCallback(async () => {
    const content = text.trim();
    if (!content || !vault || sending) return;
    setText('');
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
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-border p-2 flex gap-2 items-end">
        <textarea
          className="flex-1 resize-none bg-muted rounded-lg px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring min-h-[36px] max-h-[120px]"
          placeholder="Message... (Enter to send)"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending || !vault}
        />
        <button
          onClick={send}
          disabled={!text.trim() || sending || !vault}
          className="h-9 w-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
