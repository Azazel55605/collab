import { useMemo, Component, type ReactNode, type ErrorInfo } from 'react';
import MarkdownIt from 'markdown-it';
// @ts-ignore – no bundled types
import texmath from 'markdown-it-texmath';
import katex from 'katex';
// @ts-ignore – no bundled types
import footnote from 'markdown-it-footnote';
import anchor from 'markdown-it-anchor';
// @ts-ignore – no bundled types
import taskLists from 'markdown-it-task-lists';
// @ts-ignore – no bundled types
import sub from 'markdown-it-sub';
// @ts-ignore – no bundled types
import sup from 'markdown-it-sup';
// @ts-ignore – no bundled types
import mark from 'markdown-it-mark';
// @ts-ignore – no bundled types
import deflist from 'markdown-it-deflist';
// @ts-ignore – no bundled types
import container from 'markdown-it-container';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/atom-one-dark.css';

// ─── Error boundary ───────────────────────────────────────────────────────────

interface EBState { error: Error | null }
class PreviewErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null };
  static getDerivedStateFromError(error: Error): EBState { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[MarkdownPreview]', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div className="p-6 text-sm text-destructive">
          <p className="font-medium">Preview error</p>
          <pre className="mt-2 text-xs opacity-70 whitespace-pre-wrap">{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── markdown-it instance ─────────────────────────────────────────────────────

function buildMd(): MarkdownIt {
  const instance: MarkdownIt = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight(str: string, lang: string): string {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return (
            `<pre class="hljs md-code-block"><code class="language-${lang}">` +
            hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
            `</code></pre>`
          );
        } catch {
          // fall through
        }
      }
      return `<pre class="hljs md-code-block"><code>${instance.utils.escapeHtml(str)}</code></pre>`;
    },
  });

  // Math (KaTeX) — $...$ and $$...$$
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

  instance.use(footnote);
  instance.use(anchor, { permalink: anchor.permalink.headerLink({ safariReaderFix: true }) });
  instance.use(taskLists, { label: true, labelAfter: false });
  instance.use(sub);
  instance.use(sup);
  instance.use(mark);
  instance.use(deflist);

  // Callout containers: ::: note Title\n...\n:::
  const callouts: [string, string][] = [
    ['note', 'Note'], ['tip', 'Tip'], ['warning', 'Warning'],
    ['danger', 'Danger'], ['info', 'Info'],
  ];
  for (const [type, defaultTitle] of callouts) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instance.use(container, type, { render(tokens: any[], idx: number) {
      const tok = tokens[idx];
      if (tok.nesting === 1) {
        const title = tok.info.trim().slice(type.length).trim() || defaultTitle;
        return `<div class="callout callout-${type}"><div class="callout-title">${instance.utils.escapeHtml(title)}</div><div class="callout-body">\n`;
      }
      return '</div></div>\n';
    } });
  }

  return instance;
}

let md: MarkdownIt;
try {
  md = buildMd();
} catch (e) {
  console.error('[MarkdownPreview] Failed to initialise markdown-it:', e);
  md = new MarkdownIt({ html: false, linkify: true, typographer: true });
}

// ─── Preprocessing ────────────────────────────────────────────────────────────

/** Strip YAML frontmatter (--- ... ---) without requiring Node.js Buffer. */
function stripFrontmatter(src: string): string {
  if (!src.startsWith('---')) return src;
  const end = src.indexOf('\n---', 3);
  if (end === -1) return src;
  const after = src.slice(end + 4);
  return after.startsWith('\n') ? after.slice(1) : after;
}

/** Convert \[...\] → $$...$$ and \(...\) → $...$ so KaTeX picks them up. */
function preprocessMath(src: string): string {
  return src
    .replace(/\\\[([\s\S]+?)\\\]/g, (_: string, m: string) => `$$${m}$$`)
    .replace(/\\\((.+?)\\\)/g, (_: string, m: string) => `$${m}$`);
}

/** Convert [[Path|Label]] → clickable wikilink spans. */
function preprocessWikilinks(src: string): string {
  return src.replace(
    /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
    (_: string, path: string, label: string | undefined) => {
      const display = label ?? path;
      const safePath = path.replace(/"/g, '&quot;');
      return `<span class="wikilink" data-path="${safePath}">${md.utils.escapeHtml(display)}</span>`;
    },
  );
}

// ─── DOMPurify config ─────────────────────────────────────────────────────────

const PURIFY_CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  ADD_TAGS: [
    'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext',
    'msup', 'msub', 'msubsup', 'mfrac', 'mover', 'munder', 'munderover',
    'mroot', 'msqrt', 'mtable', 'mtr', 'mtd', 'mspace', 'annotation',
    'annotation-xml', 'merror', 'mpadded', 'mphantom', 'mstyle',
    'mmultiscripts', 'mprescripts', 'none', 'menclose',
  ],
  ADD_ATTR: [
    'data-path', 'aria-hidden', 'aria-label', 'aria-describedby',
    'class', 'style', 'href', 'id', 'encoding', 'display',
    'mathvariant', 'mathsize', 'mathcolor', 'mathbackground',
    'stretchy', 'fence', 'separator', 'lspace', 'rspace',
    'columnalign', 'rowalign', 'columnspan', 'rowspan',
  ],
  FORCE_BODY: true,
};

// ─── Component ───────────────────────────────────────────────────────────────

interface MarkdownPreviewProps {
  content: string;
  className?: string;
  onWikilinkClick?: (relativePath: string) => void;
}

function PreviewInner({ content, className = '', onWikilinkClick }: MarkdownPreviewProps) {
  const html = useMemo(() => {
    try {
      const body = stripFrontmatter(content);
      const withMath  = preprocessMath(body);
      const withLinks = preprocessWikilinks(withMath);
      const rendered  = md.render(withLinks);
      return DOMPurify.sanitize(rendered, PURIFY_CONFIG) as unknown as string;
    } catch (e) {
      console.error('[MarkdownPreview] render error:', e);
      return `<pre style="color:red;white-space:pre-wrap">${String(e)}</pre>`;
    }
  }, [content]);

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!onWikilinkClick) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.wikilink');
    if (el?.dataset.path) onWikilinkClick(el.dataset.path);
  }

  return (
    <div
      className={`markdown-preview ${className}`}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  );
}

export function MarkdownPreview(props: MarkdownPreviewProps) {
  return (
    <PreviewErrorBoundary>
      <PreviewInner {...props} />
    </PreviewErrorBoundary>
  );
}
