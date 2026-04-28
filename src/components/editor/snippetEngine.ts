import {
  EditorSelection,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from '@codemirror/state';
import { keymap, EditorView, Decoration } from '@codemirror/view';

type PlaceholderRange = { from: number; to: number };

type ParsedSnippet = {
  text: string;
  placeholders: PlaceholderRange[];
  cursorPos: number | null;
};

type SnippetSession = {
  placeholders: PlaceholderRange[];
  index: number;
  finalCursor: number | null;
};

const PLACEHOLDER_RE = /<placeholder:([^>]+)>|<cursor>/g;

const setSnippetSessionEffect = StateEffect.define<SnippetSession | null>();
const clearSnippetSessionEffect = StateEffect.define<null>();

export function parseSnippetTemplate(template: string): ParsedSnippet {
  let text = '';
  let cursorPos: number | null = null;
  const placeholders: PlaceholderRange[] = [];
  let lastIndex = 0;

  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    const [fullMatch, placeholderLabel] = match;
    const matchIndex = match.index ?? 0;
    text += template.slice(lastIndex, matchIndex);
    if (fullMatch === '<cursor>') {
      cursorPos = text.length;
    } else {
      const label = placeholderLabel ?? 'value';
      const from = text.length;
      text += label;
      placeholders.push({ from, to: from + label.length });
    }
    lastIndex = matchIndex + fullMatch.length;
  }

  text += template.slice(lastIndex);
  return { text, placeholders, cursorPos };
}

const snippetSessionField = StateField.define<SnippetSession | null>({
  create() {
    return null;
  },
  update(value, tr) {
    let next = value;
    let setExplicitly = false;
    for (const effect of tr.effects) {
      if (effect.is(setSnippetSessionEffect)) {
        next = effect.value;
        setExplicitly = true;
      }
      if (effect.is(clearSnippetSessionEffect)) {
        next = null;
      }
    }
    if (!next) return null;
    if (tr.docChanged && !setExplicitly) {
      next = {
        ...next,
        placeholders: next.placeholders.map((range) => ({
          from: tr.changes.mapPos(range.from, 1),
          to: tr.changes.mapPos(range.to, -1),
        })),
        finalCursor: next.finalCursor === null ? null : tr.changes.mapPos(next.finalCursor, -1),
      };
    }
    return next;
  },
  provide(field) {
    return [
      EditorView.decorations.from(field, (value) => {
        if (!value) return Decoration.none;
        const builder = new RangeSetBuilder<Decoration>();
        for (let index = 0; index < value.placeholders.length; index += 1) {
          const range = value.placeholders[index];
          if (range.from >= range.to) continue;
          builder.add(
            range.from,
            range.to,
            Decoration.mark({
              class: index === value.index ? 'cm-snippet-placeholder-active' : 'cm-snippet-placeholder',
            }),
          );
        }
        return builder.finish();
      }),
    ];
  },
});

function moveSnippetSelection(view: EditorView, direction: 1 | -1) {
  const session = view.state.field(snippetSessionField, false);
  if (!session) return false;
  const current = session.placeholders[session.index];
  const selection = view.state.selection.main;
  if (!current || selection.from !== current.from || selection.to !== current.to) {
    return false;
  }

  const nextIndex = session.index + direction;
  if (nextIndex < 0 || nextIndex >= session.placeholders.length) {
    if (direction === 1) {
      const anchor = session.finalCursor ?? current.to;
      view.dispatch({
        selection: { anchor },
        effects: clearSnippetSessionEffect.of(null),
      });
      view.focus();
      return true;
    }
    return false;
  }

  const nextRange = session.placeholders[nextIndex];
  view.dispatch({
    selection: EditorSelection.single(nextRange.from, nextRange.to),
    effects: setSnippetSessionEffect.of({
      ...session,
      index: nextIndex,
    }),
  });
  view.focus();
  return true;
}

export function createSnippetSessionExtension(): Extension {
  return [
    snippetSessionField,
    keymap.of([
      { key: 'Tab', run: (view) => moveSnippetSelection(view, 1) },
      { key: 'Shift-Tab', run: (view) => moveSnippetSelection(view, -1) },
    ]),
  ];
}

export function insertSnippetTemplate(
  view: EditorView,
  template: string,
  range?: { from: number; to: number },
) {
  const target = range ?? view.state.selection.main;
  const parsed = parseSnippetTemplate(template);
  const offsetPlaceholders = parsed.placeholders.map((placeholder) => ({
    from: target.from + placeholder.from,
    to: target.from + placeholder.to,
  }));
  const effects = [];

  if (offsetPlaceholders.length > 0) {
    effects.push(setSnippetSessionEffect.of({
      placeholders: offsetPlaceholders,
      index: 0,
      finalCursor: parsed.cursorPos === null ? target.from + parsed.text.length : target.from + parsed.cursorPos,
    }));
  } else {
    effects.push(clearSnippetSessionEffect.of(null));
  }

  view.dispatch({
    changes: { from: target.from, to: target.to, insert: parsed.text },
    selection: offsetPlaceholders.length > 0
      ? EditorSelection.single(offsetPlaceholders[0].from, offsetPlaceholders[0].to)
      : { anchor: parsed.cursorPos === null ? target.from + parsed.text.length : target.from + parsed.cursorPos },
    effects,
  });
  view.focus();
}
