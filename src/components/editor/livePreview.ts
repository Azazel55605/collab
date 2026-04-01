/**
 * Obsidian-style live preview for CodeMirror 6.
 *
 * Rules:
 *  - The line (or multi-line block) the cursor is on shows raw markdown.
 *  - Every other line/block renders inline via CSS + widget decorations.
 *  - Multi-line blocks (code fences, math blocks, tables) revert entirely
 *    to raw when the cursor is anywhere inside them.
 *
 * Implementation note:
 *  Block decorations (block:true) and decorations that replace line breaks
 *  are forbidden in ViewPlugin — they must live in a StateField.
 *  This entire plugin therefore uses StateField.define() which is allowed
 *  to produce any decoration type.
 *
 * Defensive design: any exception inside buildDecorations is caught and
 * returns an empty set — the editor never crashes due to this plugin.
 */

import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view';
import { StateField, RangeSetBuilder, EditorState } from '@codemirror/state';
import katex from 'katex';

// ─── Widgets ──────────────────────────────────────────────────────────────────

class MathWidget extends WidgetType {
  constructor(readonly src: string, readonly display: boolean) { super(); }

  eq(o: MathWidget) { return o.src === this.src && o.display === this.display; }

  toDOM() {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = this.display ? 'cm-lp-math-block' : 'cm-lp-math-inline';
    try {
      katex.render(this.src.trim(), el, { displayMode: this.display, throwOnError: false });
    } catch {
      el.textContent = this.display ? `$$\n${this.src}\n$$` : `$${this.src}$`;
    }
    return el;
  }

  ignoreEvent() { return false; }
}

// ─── Table helpers ────────────────────────────────────────────────────────────

function parseTableCells(line: string): string[] {
  return line.split('|').slice(1, -1).map(c => c.trim());
}

function parseAlignments(line: string): Array<'left' | 'center' | 'right' | ''> {
  return line.split('|').slice(1, -1).map(c => {
    const s = c.trim();
    if (s.startsWith(':') && s.endsWith(':')) return 'center';
    if (s.endsWith(':')) return 'right';
    if (s.startsWith(':')) return 'left';
    return '';
  });
}

class TableWidget extends WidgetType {
  constructor(
    readonly headers: string[],
    readonly rows: string[][],
    readonly aligns: Array<'left' | 'center' | 'right' | ''>,
  ) { super(); }

  eq(o: TableWidget) {
    return (
      this.headers.join('\x00') === o.headers.join('\x00') &&
      this.rows.map(r => r.join('\x00')).join('\n') === o.rows.map(r => r.join('\x00')).join('\n')
    );
  }

  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-lp-table-wrap';
    const table = document.createElement('table');
    table.className = 'cm-lp-table';

    if (this.headers.length) {
      const thead = document.createElement('thead');
      const tr = document.createElement('tr');
      for (let i = 0; i < this.headers.length; i++) {
        const th = document.createElement('th');
        th.textContent = this.headers[i];
        if (this.aligns[i]) th.style.textAlign = this.aligns[i];
        tr.appendChild(th);
      }
      thead.appendChild(tr);
      table.appendChild(thead);
    }

    if (this.rows.length) {
      const tbody = document.createElement('tbody');
      for (const row of this.rows) {
        const tr = document.createElement('tr');
        const colCount = Math.max(this.headers.length, row.length);
        for (let i = 0; i < colCount; i++) {
          const td = document.createElement('td');
          td.textContent = row[i] ?? '';
          if (this.aligns[i]) td.style.textAlign = this.aligns[i];
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }

    wrap.appendChild(table);
    return wrap;
  }

  ignoreEvent() { return false; }
}

class HRWidget extends WidgetType {
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-lp-hr-wrap';
    const el = document.createElement('div');
    el.className = 'cm-lp-hr';
    wrap.appendChild(el);
    return wrap;
  }
  ignoreEvent() { return false; }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Item {
  from: number;
  to: number;
  deco: Decoration;
  excl: boolean; // replace/widget decorations are exclusive (cannot overlap)
}

// ─── Inline decoration scan ───────────────────────────────────────────────────

/**
 * Scan one line's text for inline markdown elements and push decoration
 * items. Elements that contain the cursor are skipped (shown as raw).
 * We use a simple "consumed" bitmask so patterns don't overlap each other.
 *
 * No lookbehind assertions are used — they are not reliably available in
 * all WebKit/WebKitGTK versions.
 */
function processInline(
  out: Item[],
  text: string,
  base: number, // document position of text[0]
  cursor: number,
) {
  const len = text.length;
  const used = new Uint8Array(len); // 1 = consumed

  const occupy = (s: number, e: number) => { for (let i = s; i < e; i++) used[i] = 1; };
  const free   = (s: number, e: number) => { for (let i = s; i < e; i++) { if (used[i]) return false; } return true; };

  const hide   = (s: number, e: number): Item => ({ from: base + s, to: base + e, deco: Decoration.replace({}), excl: true });
  const mark   = (s: number, e: number, cls: string, attrs?: Record<string, string>): Item => ({ from: base + s, to: base + e, deco: Decoration.mark({ class: cls, attributes: attrs }), excl: false });
  const widget = (s: number, e: number, w: WidgetType): Item => ({ from: base + s, to: base + e, deco: Decoration.replace({ widget: w }), excl: true });

  function run(re: RegExp, handle: (m: RegExpExecArray, s: number, e: number) => Item[] | null) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const s = m.index;
      const e = s + m[0].length;
      if (!free(s, e)) continue;
      const docS = base + s;
      const docE = base + e;
      // Cursor inside → show raw
      if (cursor > docS && cursor < docE) continue;
      const result = handle(m, s, e);
      if (result) { occupy(s, e); for (const it of result) out.push(it); }
    }
  }

  // ── Inline code — highest priority so backticks protect inner content ────
  run(/`([^`\n]+?)`/g, (_, s, e) => [mark(s, e, 'cm-lp-icode')]);

  // ── Inline math $...$ — run before bold/italic to catch $ signs ─────────
  // Avoid matching $$ by checking the char before/after manually (no lookbehind)
  run(/\$([^$\n]+?)\$/g, (m, s, e) => {
    // Skip if this is part of $$...$$
    if (text[s - 1] === '$' || text[e] === '$') return null;
    return [widget(s, e, new MathWidget(m[1], false))];
  });

  // ── Bold **text** or __text__ ────────────────────────────────────────────
  run(/\*\*([^*\n]+?)\*\*/g, (_, s, e) => [
    hide(s, s + 2), mark(s + 2, e - 2, 'cm-lp-strong'), hide(e - 2, e),
  ]);
  run(/__([^_\n]+?)__/g, (_, s, e) => [
    hide(s, s + 2), mark(s + 2, e - 2, 'cm-lp-strong'), hide(e - 2, e),
  ]);

  // ── Italic *text* — only single *, not part of ** ────────────────────────
  run(/\*([^*\n]+?)\*/g, (_m, s, e) => {
    // Skip if surrounded by * (i.e. part of bold)
    if (text[s - 1] === '*' || text[e] === '*') return null;
    return [hide(s, s + 1), mark(s + 1, e - 1, 'cm-lp-em'), hide(e - 1, e)];
  });
  // ── Italic _text_ — single _, not part of __ ─────────────────────────────
  run(/_([^_\n]+?)_/g, (_m, s, e) => {
    if (text[s - 1] === '_' || text[e] === '_') return null;
    // Don't italicise words_with_underscores (next char after closing _ should be non-word or end)
    const after = text[e];
    if (after && /\w/.test(after)) return null;
    return [hide(s, s + 1), mark(s + 1, e - 1, 'cm-lp-em'), hide(e - 1, e)];
  });

  // ── Strikethrough ~~text~~ ───────────────────────────────────────────────
  run(/~~([^~\n]+?)~~/g, (_, s, e) => [
    hide(s, s + 2), mark(s + 2, e - 2, 'cm-lp-strike'), hide(e - 2, e),
  ]);

  // ── Highlight ==text== ───────────────────────────────────────────────────
  run(/==([^=\n]+?)==/g, (_, s, e) => [
    hide(s, s + 2), mark(s + 2, e - 2, 'cm-lp-mark'), hide(e - 2, e),
  ]);

  // ── Wikilinks [[Path]] or [[Path|Label]] ─────────────────────────────────
  run(/\[\[([^\]|]+?)(\|([^\]]+?))?\]\]/g, (m, s, e) => {
    const path  = m[1];
    const label = m[3];
    if (label) {
      const labelStart = s + 2 + path.length + 1; // skip [[path|
      return [hide(s, labelStart), mark(labelStart, e - 2, 'cm-lp-wikilink', { 'data-path': path }), hide(e - 2, e)];
    }
    return [hide(s, s + 2), mark(s + 2, e - 2, 'cm-lp-wikilink', { 'data-path': path }), hide(e - 2, e)];
  });

  // ── Links [text](url) ────────────────────────────────────────────────────
  // Skip ![ images by checking preceding char (no lookbehind — WebKitGTK compat)
  run(/\[([^\]\n]+?)\]\(([^)\n]*?)\)/g, (m, s, e) => {
    if (text[s - 1] === '!') return null;
    const url    = m[2];
    const textS  = s + 1;
    const textE  = textS + m[1].length;
    return [hide(s, textS), mark(textS, textE, 'cm-lp-link', { 'data-url': url }), hide(textE, e)];
  });
}

// ─── Core decoration builder ──────────────────────────────────────────────────

function _build(state: EditorState): DecorationSet {
  const doc    = state.doc;
  const cursor = state.selection.main.head;
  const cursorLn = doc.lineAt(cursor).number;

  const items: Item[] = [];

  // Multi-line block state
  let inMath   = false, mathFrom = 0, mathSrc = '', mathHit = false;
  let inFence  = false;
  let tableLines: Array<{ from: number; to: number; ln: number; text: string }> = [];
  let tableHit = false;

  const flushTable = () => {
    if (!tableLines.length) return;
    if (!tableHit && tableLines.length >= 2) {
      const texts = tableLines.map(tl => tl.text);
      const headers = parseTableCells(texts[0]);
      const aligns = parseAlignments(texts[1]);
      const rows = texts.slice(2).map(parseTableCells);
      const from = tableLines[0].from;
      const to = tableLines[tableLines.length - 1].to;
      items.push({
        from, to,
        deco: Decoration.replace({ widget: new TableWidget(headers, rows, aligns), block: true }),
        excl: true,
      });
    }
    tableLines = []; tableHit = false;
  };

  for (let ln = 1; ln <= doc.lines; ln++) {
    const line  = doc.line(ln);
    const { from, to, text } = line;
    const here  = ln === cursorLn;

    // ── Display math block  $$ ... $$ ──────────────────────────────────────
    if (text.trim() === '$$') {
      if (!inMath) {
        inMath = true; mathFrom = from; mathSrc = ''; mathHit = here;
      } else {
        if (here) mathHit = true;
        if (!mathHit && mathSrc.trim()) {
          items.push({
            from: mathFrom, to,
            deco: Decoration.replace({ widget: new MathWidget(mathSrc, true), block: true }),
            excl: true,
          });
        }
        inMath = false; mathHit = false; mathSrc = '';
      }
      flushTable(); continue;
    }
    if (inMath) {
      if (here) mathHit = true;
      mathSrc += (mathSrc ? '\n' : '') + text;
      flushTable(); continue;
    }

    // ── Code fence ─────────────────────────────────────────────────────────
    if (/^(`{3,}|~{3,})/.test(text)) {
      if (!inFence) { inFence = true; }
      else          { inFence = false; }
      flushTable(); continue;
    }
    if (inFence) {
      if (!here) items.push({ from, to: from, deco: Decoration.line({ class: 'cm-lp-code-line' }), excl: false });
      flushTable(); continue;
    }

    // ── Table rows ──────────────────────────────────────────────────────────
    const isTableRow = /^\|.+\|/.test(text) || /^\|[-|: ]+\|$/.test(text.trim());
    if (isTableRow) {
      if (here) tableHit = true;
      tableLines.push({ from, to, ln, text });
      const nextText = ln < doc.lines ? doc.line(ln + 1).text : '';
      if (!/^\|.+\|/.test(nextText) && !/^\|[-|: ]+\|$/.test(nextText.trim())) flushTable();
      continue;
    } else {
      flushTable();
    }

    // ── Horizontal rule ────────────────────────────────────────────────────
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(text) && from < to) {
      if (!here) items.push({ from, to, deco: Decoration.replace({ widget: new HRWidget(), block: true }), excl: true });
      continue;
    }

    // ── ATX Heading  # ... ──────────────────────────────────────────────────
    const hm = text.match(/^(#{1,6}) (.+)/);
    if (hm) {
      const level = hm[1].length;
      items.push({ from, to: from, deco: Decoration.line({ class: `cm-lp-h${level}` }), excl: false });
      if (!here) {
        const prefixEnd = from + level + 1;
        items.push({ from, to: prefixEnd, deco: Decoration.replace({}), excl: true });
        processInline(items, hm[2], prefixEnd, cursor);
      }
      continue;
    }

    // ── Blockquote  > ... ───────────────────────────────────────────────────
    if (text.startsWith('> ')) {
      items.push({ from, to: from, deco: Decoration.line({ class: 'cm-lp-bq' }), excl: false });
      if (!here) {
        items.push({ from, to: from + 2, deco: Decoration.replace({}), excl: true });
        processInline(items, text.slice(2), from + 2, cursor);
      }
      continue;
    }

    // ── Regular paragraph line ──────────────────────────────────────────────
    if (!here) processInline(items, text, from, cursor);
  }

  flushTable();

  // ── Sort → build ──────────────────────────────────────────────────────────
  //
  // RangeSetBuilder requires non-decreasing `from` order.
  // For equal `from`: line decos (from===to) first, then marks, then replaces.

  items.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    const aLine = a.from === a.to;
    const bLine = b.from === b.to;
    if (aLine !== bLine) return aLine ? -1 : 1;
    if (a.excl !== b.excl) return a.excl ? 1 : -1;
    return a.to - b.to;
  });

  const builder = new RangeSetBuilder<Decoration>();
  let exclEnd = 0;

  for (const { from, to, deco, excl } of items) {
    try {
      if (excl) {
        if (from < exclEnd) continue;
        builder.add(from, to, deco);
        exclEnd = to;
      } else {
        const isLine = from === to;
        if (!isLine && from < exclEnd) continue;
        builder.add(from, to, deco);
      }
    } catch {
      // Skip any item that violates builder ordering — never crash the editor
    }
  }

  return builder.finish();
}

/** Outer wrapper — catches all errors so the editor never goes blank. */
function buildDecorations(state: EditorState): DecorationSet {
  try {
    return _build(state);
  } catch (err) {
    console.error('[livePreview] buildDecorations threw:', err);
    return Decoration.none;
  }
}

// ─── StateField (replaces ViewPlugin) ─────────────────────────────────────────
//
// Block decorations (block:true) and decorations that span line breaks are only
// allowed in StateField, not ViewPlugin.  StateField.update() rebuilds on every
// transaction that changes the document or moves the selection.

export const livePreviewPlugin = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },

  update(decos, tr) {
    if (tr.docChanged || tr.selection) {
      return buildDecorations(tr.state);
    }
    // No structural change — map existing positions through any changes
    return decos.map(tr.changes);
  },

  provide(f) {
    return EditorView.decorations.from(f);
  },
});
