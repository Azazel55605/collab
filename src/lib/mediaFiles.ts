export const VIDEO_EXTENSIONS = ['mp4', 'webm'];
export const AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac'];
export const CAPTION_EXTENSIONS = ['vtt', 'srt'];
export const LOCAL_MEDIA_EXTENSIONS = [
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...CAPTION_EXTENSIONS,
  'lrc',
];

function extensionOf(path: string) {
  return path.match(/\.([^./\\]+)$/)?.[1].toLowerCase() ?? '';
}

export function mediaKind(extension: string): 'video' | 'audio' | null {
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  if (AUDIO_EXTENSIONS.includes(extension)) return 'audio';
  return null;
}

export function isCaptionPath(path: string) {
  return CAPTION_EXTENSIONS.includes(extensionOf(path));
}

export function mediaKindForPath(path: string) {
  return mediaKind(extensionOf(path));
}

export function isLyricsPath(path: string) {
  return extensionOf(path) === 'lrc';
}

export function isMediaSidecarPath(path: string) {
  return isCaptionPath(path) || isLyricsPath(path);
}
