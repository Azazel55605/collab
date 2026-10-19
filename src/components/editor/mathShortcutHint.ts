import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';

import { getActiveMathBlock } from './mathBlockCommands';

class MathShortcutHint extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const hint = document.createElement('span');
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const modifier = mac ? '⌘' : 'Ctrl+';
    hint.className = 'ml-4 select-none text-xs text-muted-foreground';
    hint.textContent = `${modifier}Enter evaluate · ${modifier}${mac ? '⌥' : 'Alt+'}Enter approximate`;
    hint.setAttribute('role', 'note');
    hint.setAttribute('aria-label', hint.textContent);
    return hint;
  }
}

function decorations(view: EditorView): DecorationSet {
  if (view.state.readOnly || !view.state.selection.main.empty) return Decoration.none;
  const block = getActiveMathBlock(view);
  const cursor = view.state.selection.main.head;
  if (!block || cursor < block.innerFrom || cursor > block.innerTo) return Decoration.none;
  return Decoration.set([
    Decoration.widget({ widget: new MathShortcutHint(), side: 1 }).range(
      Math.min(view.state.doc.lineAt(cursor).to, block.innerTo),
    ),
  ]);
}

export function createMathShortcutHintExtension() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorations(view);
      }
      update(update: import('@codemirror/view').ViewUpdate) {
        if (update.docChanged || update.selectionSet) this.decorations = decorations(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
