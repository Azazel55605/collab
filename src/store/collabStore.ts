import { create } from 'zustand';
import type { PresenceEntry } from '../types/collab';
import type { ConflictInfo } from '../types/vault';

interface CollabState {
  myUserId: string;
  myUserName: string;
  myUserColor: string;
  peers: PresenceEntry[];
  conflicts: ConflictInfo[];
  setPeers: (peers: PresenceEntry[]) => void;
  addConflict: (conflict: ConflictInfo) => void;
  dismissConflict: (relativePath: string) => void;
  setMyProfile: (userId: string, userName: string, userColor: string) => void;
}

function generateColor(userId: string): string {
  const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899'];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export const useCollabStore = create<CollabState>()((set) => {
  const storedId = localStorage.getItem('collab-user-id');
  const userId = storedId ?? crypto.randomUUID();
  if (!storedId) localStorage.setItem('collab-user-id', userId);
  const storedName = localStorage.getItem('collab-user-name');
  const userName = storedName ?? `User ${userId.slice(0, 4)}`;
  const userColor = generateColor(userId);

  return {
    myUserId: userId,
    myUserName: userName,
    myUserColor: userColor,
    peers: [],
    conflicts: [],
    setPeers: (peers) => set({ peers }),
    addConflict: (conflict) =>
      set((state) => ({
        conflicts: [...state.conflicts.filter((c) => c.relativePath !== conflict.relativePath), conflict],
      })),
    dismissConflict: (relativePath) =>
      set((state) => ({ conflicts: state.conflicts.filter((c) => c.relativePath !== relativePath) })),
    setMyProfile: (myUserId, myUserName, myUserColor) => {
      localStorage.setItem('collab-user-id', myUserId);
      localStorage.setItem('collab-user-name', myUserName);
      set({ myUserId, myUserName, myUserColor });
    },
  };
});
