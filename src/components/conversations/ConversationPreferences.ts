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
export interface RecentPerson {
  userId: string;
  username: string;
  displayName: string;
}
const recentKey = (serverUrl: string, accountId: string) =>
  `collab.people-recent:${JSON.stringify([serverUrl, accountId])}`;
const short = (value: unknown) => typeof value === 'string' && value.length <= 200;
/** People recently opened from search, scoped to one server account. */
export function readRecentPeople(serverUrl: string, accountId: string): RecentPerson[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(recentKey(serverUrl, accountId)) ?? '[]',
    );
    return Array.isArray(value)
      ? value
          .filter(
            (item): item is RecentPerson =>
              !!item &&
              typeof item === 'object' &&
              short(item.userId) &&
              short(item.username) &&
              short(item.displayName),
          )
          .map(({ userId, username, displayName }) => ({ userId, username, displayName }))
          .slice(0, 5)
      : [];
  } catch {
    return [];
  }
}
export function saveRecentPeople(serverUrl: string, accountId: string, people: RecentPerson[]) {
  try {
    localStorage.setItem(recentKey(serverUrl, accountId), JSON.stringify(people.slice(0, 5)));
  } catch {
    /* Search remains usable without storage. */
  }
}
