/**
 * Linked documents and slide exports: the two directions a deck shares
 * content with the rest of the vault.
 *
 * - A **linked document** (a `DeckEmbedElement`) shows a static preview of a
 *   note or other file. The preview is an ordinary vault image generated when
 *   the link is made and regenerated only when a person asks ("Refresh").
 * - A **slide export** writes one slide as an SVG at a stable path, so a note
 *   can embed it and re-exporting replaces the same file.
 *
 * Everything here is pure string work; the view does the vault I/O.
 */
import { escapeXml } from './svg';

const PREVIEW_WIDTH = 960;
const PREVIEW_HEIGHT = 600;
const LINE_CHARS = 72;
const MAX_LINES = 14;

/** Markdown reduced to readable plain lines for a preview. */
export function markdownExcerpt(markdown: string): string[] {
  let text = markdown.replace(/\r\n?/g, '\n');
  // Front matter.
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const lines: string[] = [];
  let fenced = false;
  for (const raw of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    let line = raw;
    if (!fenced) {
      line = line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, '$1☐ ')
        .replace(/^(\s*)[-*+]\s+/, '$1• ')
        .replace(/!\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, '[image]')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => (alt ? `[${alt}]` : '[image]'))
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
        .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/<[^>]+>/g, '');
    }
    lines.push(line.replace(/\t/g, '  ').trimEnd());
  }
  // Collapse runs of blank lines and trim the ends.
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line === '' && collapsed[collapsed.length - 1] === '') continue;
    collapsed.push(line);
  }
  while (collapsed[0] === '') collapsed.shift();
  while (collapsed[collapsed.length - 1] === '') collapsed.pop();
  return collapsed;
}

/** Wraps lines to a character width, breaking at spaces where possible. */
function wrap(lines: string[], width: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > width) {
      const cut = rest.lastIndexOf(' ', width);
      const at = cut > width / 2 ? cut : width;
      out.push(rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/**
 * A preview card for a note: its title and the first lines of its text, as a
 * self-contained SVG. Every string is escaped; nothing is fetched.
 */
export function notePreviewSvg(title: string, markdown: string): string {
  const lines = markdownExcerpt(markdown);
  // A leading heading that repeats the title is already shown as the title.
  if (lines[0]?.trim().toLowerCase() === title.trim().toLowerCase()) {
    lines.shift();
    while (lines[0] === '') lines.shift();
  }
  const excerpt = wrap(lines, LINE_CHARS);
  const shown = excerpt.slice(0, MAX_LINES);
  if (excerpt.length > MAX_LINES) shown.push('…');
  const lineHeight = 30;
  const text = shown
    .map(
      (line, index) =>
        `<text x="40" y="${120 + index * lineHeight}" font-size="20" fill="#374151">${escapeXml(line)}</text>`,
    )
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}" font-family="Inter, Arial, sans-serif">` +
    `<rect width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" rx="16" fill="#ffffff" stroke="#d1d5db" stroke-width="2"/>` +
    `<rect width="${PREVIEW_WIDTH}" height="8" rx="4" fill="#6d5dfc"/>` +
    `<text x="40" y="70" font-size="30" font-weight="700" fill="#111827">${escapeXml(title)}</text>` +
    `${text}</svg>`
  );
}

export const NOTE_PREVIEW_SIZE = { width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT };

/** An SVG string as a base64 `data:` URL, UTF-8 safe. */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

function splitPath(path: string): { folder: string; stem: string } {
  const slash = path.lastIndexOf('/');
  const folder = slash >= 0 ? path.slice(0, slash) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  return { folder, stem: name.replace(/\.[^.]+$/, '') };
}

/** File names are kept to characters every vault backend accepts. */
function safeName(value: string): string {
  return (
    value
      .replace(/[\\/:*?"<>|#^[\]]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim() || 'deck'
  );
}

/** The folder a deck's generated files live in: beside the deck, named after it. */
export function deckAssetFolder(deckPath: string): string {
  const { folder, stem } = splitPath(deckPath);
  const name = `${safeName(stem)} assets`;
  return folder ? `${folder}/${name}` : name;
}

/** The stable file a slide exports to. Keyed by slide id, so reordering never retargets it. */
export function slideExportName(slideId: string): string {
  return `slide-${safeName(slideId)}.svg`;
}

/** The stable file a linked document's preview is written to. */
export function embedPreviewName(elementId: string): string {
  return `preview-${safeName(elementId)}.svg`;
}

/** Markdown a note uses to show an exported slide and link back to its deck. */
export function slideExportMarkdown(
  exportPath: string,
  deckPath: string,
  slideNumber: number,
): string {
  const target = (path: string) => (/\s/.test(path) ? `<${path}>` : path);
  const { stem } = splitPath(deckPath);
  return `![Slide ${slideNumber} of ${stem}](${target(exportPath)})\n[Open ${stem}](${target(deckPath)})`;
}
