import { create } from 'zustand';

interface ConversationDestination {
  serverUrl: string;
  accountId: string;
  conversationId: string;
}
export const useConversationNavigation = create<{
  destination: ConversationDestination | null;
  open: (destination: ConversationDestination) => void;
  clear: () => void;
}>((set) => ({
  destination: null,
  open: (destination) => set({ destination }),
  clear: () => set({ destination: null }),
}));
