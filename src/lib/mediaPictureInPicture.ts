import { create } from 'zustand';

export const useFloatingMedia = create<{ path: string | null }>(() => ({ path: null }));

export function isFloatingVideo(media: HTMLMediaElement | null) {
  return media !== null && document.pictureInPictureElement === media;
}

export function exitFloatingVideo(media: HTMLMediaElement) {
  if (isFloatingVideo(media)) void document.exitPictureInPicture().catch(() => {});
}
