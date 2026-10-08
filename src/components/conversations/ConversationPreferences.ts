export type ChatLayout = 'combined' | 'separate';
const layoutKey = 'collab.chat-layout';
export function readChatLayout(): ChatLayout {
  try {
    return localStorage.getItem(layoutKey) === 'separate' ? 'separate' : 'combined';
  } catch {
    return 'combined';
  }
}
export function saveChatLayout(layout: ChatLayout) {
  try {
    localStorage.setItem(layoutKey, layout);
  } catch {
    /* Storage may be unavailable. */
  }
}
const recentKey = (serverUrl: string, accountId: string) =>
  `collab.people-search:${JSON.stringify([serverUrl, accountId])}`;
export function readRecentSearches(serverUrl: string, accountId: string): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(recentKey(serverUrl, accountId)) ?? '[]',
    );
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === 'string' && item.length <= 200)
          .slice(0, 5)
      : [];
  } catch {
    return [];
  }
}
export function saveRecentSearches(serverUrl: string, accountId: string, searches: string[]) {
  try {
    localStorage.setItem(recentKey(serverUrl, accountId), JSON.stringify(searches.slice(0, 5)));
  } catch {
    /* Search remains usable without storage. */
  }
}
