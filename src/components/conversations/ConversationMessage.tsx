import { useState } from 'react';

import { Ban, Copy, Ellipsis, Pencil, Reply, SmilePlus, Trash2 } from 'lucide-react';

import type { HostedChatPageMessage } from '../../types/chat';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

import { chatPlainText, messageTime } from './chatFormat';
import { ConversationMarkdown } from './ConversationMarkdown';
import { UserAvatar } from './ConversationVisuals';
import { QUICK_REACTIONS } from './emojiData';
import { EmojiPicker } from './EmojiPicker';

export interface MessageActions {
  react: (message: HostedChatPageMessage, emoji: string, reacted: boolean) => void;
  reply: (message: HostedChatPageMessage) => void;
  edit: (message: HostedChatPageMessage) => void;
  remove: (message: HostedChatPageMessage) => Promise<void>;
  jump: (id: string) => void;
}

export function ConversationMessageItem({
  serverUrl,
  message,
  own,
  continued,
  enabled,
  actions,
  flat = false,
}: {
  serverUrl: string;
  message: HostedChatPageMessage;
  own: boolean;
  continued: boolean;
  /** Flat style lists every message left-aligned with its author, no bubbles. */
  flat?: boolean;
  /** False while offline: history stays readable but cannot change. */
  enabled: boolean;
  actions: MessageActions;
}) {
  // Menus and pickers keep the toolbar visible after the pointer leaves.
  const [pinned, setPinned] = useState<'emoji' | 'menu' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const deleted = !!message.deleted;
  // Flat style names the sender even for your own messages.
  const name = own && !flat ? 'You' : message.userName;
  const aligned = own && !flat;
  const reactions = message.reactions ?? [];
  const react = (emoji: string) => {
    const mine = reactions.some((reaction) => reaction.emoji === emoji && reaction.mine);
    actions.react(message, emoji, !mine);
  };
  return (
    <article
      id={`conversation-message-${message.id}`}
      className={[
        'conversation-message',
        aligned && 'own',
        own && 'mine',
        continued && 'continued',
        deleted && 'deleted',
        pinned && 'pinned',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {!aligned && !continued && (
        <UserAvatar serverUrl={serverUrl} userId={message.userId} name={message.userName} />
      )}
      <div className="conversation-message-body">
        <header className={continued ? 'conversation-visually-hidden' : undefined}>
          <strong className={aligned ? 'conversation-visually-hidden' : undefined}>{name}</strong>
          <time dateTime={new Date(message.timestamp).toISOString()}>
            {messageTime(message.timestamp)}
          </time>
          {message.editedAt && !deleted && <span className="conversation-edited">Edited</span>}
        </header>
        <div
          className="conversation-bubble"
          // Focusable so touch and keyboard users can reach the actions.
          tabIndex={deleted ? undefined : 0}
          aria-label={deleted ? undefined : `Message from ${name}`}
        >
          {message.replyTo && !deleted && (
            <Button
              type="button"
              variant="ghost"
              className="conversation-reply-quote"
              aria-label={`Show the message from ${message.replyTo.userName}`}
              onClick={() => actions.jump(message.replyTo!.id)}
            >
              <strong>{message.replyTo.userName}</strong>
              <span>
                {message.replyTo.content
                  ? chatPlainText(message.replyTo.content)
                  : 'The original message is unavailable.'}
              </span>
            </Button>
          )}
          {deleted ? (
            <p className="conversation-deleted-text">
              <Ban size={14} aria-hidden="true" />
              This message was deleted.
            </p>
          ) : (
            <ConversationMarkdown content={message.content} />
          )}
          {continued && message.editedAt && !deleted && (
            <span className="conversation-edited inline">Edited</span>
          )}
        </div>
        {!!reactions.length && (
          <div className="conversation-reactions" aria-label="Reactions">
            {reactions.map((reaction) => (
              <Button
                key={reaction.emoji}
                type="button"
                variant="ghost"
                className="conversation-reaction"
                aria-pressed={reaction.mine}
                aria-label={`${reaction.emoji} ${reaction.count}${reaction.mine ? ', including you' : ''}`}
                disabled={!enabled}
                onClick={() => react(reaction.emoji)}
              >
                <span aria-hidden="true">{reaction.emoji}</span>
                <span aria-hidden="true">{reaction.count}</span>
              </Button>
            ))}
          </div>
        )}
        {!deleted && enabled && (
          <div className="conversation-message-actions" role="toolbar" aria-label="Message actions">
            {QUICK_REACTIONS.map((emoji) => (
              <Button
                key={emoji}
                type="button"
                variant="ghost"
                size="icon"
                className="conversation-quick-reaction"
                aria-label={`React with ${emoji}`}
                onClick={() => react(emoji)}
              >
                {emoji}
              </Button>
            ))}
            <EmojiPicker
              label="More reactions"
              side="top"
              align={aligned ? 'end' : 'start'}
              open={pinned === 'emoji'}
              onOpenChange={(open) => setPinned(open ? 'emoji' : null)}
              onPick={(emoji) => {
                setPinned(null);
                react(emoji);
              }}
            >
              <Button type="button" variant="ghost" size="icon" aria-label="More reactions">
                <SmilePlus size={16} />
              </Button>
            </EmojiPicker>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Reply"
              onClick={() => actions.reply(message)}
            >
              <Reply size={16} />
            </Button>
            <DropdownMenu onOpenChange={(open) => setPinned(open ? 'menu' : null)}>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" aria-label="More message actions">
                  <Ellipsis size={16} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="conversation-message-menu">
                {own && (
                  <DropdownMenuItem onSelect={() => actions.edit(message)}>
                    <Pencil size={15} />
                    Edit
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={() => void navigator.clipboard?.writeText(message.content)}
                >
                  <Copy size={15} />
                  Copy text
                </DropdownMenuItem>
                {own && (
                  <DropdownMenuItem
                    className="conversation-menu-danger"
                    onSelect={() => setConfirming(true)}
                  >
                    <Trash2 size={15} />
                    Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        {confirming && (
          <div className="conversation-delete-confirm" role="group" aria-label="Delete message">
            <span>Delete this message for everyone?</span>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || !enabled}
              onClick={async () => {
                setBusy(true);
                try {
                  await actions.remove(message);
                  setConfirming(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Delete
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}
