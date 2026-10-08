import { MessageCircle, MessagesSquare } from 'lucide-react';

import { ChatStylePreview } from '../../../../src/components/conversations/ChatStylePreview';
import { type ChatPreferences, useChatPreferences } from '../../../../src/store/chatPreferences';

type Choice<K extends keyof ChatPreferences> = readonly [ChatPreferences[K], string][];

function Segmented<K extends keyof ChatPreferences>({
  name,
  title,
  description,
  choices,
}: {
  name: K;
  title: string;
  description?: string;
  choices: Choice<K>;
}) {
  const value = useChatPreferences((state) => state[name]);
  const set = useChatPreferences((state) => state.setChatPreference);
  return (
    <div className="setting-row stacked">
      <div>
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </div>
      <div className="segmented-control" role="radiogroup" aria-label={title}>
        {choices.map(([option, label]) => (
          <button
            key={String(option)}
            type="button"
            role="radio"
            aria-checked={value === option}
            className={value === option ? 'selected' : ''}
            onClick={() => set(name, option)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({
  name,
  title,
  description,
}: {
  name: 'showPreviews' | 'groupMessages' | 'enterToSend';
  title: string;
  description: string;
}) {
  const value = useChatPreferences((state) => state[name]);
  const set = useChatPreferences((state) => state.setChatPreference);
  return (
    <label className="toggle-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={value}
        onChange={(event) => set(name, event.currentTarget.checked)}
      />
    </label>
  );
}

export function ChatSettingsSection() {
  const reset = useChatPreferences((state) => state.resetChatPreferences);
  return (
    <>
      <section className="card">
        <div className="card-title">
          <MessageCircle size={18} aria-hidden />
          <span>Chat list</span>
        </div>
        <ChatStylePreview />
        <Segmented
          name="sidebarLayout"
          title="Chats and teams"
          description="Teams below your chats, or on their own tab."
          choices={[
            ['combined', 'Together'],
            ['separate', 'Separate'],
          ]}
        />
        <Segmented
          name="groupChats"
          title="Group chats"
          description="Mixed with direct chats, or in their own section."
          choices={[
            ['mixed', 'Mixed'],
            ['separate', 'Separate'],
          ]}
        />
        <Segmented
          name="sortOrder"
          title="Sort"
          description="Pinned chats always stay at the top."
          choices={[
            ['recent', 'Recent'],
            ['unread', 'Unread'],
          ]}
        />
        <Segmented
          name="density"
          title="Density"
          choices={[
            ['comfortable', 'Comfortable'],
            ['compact', 'Compact'],
          ]}
        />
        <Toggle
          name="showPreviews"
          title="Message previews"
          description="Show the latest message under each chat."
        />
      </section>
      <section className="card">
        <div className="card-title">
          <MessagesSquare size={18} aria-hidden />
          <span>Messages</span>
        </div>
        <Segmented
          name="messageStyle"
          title="Message style"
          description="Bubbles put yours on the right; flat lists everyone on the left."
          choices={[
            ['bubbles', 'Bubbles'],
            ['flat', 'Flat'],
          ]}
        />
        <Segmented
          name="bubbleColor"
          title="Your message color"
          choices={[
            ['accent', 'Accent'],
            ['neutral', 'Neutral'],
          ]}
        />
        <Segmented
          name="textSize"
          title="Text size"
          choices={[
            ['small', 'S'],
            ['medium', 'M'],
            ['large', 'L'],
          ]}
        />
        <Toggle
          name="groupMessages"
          title="Group consecutive messages"
          description="Show the name and time once for messages sent close together."
        />
        <Toggle
          name="enterToSend"
          title="Send with Enter"
          description="When off, Enter adds a new line and the send button sends."
        />
        <p className="footnote">
          Long-press a chat or team to pin it. Pins follow your account to every device.
        </p>
        <button type="button" className="ghost-button" onClick={reset}>
          Reset chat settings
        </button>
      </section>
    </>
  );
}
