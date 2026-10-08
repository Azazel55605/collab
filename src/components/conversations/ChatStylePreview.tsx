import { type ChatPreferences, useChatPreferences } from '../../store/chatPreferences';
import type { HostedChatPageMessage } from '../../types/chat';

import { ConversationList } from './ConversationList';
import { ConversationMessageItem, type MessageActions } from './ConversationMessage';
import './conversations.css';

const now = Date.now();
const sample = (
  id: string,
  userId: string,
  userName: string,
  content: string,
  minutes: number,
): HostedChatPageMessage => ({
  id,
  userId,
  userName,
  content,
  timestamp: now - minutes * 60_000,
  sequence: id,
  userColor: '',
  hasAvatar: false,
  avatarUpdatedAt: null,
});
const messages = [
  sample('1', 'sam', 'Sam', 'Did you see the **new layout**?', 6),
  sample('2', 'sam', 'Sam', 'It groups chats and teams.', 5),
  sample('3', 'me', 'You', 'Looks great, shipping it 🚀', 2),
];
const inert: MessageActions = {
  react: () => {},
  reply: () => {},
  edit: () => {},
  remove: async () => {},
  jump: () => {},
};

/** Live, non-interactive sample of the current chat preferences. */
export function ChatStylePreview({ preferences }: { preferences?: ChatPreferences }) {
  const stored = useChatPreferences();
  const prefs = preferences ?? stored;
  return (
    <div
      className="conversation-workspace conversation-style-preview"
      aria-label="Chat style preview"
      role="img"
      data-density={prefs.density}
      data-previews={prefs.showPreviews ? 'shown' : 'hidden'}
      data-message-style={prefs.messageStyle}
      data-bubble-color={prefs.bubbleColor}
      data-text-size={prefs.textSize}
    >
      <div className="conversation-style-preview-list" inert>
        <ConversationList
          serverUrl=""
          rows={[
            {
              id: 'preview',
              kind: 'direct',
              name: 'Sam',
              role: 'member',
              lastSequence: '3',
              readSequence: '2',
              unread: 1,
              updatedCursor: '3',
              picture: null,
              lastMessage: 'Looks great, shipping it 🚀',
              lastMessageAt: now - 2 * 60_000,
            },
          ]}
          pinned={[]}
          selectedId="preview"
          connected
          preferences={prefs}
          open={() => {}}
          togglePin={() => {}}
        />
      </div>
      <div className="conversation-style-preview-messages" inert>
        {messages.map((message, index) => (
          <ConversationMessageItem
            key={message.id}
            serverUrl=""
            message={message}
            own={message.userId === 'me'}
            flat={prefs.messageStyle === 'flat'}
            continued={
              prefs.groupMessages && index > 0 && messages[index - 1].userId === message.userId
            }
            enabled={false}
            actions={inert}
          />
        ))}
      </div>
    </div>
  );
}
