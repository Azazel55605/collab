import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

/** Pure chat formatting helpers shared by the conversation components. */

export type Edit = { text: string; start: number; end: number };

/** Wraps the selection, or inserts a selected placeholder when it is empty. */
export function wrapSelection(edit: Edit, before: string, after = before, placeholder = 'text') {
  const selected = edit.text.slice(edit.start, edit.end) || placeholder;
  const text =
    edit.text.slice(0, edit.start) + before + selected + after + edit.text.slice(edit.end);
  const start = edit.start + before.length;
  return { text, start, end: start + selected.length };
}
/** Toggles a line prefix (`- `, `1. `, `> `) on every selected line. */
export function prefixLines(edit: Edit, prefix: (index: number) => string) {
  const lineStart = edit.text.lastIndexOf('\n', edit.start - 1) + 1;
  const nextBreak = edit.text.indexOf('\n', edit.end);
  const lineEnd = nextBreak < 0 ? edit.text.length : nextBreak;
  const lines = edit.text.slice(lineStart, lineEnd).split('\n');
  const marker = /^(?:[-*+] |\d+\. |> )/;
  const remove = lines.every((line, index) => line.startsWith(prefix(index)));
  const block = lines
    .map((line, index) =>
      remove ? line.slice(prefix(index).length) : prefix(index) + line.replace(marker, ''),
    )
    .join('\n');
  const text = edit.text.slice(0, lineStart) + block + edit.text.slice(lineEnd);
  return { text, start: lineStart, end: lineStart + block.length };
}

/**
 * Chat messages are stored as Markdown written by the formatting toolbar.
 * Raw HTML is disabled at parse time and the output is sanitized again, so a
 * message can only ever produce the small set of tags below.
 */
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
markdown.disable(['image', 'table', 'heading', 'lheading', 'hr']);
markdown.validateLink = (url) => /^https?:\/\//i.test(url.trim());
const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  's',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
];

export function renderChatMarkdown(content: string) {
  return DOMPurify.sanitize(markdown.render(content), {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'start'],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
  });
}

/** Plain text for previews: list rows, reply quotes and notifications. */
export function chatPlainText(content: string) {
  return content
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|\*|_)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/^\s*(?:>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable hue per name so the same person keeps the same tint everywhere. */
export function nameHue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}
export function initial(name: string) {
  return (name.trim()[0] ?? '?').toUpperCase();
}
function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}
/** Teams-style list time: clock today, "Yesterday", weekday this week, else a date. */
export function listTime(timestamp: number, now = Date.now()) {
  const at = new Date(timestamp);
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return at.toLocaleDateString([], { weekday: 'short' });
  return at.toLocaleDateString([], { day: 'numeric', month: 'short' });
}
export function messageTime(timestamp: number, now = Date.now()) {
  const at = new Date(timestamp);
  const clock = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return startOfDay(at) === startOfDay(new Date(now))
    ? clock
    : `${listTime(timestamp, now)} ${clock}`;
}
