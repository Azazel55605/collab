/**
 * The DOM side of the deck text editor: drawing a resolved text body into a
 * `contenteditable` element and mapping DOM selection points to and from the
 * global text offsets `richText.ts` edits with.
 *
 * The DOM here is output only. It is rebuilt from the model after every edit
 * with `textContent` (never markup), so nothing a person types or pastes can
 * become HTML, and nothing the browser does to the DOM can leak into the
 * document.
 *
 * Structure:
 *
 *   root
 *   └ div[data-p]                 one per paragraph
 *     ├ span[data-skip]           list label, not editable, not addressable
 *     ├ span[data-run] > #text    one per text run
 *     ├ br[data-soft]             a soft break, one offset
 *     └ br[data-skip]             filler so an empty last line has height
 */
import type { ResolvedRunStyle, ResolvedTextBody } from '../../lib/deck/resolve';
import { cssFontFamily, DECK_LINE_HEIGHT_FACTOR } from '../../lib/deck/textLayout';
import type { EditorSelection } from '../../lib/deck/textSession';

export type { EditorSelection } from '../../lib/deck/textSession';

export interface EditorRenderOptions {
  /** CSS pixels per deck unit, including zoom and any shrink-to-fit scale. */
  pxPerUnit: number;
  /**
   * Speaker-notes mode: keep bold, italic, underline, strike, and links, but
   * draw in the app's own font, size, and colour.
   */
  plain?: boolean;
}

function rgba(color: ResolvedRunStyle['color']): string {
  const value = Number.parseInt(color.hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${color.alpha})`;
}

function applyRunStyle(
  element: HTMLElement,
  style: ResolvedRunStyle,
  options: EditorRenderOptions,
): void {
  const decorations = [style.underline ? 'underline' : '', style.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ');
  element.style.fontWeight = style.bold ? '700' : '400';
  element.style.fontStyle = style.italic ? 'italic' : 'normal';
  element.style.textDecoration = decorations || 'none';
  if (options.plain) return;
  const size = style.size * options.pxPerUnit;
  element.style.fontFamily = cssFontFamily(style.font);
  element.style.color = rgba(style.color);
  if (style.baseline === 'normal') {
    element.style.fontSize = `${size}px`;
  } else {
    element.style.fontSize = `${size * 0.65}px`;
    element.style.verticalAlign = style.baseline === 'superscript' ? 'super' : 'sub';
  }
}

/** Rebuilds the editor content from a resolved body. */
export function renderEditorContent(
  root: HTMLElement,
  body: ResolvedTextBody,
  options: EditorRenderOptions,
): void {
  const ownerDocument = root.ownerDocument;
  const fragment = ownerDocument.createDocumentFragment();
  body.paragraphs.forEach((paragraph, index) => {
    const block = ownerDocument.createElement('div');
    block.dataset.p = String(index);
    block.style.position = 'relative';
    block.style.textAlign = paragraph.align;
    block.style.whiteSpace = 'pre-wrap';
    block.style.overflowWrap = 'anywhere';
    block.style.setProperty('line-break', 'strict');
    if (!options.plain) {
      const unit = options.pxPerUnit;
      block.style.paddingLeft = `${paragraph.indent * unit}px`;
      if (index > 0) block.style.marginTop = `${paragraph.spaceBefore * unit}px`;
      block.style.marginBottom = `${paragraph.spaceAfter * unit}px`;
      block.style.lineHeight = String((DECK_LINE_HEIGHT_FACTOR * paragraph.lineSpacing) / 100);
      block.style.fontSize = `${paragraph.endStyle.size * unit}px`;
      block.style.fontFamily = cssFontFamily(paragraph.endStyle.font);
      block.style.color = rgba(paragraph.endStyle.color);
    }
    if (paragraph.label) {
      const label = ownerDocument.createElement('span');
      label.dataset.skip = 'label';
      label.contentEditable = 'false';
      label.setAttribute('aria-hidden', 'true');
      label.textContent = paragraph.label;
      label.style.userSelect = 'none';
      const first = paragraph.runs.find((run) => run.kind === 'text')?.style ?? paragraph.endStyle;
      applyRunStyle(label, first, options);
      if (options.plain) {
        label.style.marginRight = '0.4em';
      } else {
        label.style.position = 'absolute';
        label.style.left = `${paragraph.indent * options.pxPerUnit}px`;
        label.style.transform = 'translateX(calc(-100% - 0.25em))';
        label.style.textDecoration = 'none';
      }
      block.appendChild(label);
    }
    for (const run of paragraph.runs) {
      if (run.kind === 'break') {
        const br = ownerDocument.createElement('br');
        br.dataset.soft = 'true';
        block.appendChild(br);
        continue;
      }
      if (run.text === '') continue;
      const span = ownerDocument.createElement('span');
      span.dataset.run = 'true';
      applyRunStyle(span, run.style, options);
      if (run.link) span.dataset.link = run.link.kind;
      span.textContent = run.text;
      block.appendChild(span);
    }
    const last = paragraph.runs[paragraph.runs.length - 1];
    if (
      !last ||
      last.kind === 'break' ||
      paragraph.runs.every((run) => run.kind === 'text' && run.text === '')
    ) {
      const filler = ownerDocument.createElement('br');
      filler.dataset.skip = 'filler';
      block.appendChild(filler);
    }
    fragment.appendChild(block);
  });
  if (body.paragraphs.length === 0) {
    const block = ownerDocument.createElement('div');
    block.dataset.p = '0';
    const filler = ownerDocument.createElement('br');
    filler.dataset.skip = 'filler';
    block.appendChild(filler);
    fragment.appendChild(block);
  }
  root.replaceChildren(fragment);
}

/* ------------------------------------------------------------------------- */
/* Offsets                                                                    */
/* ------------------------------------------------------------------------- */

interface Unit {
  node: Node;
  start: number;
  length: number;
}

function paragraphs(root: HTMLElement): HTMLElement[] {
  return Array.from(root.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.dataset.p !== undefined,
  );
}

function units(block: HTMLElement, start: number): { units: Unit[]; length: number } {
  const out: Unit[] = [];
  let position = start;
  const visit = (node: Node) => {
    if (node instanceof HTMLElement && node.dataset.skip !== undefined) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      out.push({ node, start: position, length });
      position += length;
      return;
    }
    if (node instanceof HTMLBRElement) {
      out.push({ node, start: position, length: 1 });
      position += 1;
      return;
    }
    node.childNodes.forEach(visit);
  };
  block.childNodes.forEach(visit);
  return { units: out, length: position - start };
}

function paragraphStart(root: HTMLElement, target: HTMLElement): number {
  let offset = 0;
  for (const block of paragraphs(root)) {
    if (block === target) return offset;
    offset += units(block, 0).length + 1;
  }
  return offset;
}

/** Total addressable length of the rendered body. */
export function renderedLength(root: HTMLElement): number {
  const blocks = paragraphs(root);
  return blocks.reduce((total, block) => total + units(block, 0).length, 0) + blocks.length - 1;
}

/** The text offset of a DOM selection point inside the editor, or null outside it. */
export function offsetFromDom(root: HTMLElement, node: Node, offset: number): number | null {
  if (!root.contains(node)) return null;
  const blocks = paragraphs(root);
  if (node === root) {
    if (offset >= blocks.length) return renderedLength(root);
    return paragraphStart(root, blocks[offset]);
  }
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const block = element?.closest<HTMLElement>('[data-p]');
  if (!block || !root.contains(block)) return null;
  const start = paragraphStart(root, block);
  const { units: list, length } = units(block, start);
  if (element?.closest('[data-skip]')) {
    // The label or a filler: before the text, or after it for the trailing filler.
    return element.dataset.skip === 'filler' ? start + length : start;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const unit = list.find((entry) => entry.node === node);
    if (unit) return unit.start + Math.min(offset, unit.length);
  }
  const boundary = root.ownerDocument.createRange();
  boundary.setStart(node, offset);
  for (const unit of list) {
    const parent = unit.node.parentNode!;
    const [container, at] =
      unit.node.nodeType === Node.TEXT_NODE
        ? [unit.node, 0]
        : [parent, Array.prototype.indexOf.call(parent.childNodes, unit.node) as number];
    if (boundary.comparePoint(container, at) >= 0) return unit.start;
  }
  return start + length;
}

/** The DOM point for a text offset. */
export function domFromOffset(root: HTMLElement, offset: number): { node: Node; offset: number } {
  const blocks = paragraphs(root);
  let start = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const { units: list, length } = units(block, start);
    if (offset <= start + length || index === blocks.length - 1) {
      const local = Math.max(start, Math.min(start + length, offset));
      for (let at = 0; at < list.length; at += 1) {
        const unit = list[at];
        if (unit.node.nodeType === Node.TEXT_NODE) {
          if (local <= unit.start + unit.length) {
            return { node: unit.node, offset: local - unit.start };
          }
          continue;
        }
        const parent = unit.node.parentNode!;
        const position = Array.prototype.indexOf.call(parent.childNodes, unit.node) as number;
        if (local === unit.start) return { node: parent, offset: position };
        if (local === unit.start + 1 && at === list.length - 1) {
          return { node: parent, offset: position + 1 };
        }
      }
      // Empty paragraph: before the filler, after any label.
      const filler = block.querySelector('[data-skip="filler"]');
      if (filler) {
        return {
          node: block,
          offset: Array.prototype.indexOf.call(block.childNodes, filler) as number,
        };
      }
      return { node: block, offset: block.childNodes.length };
    }
    start += length + 1;
  }
  return { node: root, offset: 0 };
}

/** The editor selection, or null when the document selection is elsewhere. */
export function readSelection(root: HTMLElement): EditorSelection | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.anchorNode || !selection.focusNode) {
    return null;
  }
  const anchor = offsetFromDom(root, selection.anchorNode, selection.anchorOffset);
  const focus = offsetFromDom(root, selection.focusNode, selection.focusOffset);
  if (anchor === null || focus === null) return null;
  return { anchor, focus };
}

/** Places the document selection, keeping its direction. */
export function writeSelection(root: HTMLElement, selection: EditorSelection): void {
  const documentSelection = root.ownerDocument.getSelection();
  if (!documentSelection) return;
  const length = renderedLength(root);
  const anchor = domFromOffset(root, Math.max(0, Math.min(length, selection.anchor)));
  const focus = domFromOffset(root, Math.max(0, Math.min(length, selection.focus)));
  try {
    documentSelection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  } catch {
    // A detached node during a re-render; the next render places it again.
  }
}
