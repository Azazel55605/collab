import type { ReactNode } from 'react';

import { Ellipsis, Pin, PinOff, Users } from 'lucide-react';

import type { ChatPreferences } from '../../store/chatPreferences';
import type { ConversationSummary } from '../../types/conversation';
import { Button } from '../ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

import { chatPlainText, listTime, sortConversations } from './chatFormat';
import { UserAvatar } from './ConversationVisuals';

function rowPreview(row: ConversationSummary) {
  const prefix = row.lastMessageOwn ? 'You: ' : '';
  if (row.lastMessageDeleted) return `${prefix}This message was deleted.`;
  if (row.lastMessage) return prefix + chatPlainText(row.lastMessage);
  return row.kind === 'group' ? 'Group chat' : 'Direct chat';
}

export function PinMenuItems({
  pinned,
  label,
  toggle,
  Item,
}: {
  pinned: boolean;
  label: string;
  toggle: () => void;
  Item: typeof DropdownMenuItem | typeof ContextMenuItem;
}) {
  return (
    <Item onSelect={toggle}>
      {pinned ? <PinOff size={15} /> : <Pin size={15} />}
      {pinned ? `Unpin ${label}` : `Pin ${label}`}
    </Item>
  );
}

/**
 * A list row with a right-click (long-press on touch) menu and a hover "More"
 * button, both offering pin/unpin.
 */
export function PinnableRow({
  pinned,
  label,
  togglePin,
  disabled,
  describedBy,
  children,
}: {
  pinned: boolean;
  label: string;
  togglePin: () => void;
  disabled?: boolean;
  /** Id of the element naming the row, so the generic button has context. */
  describedBy?: string;
  children: ReactNode;
}) {
  return (
    <div className="conversation-row-wrap">
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={disabled}>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent className="conversation-message-menu">
          <PinMenuItems pinned={pinned} label={label} toggle={togglePin} Item={ContextMenuItem} />
        </ContextMenuContent>
      </ContextMenu>
      {!disabled && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="conversation-row-more"
              aria-label="More options"
              aria-describedby={describedBy}
            >
              <Ellipsis size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="conversation-message-menu">
            <PinMenuItems
              pinned={pinned}
              label={label}
              toggle={togglePin}
              Item={DropdownMenuItem}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function ConversationRow({
  serverUrl,
  row,
  selected,
  connected,
  open,
  togglePin,
}: {
  serverUrl: string;
  row: ConversationSummary;
  selected: boolean;
  connected: boolean;
  open: (id: string) => void;
  togglePin: (row: ConversationSummary) => void;
}) {
  return (
    <PinnableRow
      pinned={!!row.pinned}
      label={row.name}
      togglePin={() => togglePin(row)}
      disabled={!connected}
      describedBy={`conversation-row-name-${row.id}`}
    >
      <Button
        variant="ghost"
        className="conversation-row"
        aria-pressed={selected}
        disabled={!connected}
        onClick={() => open(row.id)}
      >
        <UserAvatar
          serverUrl={serverUrl}
          userId={row.kind === 'direct' ? row.peerUserId : undefined}
          name={row.name}
          picture={row.picture}
        >
          {row.kind === 'group' ? <Users size={18} /> : undefined}
        </UserAvatar>
        <span className="conversation-row-body">
          <span className="conversation-row-line">
            <span className="conversation-row-name" id={`conversation-row-name-${row.id}`}>
              {row.name}
            </span>
            {row.pinned && <Pin size={12} className="conversation-pin-mark" aria-label="Pinned" />}
            {row.lastMessageAt && (
              <time dateTime={new Date(row.lastMessageAt).toISOString()}>
                {listTime(row.lastMessageAt)}
              </time>
            )}
          </span>
          <span className="conversation-row-line">
            <small>{rowPreview(row)}</small>
            {row.unread > 0 && (
              <span className="conversation-unread" aria-label={`${row.unread} unread messages`}>
                {row.unread > 99 ? '99+' : row.unread}
              </span>
            )}
          </span>
        </span>
      </Button>
    </PinnableRow>
  );
}

export function ConversationList({
  serverUrl,
  rows,
  pinned,
  selectedId,
  connected,
  preferences,
  open,
  togglePin,
  footer,
}: {
  serverUrl: string;
  rows: ConversationSummary[];
  pinned: ConversationSummary[];
  selectedId?: string;
  connected: boolean;
  preferences: Pick<ChatPreferences, 'groupChats' | 'sortOrder'>;
  open: (id: string) => void;
  togglePin: (row: ConversationSummary) => void;
  footer?: ReactNode;
}) {
  const pinnedIds = new Set(pinned.map((row) => row.id));
  const chats = sortConversations(
    rows.filter((row) => row.kind !== 'channel' && !pinnedIds.has(row.id)),
    preferences.sortOrder,
  );
  const sections: { id: string; title: string; rows: ConversationSummary[] }[] = [
    { id: 'pinned', title: 'Pinned', rows: sortConversations(pinned, preferences.sortOrder) },
    ...(preferences.groupChats === 'separate'
      ? [
          { id: 'direct', title: 'Chats', rows: chats.filter((row) => row.kind === 'direct') },
          { id: 'group', title: 'Group chats', rows: chats.filter((row) => row.kind === 'group') },
        ]
      : [{ id: 'all', title: 'Recent', rows: chats }]),
  ].filter((section) => section.rows.length);
  // Headings only help when there is more than one section to tell apart.
  const headed = sections.length > 1;
  return (
    <nav aria-label="Conversations">
      {sections.map((section) => (
        <section
          key={section.id}
          className="conversation-list-section"
          aria-label={headed ? section.title : undefined}
        >
          {headed && (
            <h2 className="conversation-list-heading">
              {section.id === 'pinned' && <Pin size={12} aria-hidden="true" />}
              {section.title}
            </h2>
          )}
          {section.rows.map((row) => (
            <ConversationRow
              key={row.id}
              serverUrl={serverUrl}
              row={row}
              selected={selectedId === row.id}
              connected={connected}
              open={open}
              togglePin={togglePin}
            />
          ))}
        </section>
      ))}
      {footer}
    </nav>
  );
}
