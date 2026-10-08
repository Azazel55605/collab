import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';

import {
  Bold,
  Code,
  Italic,
  LetterText,
  Link,
  List,
  ListOrdered,
  Pencil,
  Quote,
  Reply,
  SendHorizontal,
  Smile,
  SquareCode,
  Strikethrough,
  X,
} from 'lucide-react';

import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';

import { chatPlainText, type Edit, prefixLines, wrapSelection } from './chatFormat';
import { EmojiPicker } from './EmojiPicker';

export type ComposerMode =
  | { kind: 'reply'; id: string; userName: string; content: string }
  | { kind: 'edit'; id: string; content: string };

function ToolButton({
  label,
  shortcut,
  onClick,
  pressed,
  children,
}: {
  label: string;
  shortcut?: string;
  onClick: () => void;
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-pressed={pressed}
      title={shortcut ? `${label} (${shortcut})` : label}
      // Keep the textarea selection while clicking a tool.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function ConversationComposer({
  placeholder,
  disabled,
  sending,
  mode,
  cancelMode,
  submit,
  enterToSend = true,
}: {
  placeholder: string;
  /** False: Enter adds a line and Ctrl/Cmd+Enter sends, as in the expanded editor. */
  enterToSend?: boolean;
  disabled: boolean;
  sending: boolean;
  mode: ComposerMode | null;
  cancelMode: () => void;
  /** Resolves true when the text was accepted and the field can clear. */
  submit: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [formatting, setFormatting] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const draft = useRef('');
  const editing = mode?.kind === 'edit' ? mode.id : null;
  useEffect(() => {
    // Editing borrows the field; the unsent draft comes back afterwards.
    if (editing && mode?.kind === 'edit') {
      draft.current = field.current?.value ?? '';
      setText(mode.content);
      requestAnimationFrame(() => {
        const element = field.current;
        element?.focus();
        element?.setSelectionRange(mode.content.length, mode.content.length);
      });
      return () => setText(draft.current);
    }
    // The mode object is captured when the edit starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  useEffect(() => {
    if (mode?.kind === 'reply') field.current?.focus();
  }, [mode]);
  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, formatting ? 280 : 160)}px`;
  }, [text, formatting]);

  function apply(change: (edit: Edit) => Edit) {
    const element = field.current;
    if (!element) return;
    const next = change({ text, start: element.selectionStart, end: element.selectionEnd });
    setText(next.text);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.start, next.end);
    });
  }
  const tools = {
    bold: () => apply((edit) => wrapSelection(edit, '**')),
    italic: () => apply((edit) => wrapSelection(edit, '_')),
    strike: () => apply((edit) => wrapSelection(edit, '~~')),
    code: () => apply((edit) => wrapSelection(edit, '`', '`', 'code')),
    link: () =>
      apply((edit) => {
        const label = wrapSelection(edit, '[', '](https://)', 'link text');
        // Select the URL so it can be typed over straight away.
        const url = label.end + 2;
        return { text: label.text, start: url, end: url + 'https://'.length };
      }),
    bullets: () => apply((edit) => prefixLines(edit, () => '- ')),
    numbers: () => apply((edit) => prefixLines(edit, (index) => `${index + 1}. `)),
    quote: () => apply((edit) => prefixLines(edit, () => '> ')),
    block: () => apply((edit) => wrapSelection(edit, '```\n', '\n```', 'code')),
  };
  function insert(value: string) {
    apply((edit) => {
      const next = edit.text.slice(0, edit.start) + value + edit.text.slice(edit.end);
      const caret = edit.start + value.length;
      return { text: next, start: caret, end: caret };
    });
  }
  async function send() {
    const value = text;
    if (!value.trim() || disabled || sending) return;
    if (await submit(value)) {
      setText((current) => (current === value ? '' : current));
    }
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape' && mode) {
      event.preventDefault();
      cancelMode();
      return;
    }
    if (modifier && !event.shiftKey && !event.altKey) {
      const shortcut = { b: tools.bold, i: tools.italic, e: tools.code, k: tools.link }[
        event.key.toLowerCase()
      ];
      if (shortcut) {
        event.preventDefault();
        shortcut();
        return;
      }
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    // Like Teams: Enter sends, but in the expanded editor it starts a new
    // line and Ctrl/Cmd+Enter sends.
    if ((formatting || !enterToSend) && !modifier) return;
    event.preventDefault();
    void send();
  }

  return (
    <form
      className="conversation-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <div className={`conversation-composer-box ${formatting ? 'formatting' : ''}`}>
        {mode && (
          <div className="conversation-composer-context">
            {mode.kind === 'reply' ? <Reply size={16} /> : <Pencil size={16} />}
            <span>
              <strong>
                {mode.kind === 'reply' ? `Replying to ${mode.userName}` : 'Editing message'}
              </strong>
              {mode.kind === 'reply' && <small>{chatPlainText(mode.content)}</small>}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={mode.kind === 'reply' ? 'Cancel reply' : 'Cancel editing'}
              onClick={cancelMode}
            >
              <X size={16} />
            </Button>
          </div>
        )}
        {formatting && (
          <div className="conversation-format-bar" role="toolbar" aria-label="Formatting">
            <ToolButton label="Bold" shortcut="Ctrl+B" onClick={tools.bold}>
              <Bold size={16} />
            </ToolButton>
            <ToolButton label="Italic" shortcut="Ctrl+I" onClick={tools.italic}>
              <Italic size={16} />
            </ToolButton>
            <ToolButton label="Strikethrough" onClick={tools.strike}>
              <Strikethrough size={16} />
            </ToolButton>
            <span className="conversation-format-divider" />
            <ToolButton label="Bulleted list" onClick={tools.bullets}>
              <List size={16} />
            </ToolButton>
            <ToolButton label="Numbered list" onClick={tools.numbers}>
              <ListOrdered size={16} />
            </ToolButton>
            <ToolButton label="Quote" onClick={tools.quote}>
              <Quote size={16} />
            </ToolButton>
            <span className="conversation-format-divider" />
            <ToolButton label="Link" shortcut="Ctrl+K" onClick={tools.link}>
              <Link size={16} />
            </ToolButton>
            <ToolButton label="Inline code" shortcut="Ctrl+E" onClick={tools.code}>
              <Code size={16} />
            </ToolButton>
            <ToolButton label="Code block" onClick={tools.block}>
              <SquareCode size={16} />
            </ToolButton>
          </div>
        )}
        <div className="conversation-composer-row">
          <Textarea
            ref={field}
            rows={1}
            aria-label="Message"
            placeholder={placeholder}
            value={text}
            maxLength={4000}
            disabled={disabled}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={keyDown}
          />
          <div className="conversation-composer-tools">
            <ToolButton
              label={formatting ? 'Hide formatting' : 'Format'}
              pressed={formatting}
              onClick={() => {
                setFormatting((value) => !value);
                field.current?.focus();
              }}
            >
              <LetterText size={18} />
            </ToolButton>
            <EmojiPicker
              open={emojiOpen}
              onOpenChange={setEmojiOpen}
              onPick={(emoji) => {
                insert(emoji);
                setEmojiOpen(false);
              }}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Insert emoji"
                disabled={disabled}
              >
                <Smile size={18} />
              </Button>
            </EmojiPicker>
          </div>
        </div>
      </div>
      <Button
        type="submit"
        className="conversation-send"
        aria-label={editing ? 'Save edit' : 'Send message'}
        disabled={disabled || !text.trim() || sending}
      >
        {editing ? <Pencil size={20} /> : <SendHorizontal size={20} />}
      </Button>
    </form>
  );
}
