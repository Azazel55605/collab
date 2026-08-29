export type EditorShortcutEventLike = {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  preventDefault: () => void;
};

const asciiLetterOrDigit = /^[a-z0-9]$/i;
const codeKeyMatch = /^(?:Key([A-Z])|Digit([0-9]))$/;

export function hasPrimaryModifier(event: Pick<EditorShortcutEventLike, 'ctrlKey' | 'metaKey'>) {
  return event.ctrlKey || event.metaKey;
}

export function getEditorShortcutKey(
  event: Pick<EditorShortcutEventLike, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey'>,
) {
  if (asciiLetterOrDigit.test(event.key)) return event.key.toLowerCase();

  if (event.altKey && hasPrimaryModifier(event) && event.code) {
    const codeMatch = codeKeyMatch.exec(event.code);
    if (codeMatch) return (codeMatch[1] ?? codeMatch[2]).toLowerCase();
  }

  return event.key.toLowerCase();
}
