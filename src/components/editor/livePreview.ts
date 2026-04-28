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
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightCode } from '@lezer/highlight';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import katex from 'katex';
import {
  siC,
  siCplusplus,
  siCss,
  siDotnet,
  siGo,
  siGnubash,
  siHtml5,
  siJavascript,
  siJson,
  siKotlin,
  siMarkdown,
  siOpenjdk,
  siPhp,
  siPython,
  siRuby,
  siRust,
  siSass,
  siSwift,
  siTypescript,
  siYaml,
} from 'simple-icons';
import { Checkbox } from '../ui/checkbox';
import { resolveNoteAssetTarget, isLikelyImagePath, type NoteAssetTarget } from '../../lib/noteAssets';
import { useVaultStore } from '../../store/vaultStore';
import { tauriCommands } from '../../lib/tauri';

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

function getCodeLanguageIcon(language: string) {
  const key = language.trim().toLowerCase();

  if (['javascript', 'js', 'jsx'].includes(key)) return { kind: 'svg' as const, icon: siJavascript };
  if (['typescript', 'ts', 'tsx'].includes(key)) return { kind: 'svg' as const, icon: siTypescript };
  if (['php'].includes(key)) return { kind: 'svg' as const, icon: siPhp };
  if (['sql'].includes(key)) return { kind: 'text' as const, label: 'SQL' };
  if (['json'].includes(key)) return { kind: 'svg' as const, icon: siJson };
  if (['yaml', 'yml'].includes(key)) return { kind: 'svg' as const, icon: siYaml };
  if (['toml'].includes(key)) return { kind: 'text' as const, label: 'TOML' };
  if (['markdown', 'md'].includes(key)) return { kind: 'svg' as const, icon: siMarkdown };

  if (['python', 'py'].includes(key)) return { kind: 'svg' as const, icon: siPython };
  if (['rust', 'rs'].includes(key)) return { kind: 'svg' as const, icon: siRust };
  if (['go', 'golang'].includes(key)) return { kind: 'svg' as const, icon: siGo };
  if (['java'].includes(key)) return { kind: 'svg' as const, icon: siOpenjdk };
  if (['c'].includes(key)) return { kind: 'svg' as const, icon: siC };
  if (['cpp', 'c++', 'cc', 'cxx'].includes(key)) return { kind: 'svg' as const, icon: siCplusplus };
  if (['csharp', 'cs', 'c#'].includes(key)) return { kind: 'svg' as const, icon: siDotnet };
  if (['ruby', 'rb'].includes(key)) return { kind: 'svg' as const, icon: siRuby };
  if (['swift'].includes(key)) return { kind: 'svg' as const, icon: siSwift };
  if (['kotlin', 'kt'].includes(key)) return { kind: 'svg' as const, icon: siKotlin };
  if (['html'].includes(key)) return { kind: 'svg' as const, icon: siHtml5 };
  if (['css'].includes(key)) return { kind: 'svg' as const, icon: siCss };
  if (['scss', 'sass'].includes(key)) return { kind: 'svg' as const, icon: siSass };
  if (['bash', 'sh', 'shell', 'zsh'].includes(key)) return { kind: 'svg' as const, icon: siGnubash };

  return { kind: 'text' as const, label: '</>' };
}

function createCodeLanguageIconElement(language: string) {
  const meta = getCodeLanguageIcon(language);
  const icon = document.createElement('span');
  icon.className = 'cm-lp-code-block-lang-icon';

  if (meta.kind === 'text') {
    icon.textContent = meta.label;
    icon.classList.add('is-text');
    return icon;
  }

  icon.innerHTML = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false"><path fill="currentColor" d="${meta.icon.path}"/></svg>`;
  return icon;
}

class CodeBlockWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly language: string,
    readonly sourceLineCount: number,
  ) { super(); }

  eq(o: CodeBlockWidget) {
    return (
      o.code === this.code &&
      o.language === this.language &&
      o.sourceLineCount === this.sourceLineCount
    );
  }

  private renderHighlightedContent() {
    const fragment = document.createDocumentFragment();
    const languageName = this.language.split(/\s+/, 1)[0]?.trim();
    if (!languageName) {
      fragment.appendChild(document.createTextNode(this.code));
      return fragment;
    }

    const language = LanguageDescription.matchLanguageName(languages, languageName, true);
    const support = language?.support;
    if (!support) {
      fragment.appendChild(document.createTextNode(this.code));
      return fragment;
    }

    try {
      const tree = support.language.parser.parse(this.code);
      highlightCode(
        this.code,
        tree,
        classHighlighter,
        (text, classes) => {
          if (!classes) {
            fragment.appendChild(document.createTextNode(text));
            return;
          }

          const span = document.createElement('span');
          span.className = classes;
          span.textContent = text;
          fragment.appendChild(span);
        },
        () => {
          fragment.appendChild(document.createTextNode('\n'));
        },
      );
    } catch {
      fragment.replaceChildren(document.createTextNode(this.code));
    }

    return fragment;
  }

  private async ensureLanguageSupport() {
    const languageName = this.language.split(/\s+/, 1)[0]?.trim();
    if (!languageName) return;
    const language = LanguageDescription.matchLanguageName(languages, languageName, true);
    if (!language || language.support) return;
    try {
      await language.load();
    } catch {
      // Keep plain rendering if lazy loading fails.
    }
  }

  toDOM(view?: EditorView) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-lp-code-block-wrap';
    wrap.style.minHeight = `${this.sourceLineCount * 1.7}em`;

    if (this.language) {
      const label = document.createElement('div');
      label.className = 'cm-lp-code-block-lang';
      const badge = createCodeLanguageIconElement(this.language.split(/\s+/, 1)[0] ?? this.language);
      const text = document.createElement('span');
      text.textContent = this.language;

      label.append(badge, text);
      wrap.appendChild(label);
    }

    const pre = document.createElement('pre');
    pre.className = 'cm-lp-code-block';
    const code = document.createElement('code');
    code.replaceChildren(this.renderHighlightedContent());
    pre.appendChild(code);
    wrap.appendChild(pre);

    void this.ensureLanguageSupport().then(() => {
      if (!wrap.isConnected) return;
      code.replaceChildren(this.renderHighlightedContent());
      view?.requestMeasure();
    });

    return wrap;
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

class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly prefix: string,
    readonly checked: boolean,
    readonly suffix: string,
    readonly markerFrom: number,
    readonly markerTo: number,
  ) { super(); }

  eq(o: TaskCheckboxWidget) {
    return (
      o.prefix === this.prefix &&
      o.checked === this.checked &&
      o.suffix === this.suffix &&
      o.markerFrom === this.markerFrom &&
      o.markerTo === this.markerTo
    );
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-lp-task';

    if (this.prefix) {
      const bullet = document.createElement('span');
      bullet.className = 'cm-lp-task-prefix';
      bullet.textContent = this.prefix;
      wrap.appendChild(bullet);
    }

    const checkboxMount = document.createElement('span');
    checkboxMount.className = 'cm-lp-task-checkbox';
    wrap.appendChild(checkboxMount);

    if (this.suffix) {
      const label = document.createElement('span');
      label.className = `cm-lp-task-label${this.checked ? ' is-checked' : ''}`;
      label.textContent = this.suffix;
      label.addEventListener('mousedown', (event) => {
        event.preventDefault();
      });
      label.addEventListener('click', (event) => {
        event.preventDefault();
        toggleChecked();
      });
      wrap.appendChild(label);
    }

    const toggleChecked = () => {
      const nextChecked = !this.checked;
      view.dispatch({
        changes: {
          from: this.markerFrom,
          to: this.markerTo,
          insert: nextChecked ? '[x]' : '[ ]',
        },
        selection: { anchor: this.markerTo },
      });
      view.focus();
    };

    const root = createRoot(checkboxMount);
    root.render(
      React.createElement(Checkbox, {
        checked: this.checked,
        'aria-label': this.checked ? 'Mark task incomplete' : 'Mark task complete',
        onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => {
          event.preventDefault();
        },
        onCheckedChange: () => {
          toggleChecked();
        },
      }),
    );
    (wrap as HTMLElement & { __cmReactRoot?: Root }).__cmReactRoot = root;

    return wrap;
  }

  destroy(dom: HTMLElement) {
    (dom as HTMLElement & { __cmReactRoot?: Root }).__cmReactRoot?.unmount();
  }

  ignoreEvent() { return false; }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly target: NoteAssetTarget,
    readonly alt: string,
  ) { super(); }

  eq(o: ImageWidget) {
    return o.target.kind === this.target.kind && o.target.value === this.target.value && o.alt === this.alt;
  }

  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-lp-image-wrap';
    wrap.dataset.assetKind = this.target.kind;
    wrap.dataset.assetValue = this.target.value;

    const img = document.createElement('img');
    img.className = 'cm-lp-image';
    img.alt = this.alt;
    img.loading = 'lazy';
    img.dataset.assetKind = this.target.kind;
    img.dataset.assetValue = this.target.value;
    wrap.appendChild(img);

    if (this.target.kind === 'direct') {
      img.src = this.target.value;
      return wrap;
    }

    img.dataset.pending = 'true';

    const vaultPath = useVaultStore.getState().vault?.path;
    if (!vaultPath) return wrap;

    void tauriCommands.readNoteAssetDataUrl(vaultPath, this.target.value)
      .then((src) => {
        if (!src || !img.isConnected) return;
        img.src = src;
        delete img.dataset.pending;
      })
      .catch((err) => {
        if (!img.isConnected) return;
        img.title = String(err);
        img.dataset.pending = 'false';
      });

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
  noteRelativePath: string,
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
  run(/`([^`\n]+?)`/g, (_, s, e) => [
    hide(s, s + 1), mark(s + 1, e - 1, 'cm-lp-icode'), hide(e - 1, e),
  ]);

  // ── Images ![alt](path) and ![[path]] ───────────────────────────────────
  run(/!\[([^\]\n]*?)\]\(([^)\n]*?)\)/g, (m, s, e) => {
    const target = resolveNoteAssetTarget(m[2], noteRelativePath);
    if (!target) return null;
    return [widget(s, e, new ImageWidget(target, m[1]))];
  });
  run(/!\[\[([^\]|]+?)(\|([^\]]+?))?\]\]/g, (m, s, e) => {
    const path = m[1];
    if (!isLikelyImagePath(path)) return null;
    const target = resolveNoteAssetTarget(path, noteRelativePath);
    if (!target) return null;
    const alt = m[3] ?? path.split('/').pop() ?? path;
    return [widget(s, e, new ImageWidget(target, alt))];
  });

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

function _build(state: EditorState, noteRelativePath: string): DecorationSet {
  const doc    = state.doc;
  const cursor = state.selection.main.head;
  const cursorLn = doc.lineAt(cursor).number;

  const items: Item[] = [];

  // Detect YAML frontmatter at document start (--- ... ---) so the HR handler
  // doesn't accidentally hide the opening delimiter or mangle the YAML content.
  let frontmatterEndLn = 0;
  if (doc.lines >= 3 && doc.line(1).text.trim() === '---') {
    for (let i = 2; i <= doc.lines; i++) {
      if (doc.line(i).text.trim() === '---') { frontmatterEndLn = i; break; }
    }
  }

  // Multi-line block state
  let inMath   = false, mathFrom = 0, mathSrc = '', mathHit = false;
  let inFence  = false, fenceFrom = 0, fenceSrc = '', fenceHit = false, fenceLang = '', fenceLineCount = 0;
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

    // ── Skip frontmatter lines ─────────────────────────────────────────────
    if (frontmatterEndLn > 0 && ln <= frontmatterEndLn) continue;

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
    const fenceMatch = text.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceFrom = from;
        fenceSrc = '';
        fenceHit = here;
        fenceLang = fenceMatch[2].trim();
        fenceLineCount = 1;
      } else {
        if (!fenceHit && !here) {
          items.push({
            from: fenceFrom,
            to,
            deco: Decoration.replace({
              widget: new CodeBlockWidget(fenceSrc, fenceLang, fenceLineCount + 1),
              block: true,
            }),
            excl: true,
          });
        }
        inFence = false;
        fenceSrc = '';
        fenceHit = false;
        fenceLang = '';
        fenceLineCount = 0;
      }
      flushTable(); continue;
    }
    if (inFence) {
      if (here) fenceHit = true;
      fenceSrc += (fenceSrc ? '\n' : '') + text;
      fenceLineCount += 1;
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
      // A `-{3,}` line that immediately follows non-blank text is a setext H2
      // underline — not a thematic break. Skip it (Lezer handles heading style).
      const prevText = ln > 1 ? doc.line(ln - 1).text.trim() : '';
      const isSetextUnderline = text[0] === '-' && prevText.length > 0;
      if (!isSetextUnderline && !here) {
        // Use a line-class + inline replace instead of a block widget.
        // Decoration.replace({block:true}) collapses to zero height in
        // WebKitGTK because CM6 measures the widget before CSS loads;
        // the CSS-driven ::after approach is completely reliable.
        items.push({ from, to: from, deco: Decoration.line({ class: 'cm-lp-hr-line' }), excl: false });
        items.push({ from, to, deco: Decoration.replace({}), excl: true });
      }
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
        processInline(items, hm[2], prefixEnd, cursor, noteRelativePath);
      }
      continue;
    }

    // ── Blockquote  > ... ───────────────────────────────────────────────────
    if (text.startsWith('> ')) {
      items.push({ from, to: from, deco: Decoration.line({ class: 'cm-lp-bq' }), excl: false });
      if (!here) {
        items.push({ from, to: from + 2, deco: Decoration.replace({}), excl: true });
        processInline(items, text.slice(2), from + 2, cursor, noteRelativePath);
      }
      continue;
    }

    // ── Task list item  - [ ] text / - [x] text ────────────────────────────
    const taskMatch = text.match(/^(\s*(?:[-+*]|\d+\.)\s+)(\[(?: |x|X)\])(\s.*)?$/);
    if (taskMatch && !here) {
      const prefix = taskMatch[1];
      const marker = taskMatch[2];
      const suffix = taskMatch[3] ?? '';
      const markerFrom = from + prefix.length;
      const markerTo = markerFrom + marker.length;
      items.push({ from, to: from, deco: Decoration.line({ class: 'cm-lp-task-line' }), excl: false });
      items.push({
        from,
        to,
        deco: Decoration.replace({
          widget: new TaskCheckboxWidget(prefix, marker.toLowerCase() === '[x]', suffix, markerFrom, markerTo),
        }),
        excl: true,
      });
      continue;
    }

    // ── Regular paragraph line ──────────────────────────────────────────────
    if (!here) processInline(items, text, from, cursor, noteRelativePath);
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
function buildDecorations(state: EditorState, noteRelativePath: string): DecorationSet {
  try {
    return _build(state, noteRelativePath);
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

export function createLivePreviewPlugin(noteRelativePath: string) {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, noteRelativePath);
    },

    update(decos, tr) {
      if (tr.docChanged || tr.selection) {
        return buildDecorations(tr.state, noteRelativePath);
      }
      // No structural change — map existing positions through any changes
      return decos.map(tr.changes);
    },

    provide(f) {
      return EditorView.decorations.from(f);
    },
  });
}
