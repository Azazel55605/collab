/** Ephemeral server advertisement for a running desktop presentation. */
export interface ActivePresentation {
  showId: string;
  vaultId: string;
  fileId: string;
  relativePath: string;
  title: string;
  slideId: string | null;
  position: number;
  total: number;
  remoteEnabled: boolean;
  updatedAt: string;
}

export interface ActivePresentationHeartbeat {
  vaultId: string;
  fileId: string;
  relativePath: string;
  title: string;
  slideId: string | null;
  position: number;
  total: number;
  remoteEnabled: boolean;
}
