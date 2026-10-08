import { type ChatPreferences, useChatPreferences } from '../../store/chatPreferences';
import { ChatStylePreview } from '../conversations/ChatStylePreview';
import { Button } from '../ui/button';
import { Separator } from '../ui/separator';

import { OptionRow, PillSelect, SectionLabel, ToggleSwitch } from './settingsControls';

const LABELS: Record<string, string> = {
  combined: 'Together',
  separate: 'Separate',
  mixed: 'Mixed',
  recent: 'Most recent',
  unread: 'Unread first',
  comfortable: 'Comfortable',
  compact: 'Compact',
  bubbles: 'Bubbles',
  flat: 'Flat',
  accent: 'Accent',
  neutral: 'Neutral',
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};
const label = (value: string) => LABELS[value] ?? value;

export default function SettingsChatsSection() {
  const preferences = useChatPreferences();
  const set = preferences.setChatPreference;
  const choose =
    <K extends keyof ChatPreferences>(key: K) =>
    (value: ChatPreferences[K]) =>
      set(key, value);
  return (
    <div>
      <SectionLabel>Preview</SectionLabel>
      <ChatStylePreview />

      <Separator className="bg-border/40 my-4" />
      <SectionLabel>Chat list</SectionLabel>
      <OptionRow
        label="Chats and teams"
        description="Show teams below your chats, or on their own tab."
      >
        <PillSelect
          options={['combined', 'separate'] as const}
          value={preferences.sidebarLayout}
          onChange={choose('sidebarLayout')}
          getLabel={label}
        />
      </OptionRow>
      <OptionRow
        label="Group chats"
        description="Mix group chats with direct chats, or list them in their own section."
      >
        <PillSelect
          options={['mixed', 'separate'] as const}
          value={preferences.groupChats}
          onChange={choose('groupChats')}
          getLabel={label}
        />
      </OptionRow>
      <OptionRow label="Sort" description="Pinned chats always stay at the top.">
        <PillSelect
          options={['recent', 'unread'] as const}
          value={preferences.sortOrder}
          onChange={choose('sortOrder')}
          getLabel={label}
        />
      </OptionRow>
      <OptionRow label="Density" description="Compact fits more chats and messages on screen.">
        <PillSelect
          options={['comfortable', 'compact'] as const}
          value={preferences.density}
          onChange={choose('density')}
          getLabel={label}
        />
      </OptionRow>
      <OptionRow label="Message previews" description="Show the latest message under each chat.">
        <ToggleSwitch
          ariaLabel="Message previews"
          checked={preferences.showPreviews}
          onToggle={() => set('showPreviews', !preferences.showPreviews)}
        />
      </OptionRow>

      <Separator className="bg-border/40 my-4" />
      <SectionLabel>Messages</SectionLabel>
      <OptionRow
        label="Message style"
        description="Bubbles put your messages on the right; flat lists everyone on the left."
      >
        <PillSelect
          options={['bubbles', 'flat'] as const}
          value={preferences.messageStyle}
          onChange={choose('messageStyle')}
          getLabel={label}
        />
      </OptionRow>
      <OptionRow label="Your message color" description="Tint your bubbles with the accent color.">
        <PillSelect
          options={['accent', 'neutral'] as const}
          value={preferences.bubbleColor}
          onChange={choose('bubbleColor')}
          getLabel={label}
          disabled={preferences.messageStyle === 'flat'}
        />
      </OptionRow>
      <OptionRow label="Text size">
        <PillSelect
          options={['small', 'medium', 'large'] as const}
          value={preferences.textSize}
          onChange={choose('textSize')}
          getLabel={label}
        />
      </OptionRow>
      <OptionRow
        label="Group consecutive messages"
        description="Show the name and time once for messages sent close together."
      >
        <ToggleSwitch
          ariaLabel="Group consecutive messages"
          checked={preferences.groupMessages}
          onToggle={() => set('groupMessages', !preferences.groupMessages)}
        />
      </OptionRow>
      <OptionRow
        label="Send with Enter"
        description="When off, Enter adds a new line and Ctrl+Enter sends."
      >
        <ToggleSwitch
          ariaLabel="Send with Enter"
          checked={preferences.enterToSend}
          onToggle={() => set('enterToSend', !preferences.enterToSend)}
        />
      </OptionRow>

      <Separator className="bg-border/40 my-4" />
      <OptionRow
        label="Pinned chats and teams"
        description="Right-click a chat or team, or use its ⋯ button, to pin it. Pins follow your account to every device."
      >
        <Button variant="outline" size="sm" onClick={preferences.resetChatPreferences}>
          Reset chat settings
        </Button>
      </OptionRow>
    </div>
  );
}
