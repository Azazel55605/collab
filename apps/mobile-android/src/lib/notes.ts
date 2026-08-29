import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import katex from 'katex';
import MarkdownIt from 'markdown-it';
// @ts-ignore - plugin has no bundled types.
import mark from 'markdown-it-mark';
// @ts-ignore - plugin has no bundled types.
import sub from 'markdown-it-sub';
// @ts-ignore - plugin has no bundled types.
import sup from 'markdown-it-sup';
// @ts-ignore - plugin has no bundled types.
import taskLists from 'markdown-it-task-lists';
// @ts-ignore - plugin has no bundled types.
import texmath from 'markdown-it-texmath';

import {
  type ParsedMathPlots,
  parseMathPlots,
} from '../../../../src/components/editor/mathPlotSpec';
import { isMermaidLanguage } from '../../../../src/lib/mermaidRenderer';
import {
  HostedFileEntry,
  HostedTextDocument,
  readHostedDocument,
  replicaCacheDocument,
  replicaReadCachedDocument,
  writeHostedDocument,
} from '../mobileTauri';

import type { ColorPreviewFormat, ThemePrefs } from './theme';

export interface RenderedMarkdownDocument {
  html: string;
  plotBlocks: ParsedMathPlots[];
}

function buildMarkdown(): MarkdownIt {
  const instance = new MarkdownIt({
    breaks: true,
    html: true,
    linkify: true,
    typographer: true,
    highlight(str: string, lang: string): string {
      if (isMermaidLanguage(lang)) {
        return (
          '<pre class="md-mermaid-source"><code class="language-mermaid">' +
          instance.utils.escapeHtml(str) +
          '</code></pre>'
        );
      }
      if (lang && hljs.getLanguage(lang)) {
        try {
          return (
            `<pre class="hljs md-code-block"><code class="language-${lang}">` +
            hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
            '</code></pre>'
          );
        } catch {
          // Fall through to escaped plaintext.
        }
      }
      return `<pre class="hljs md-code-block"><code>${instance.utils.escapeHtml(str)}</code></pre>`;
    },
  });

  instance.use(texmath, {
    engine: katex,
    delimiters: 'dollars',
    katexOptions: {
      throwOnError: false,
      output: 'html',
      trust: true,
      strict: false,
      macros: {
        '\\R': '\\mathbb{R}',
        '\\N': '\\mathbb{N}',
        '\\Z': '\\mathbb{Z}',
        '\\Q': '\\mathbb{Q}',
        '\\C': '\\mathbb{C}',
      },
    },
  });
  instance.use(taskLists, { label: true, labelAfter: false });
  instance.use(sub);
  instance.use(sup);
  instance.use(mark);

  return instance;
}

const markdown = buildMarkdown();

const PURIFY_CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  ADD_TAGS: [
    'math',
    'semantics',
    'mrow',
    'mi',
    'mo',
    'mn',
    'ms',
    'mtext',
    'msup',
    'msub',
    'msubsup',
    'mfrac',
    'mover',
    'munder',
    'munderover',
    'mroot',
    'msqrt',
    'mtable',
    'mtr',
    'mtd',
    'mspace',
    'annotation',
    'annotation-xml',
    'merror',
    'mpadded',
    'mphantom',
    'mstyle',
    'mmultiscripts',
    'mprescripts',
    'none',
    'menclose',
  ],
  ADD_ATTR: [
    'data-path',
    'aria-hidden',
    'aria-label',
    'aria-describedby',
    'checked',
    'class',
    'disabled',
    'encoding',
    'href',
    'id',
    'src',
    'style',
    'target',
    'title',
    'type',
    'alt',
    'display',
    'mathvariant',
    'mathsize',
    'mathcolor',
    'mathbackground',
    'stretchy',
    'fence',
    'separator',
    'lspace',
    'rspace',
    'columnalign',
    'rowalign',
    'columnspan',
    'rowspan',
  ],
  FORCE_BODY: true,
};

const COLOR_FORMAT_REGEXES: Record<ColorPreviewFormat, RegExp> = {
  hex: /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g,
  rgb: /\brgba?\(\s*[^()\n]{1,96}\)/gi,
  hsl: /\bhsla?\(\s*[^()\n]{1,96}\)/gi,
  oklch: /\boklch\(\s*[^()\n]{1,96}\)/gi,
  oklab: /\boklab\(\s*[^()\n]{1,96}\)/gi,
};

export function isNoteFile(file: HostedFileEntry): boolean {
  if (file.kind !== 'document') return false;
  if (file.documentType === 'note') return true;
  return /\.(md|markdown)$/i.test(file.name);
}

function stripFrontmatter(src: string): string {
  if (!src.startsWith('---')) return src;
  const end = src.indexOf('\n---', 3);
  if (end === -1) return src;
  const after = src.slice(end + 4);
  return after.startsWith('\n') ? after.slice(1) : after;
}

function preprocessMath(src: string): string {
  return src
    .replace(/\\\[([\s\S]+?)\\\]/g, (_: string, mathSource: string) => `$$${mathSource}$$`)
    .replace(/\\\((.+?)\\\)/g, (_: string, mathSource: string) => `$${mathSource}$`);
}

function preprocessDisplayMathPlots(src: string): {
  source: string;
  plotBlocks: ParsedMathPlots[];
} {
  const plotBlocks: ParsedMathPlots[] = [];
  const source = src.replace(/\$\$([\s\S]+?)\$\$/g, (_match: string, mathSource: string) => {
    if (!/%plot[23]d\b/.test(mathSource)) return `$$${mathSource}$$`;
    const parsed = parseMathPlots(mathSource);
    plotBlocks.push(parsed);
    return `$$${parsed.mathSource || mathSource}$$\n`;
  });
  return { source, plotBlocks };
}

function preprocessWikilinks(src: string): string {
  return src.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
    (_: string, path: string, label: string | undefined) => {
      const display = label ?? path;
      const safePath = path.replace(/"/g, '&quot;');
      return `<span class="wikilink" data-path="${safePath}">${markdown.utils.escapeHtml(display)}</span>`;
    },
  );
}

function tryParseColor(value: string): string | null {
  if (
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    !CSS.supports('color', value)
  ) {
    return null;
  }
  const probe = document.createElement('span');
  probe.style.color = value;
  return probe.style.color || null;
}

function findColorMatches(text: string, formats: Record<ColorPreviewFormat, boolean>) {
  const matches: Array<{ from: number; to: number; source: string; css: string }> = [];
  for (const [format, enabled] of Object.entries(formats) as [ColorPreviewFormat, boolean][]) {
    if (!enabled) continue;
    const regex = new RegExp(COLOR_FORMAT_REGEXES[format]);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const source = match[0];
      const css = tryParseColor(source);
      if (css) matches.push({ from: match.index, to: match.index + source.length, source, css });
    }
  }
  return matches
    .sort((a, b) => a.from - b.from || b.to - a.to)
    .filter((match, index, all) => {
      const previous = all[index - 1];
      return !previous || match.from >= previous.to;
    });
}

function applyColorPreviews(html: string, prefs?: ThemePrefs): string {
  if (!prefs?.showInlineColorPreviews) return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    const parent = current.parentElement;
    if (parent && !parent.closest('code, pre, a, .katex, .wikilink, .mobile-color-preview')) {
      textNodes.push(current as Text);
    }
    current = walker.nextNode();
  }

  for (const node of textNodes) {
    const text = node.nodeValue ?? '';
    const matches = findColorMatches(text, prefs.colorPreviewFormats);
    if (matches.length === 0) continue;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      if (match.from > cursor)
        fragment.append(document.createTextNode(text.slice(cursor, match.from)));
      const span = document.createElement('span');
      span.className = [
        'mobile-color-preview',
        prefs.colorPreviewShowSwatch ? 'has-swatch' : '',
        prefs.colorPreviewTintText ? 'is-tinted' : '',
      ]
        .filter(Boolean)
        .join(' ');
      span.style.setProperty('--preview-color', match.css);
      span.textContent = match.source;
      fragment.append(span);
      cursor = match.to;
    }
    if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
    node.replaceWith(fragment);
  }

  return template.innerHTML;
}

export function renderMarkdownDocument(
  content: string,
  prefs?: ThemePrefs,
): RenderedMarkdownDocument {
  const body = stripFrontmatter(content);
  const withMath = preprocessMath(body);
  const withPlots = preprocessDisplayMathPlots(withMath);
  const withLinks = preprocessWikilinks(withPlots.source);
  const rendered = markdown.render(withLinks);
  const sanitized = DOMPurify.sanitize(rendered, PURIFY_CONFIG) as unknown as string;
  return {
    html: applyColorPreviews(sanitized, prefs),
    plotBlocks: withPlots.plotBlocks,
  };
}

export function renderMarkdown(content: string): string {
  return renderMarkdownDocument(content).html;
}

function normalizeRelativePath(value: string): string {
  const segments: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

function stripLinkDecorations(target: string): string {
  return target.split('#', 1)[0].split('?', 1)[0].trim();
}

export function isExternalHref(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
}

export function resolveVaultLink(
  files: HostedFileEntry[],
  currentDocumentRelativePath: string,
  rawTarget: string,
): HostedFileEntry | null {
  const target = stripLinkDecorations(rawTarget);
  if (!target || isExternalHref(target)) return null;

  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    decoded = target;
  }

  const currentParts = currentDocumentRelativePath.replace(/\\/g, '/').split('/');
  currentParts.pop();
  const currentDir = currentParts.join('/');
  const candidates = new Set<string>();
  const addCandidate = (value: string) => {
    const normalized = normalizeRelativePath(value);
    if (!normalized) return;
    candidates.add(normalized);
    if (!/\.(md|markdown)$/i.test(normalized)) {
      candidates.add(`${normalized}.md`);
      candidates.add(`${normalized}.markdown`);
    }
  };

  addCandidate(decoded);
  if (currentDir) addCandidate(`${currentDir}/${decoded}`);

  return files.find((file) => candidates.has(normalizeRelativePath(file.relativePath))) ?? null;
}

export async function readNoteDocument(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
  connected: boolean,
): Promise<HostedTextDocument & { source: 'network' | 'cache' }> {
  if (connected) {
    try {
      const document = await readHostedDocument(serverUrl, vaultId, file.id);
      void replicaCacheDocument(serverUrl, vaultId, file.id, document.content).catch(() => {});
      return { ...document, source: 'network' };
    } catch (error) {
      const cached = await replicaReadCachedDocument(serverUrl, vaultId, file.id).catch(() => null);
      if (cached !== null) return { file, content: cached, source: 'cache' };
      throw error;
    }
  }

  const cached = await replicaReadCachedDocument(serverUrl, vaultId, file.id);
  if (cached === null) {
    throw new Error('This note is not cached for offline reading.');
  }
  return { file, content: cached, source: 'cache' };
}

export async function saveNoteDocument(
  serverUrl: string,
  vaultId: string,
  file: HostedFileEntry,
  content: string,
): Promise<HostedTextDocument> {
  const expectedRevisionSequence = file.revisionSequence ?? 0;
  const document = await writeHostedDocument(
    serverUrl,
    vaultId,
    file.id,
    expectedRevisionSequence,
    content,
  );
  void replicaCacheDocument(serverUrl, vaultId, file.id, document.content).catch(() => {});
  return document;
}
