export interface TeamSummary {
  id: string;
  name: string;
  role: 'owner' | 'member';
  archived: boolean;
  pinned?: boolean;
}
export interface TeamChannel {
  id: string;
  name: string;
  private: boolean;
  archived: boolean;
  libraryVaultId: string | null;
  unread: number;
}
export interface TeamMember {
  userId: string;
  displayName: string;
  role: 'owner' | 'member';
  active: boolean;
}
export interface TeamPerson {
  userId: string;
  displayName: string;
}
export type TeamRequest = <T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
) => Promise<T>;
