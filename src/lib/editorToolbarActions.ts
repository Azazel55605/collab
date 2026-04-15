export type EditorToolbarAction =
  | 'icon'
  | 'table'
  | 'link'
  | 'image'
  | 'taskList'
  | 'math'
  | 'code';

export const EDITOR_TOOLBAR_ACTION_EVENT = 'editor:toolbar-action';

export function dispatchEditorToolbarAction(action: EditorToolbarAction) {
  window.dispatchEvent(new CustomEvent<{ action: EditorToolbarAction }>(EDITOR_TOOLBAR_ACTION_EVENT, {
    detail: { action },
  }));
}
