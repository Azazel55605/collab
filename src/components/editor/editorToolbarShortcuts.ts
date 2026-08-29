import {
  dispatchEditorToolbarAction,
  type EditorToolbarAction,
} from '../../lib/editorToolbarActions';

import {
  type EditorShortcutEventLike,
  getEditorShortcutKey,
  hasPrimaryModifier,
} from './editorShortcutKeys';

const toolbarShortcutActions: Record<string, EditorToolbarAction> = {
  s: 'icon',
  t: 'table',
  l: 'link',
  i: 'image',
  k: 'taskList',
  m: 'math',
  c: 'code',
  n: 'snippets',
};

export function handleEditorToolbarShortcutKeydown(event: EditorShortcutEventLike) {
  if (!hasPrimaryModifier(event) || !event.altKey || event.shiftKey) return false;

  const action = toolbarShortcutActions[getEditorShortcutKey(event)];
  if (!action) return false;

  event.preventDefault();
  dispatchEditorToolbarAction(action);
  return true;
}
