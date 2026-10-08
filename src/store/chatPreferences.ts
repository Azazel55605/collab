import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Device-local presentation preferences for Chats, shared by the desktop app
 * and the Android companion. Pins are not here: they belong to the server
 * account and sync across devices.
 */
export type ChatSidebarLayout = 'combined' | 'separate';
export type ChatGrouping = 'mixed' | 'separate';
export type ChatSort = 'recent' | 'unread';
export type ChatDensity = 'comfortable' | 'compact';
export type ChatMessageStyle = 'bubbles' | 'flat';
export type ChatBubbleColor = 'accent' | 'neutral';
export type ChatTextSize = 'small' | 'medium' | 'large';

export interface ChatPreferences {
  /** Chats and teams in one list, or on separate tabs. */
  sidebarLayout: ChatSidebarLayout;
  /** Group chats mixed with direct chats, or in their own section. */
  groupChats: ChatGrouping;
  sortOrder: ChatSort;
  density: ChatDensity;
  showPreviews: boolean;
  messageStyle: ChatMessageStyle;
  bubbleColor: ChatBubbleColor;
  textSize: ChatTextSize;
  /** Merge consecutive messages from one sender under one header. */
  groupMessages: boolean;
  /** Enter sends (Shift+Enter for a line); otherwise Ctrl/Cmd+Enter sends. */
  enterToSend: boolean;
}

export const DEFAULT_CHAT_PREFERENCES: ChatPreferences = {
  sidebarLayout: 'combined',
  groupChats: 'mixed',
  sortOrder: 'recent',
  density: 'comfortable',
  showPreviews: true,
  messageStyle: 'bubbles',
  bubbleColor: 'accent',
  textSize: 'medium',
  groupMessages: true,
  enterToSend: true,
};

/** The pre-settings layout toggle wrote this key; carry its choice over once. */
const LEGACY_LAYOUT_KEY = 'collab.chat-layout';
function legacyLayout(): Partial<ChatPreferences> {
  try {
    return localStorage.getItem(LEGACY_LAYOUT_KEY) === 'separate'
      ? { sidebarLayout: 'separate' }
      : {};
  } catch {
    return {};
  }
}

const choices: { [K in keyof ChatPreferences]: readonly ChatPreferences[K][] } = {
  sidebarLayout: ['combined', 'separate'],
  groupChats: ['mixed', 'separate'],
  sortOrder: ['recent', 'unread'],
  density: ['comfortable', 'compact'],
  showPreviews: [true, false],
  messageStyle: ['bubbles', 'flat'],
  bubbleColor: ['accent', 'neutral'],
  textSize: ['small', 'medium', 'large'],
  groupMessages: [true, false],
  enterToSend: [true, false],
};
/** Drops unknown or malformed stored values instead of trusting storage. */
export function sanitizeChatPreferences(value: unknown): ChatPreferences {
  const stored = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const result = { ...DEFAULT_CHAT_PREFERENCES };
  for (const key of Object.keys(choices) as (keyof ChatPreferences)[]) {
    if ((choices[key] as readonly unknown[]).includes(stored[key]))
      (result as Record<string, unknown>)[key] = stored[key];
  }
  return result;
}

export const useChatPreferences = create<
  ChatPreferences & {
    setChatPreference: <K extends keyof ChatPreferences>(key: K, value: ChatPreferences[K]) => void;
    resetChatPreferences: () => void;
  }
>()(
  persist(
    (set) => ({
      ...DEFAULT_CHAT_PREFERENCES,
      ...legacyLayout(),
      setChatPreference: (key, value) => set({ [key]: value } as Partial<ChatPreferences>),
      resetChatPreferences: () => set(DEFAULT_CHAT_PREFERENCES),
    }),
    {
      name: 'collab.chat-preferences',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => sanitizeChatPreferences(state),
      merge: (persisted, current) => ({
        ...current,
        ...sanitizeChatPreferences({ ...current, ...(persisted as object) }),
      }),
    },
  ),
);
