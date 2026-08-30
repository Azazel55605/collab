import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
// @ts-ignore – no bundled types
import container from 'markdown-it-container';
// @ts-ignore – no bundled types
import deflist from 'markdown-it-deflist';
// @ts-ignore – no bundled types
import footnote from 'markdown-it-footnote';
// @ts-ignore – no bundled types
import mark from 'markdown-it-mark';
// @ts-ignore – no bundled types
import sub from 'markdown-it-sub';
// @ts-ignore – no bundled types
import sup from 'markdown-it-sup';
// @ts-ignore – no bundled types
import taskLists from 'markdown-it-task-lists';
// @ts-ignore – no bundled types
import texmath from 'markdown-it-texmath';

import { extractLogicDiagramExportSource } from '../../lib/logicDiagramExport';
import { isMermaidLanguage, renderMermaidBlocks } from '../../lib/mermaidRenderer';
import { resolveNoteAssetTarget } from '../../lib/noteAssets';
import { createVaultClient } from '../../lib/vaultClient';
import { flattenVaultFiles, getVaultDocumentTitle } from '../../lib/vaultLinks';
import { extractHttpUrls, prefetchWebPreviews } from '../../lib/webPreviewCache';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import { WebLinkPreviewPopover } from '../previews/WebLinkPreviewPopover';

import { MathPlot2D } from './MathPlot2D';
import { MathPlot3D } from './MathPlot3D';
import { openMathPlotModal } from './MathPlotModal';
import { type ParsedMathPlots, parseMathPlots } from './mathPlotSpec';

// ─── Error boundary ───────────────────────────────────────────────────────────

interface EBState {
  error: Error | null;
}
class PreviewErrorBoundary extends Component<{ children: ReactNode }, EBState> {
  state: EBState = { error: null };
  static getDerivedStateFromError(error: Error): EBState {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[MarkdownPreview]', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="p-6 text-sm text-destructive">
          <p className="font-medium">Preview error</p>
          <pre className="mt-2 text-xs opacity-70 whitespace-pre-wrap">
            {this.state.error.message}
          </pre>
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
    ['note', 'Note'],
    ['tip', 'Tip'],
    ['warning', 'Warning'],
    ['danger', 'Danger'],
    ['info', 'Info'],
  ];
  for (const [type, defaultTitle] of callouts) {
    instance.use(container, type, {
      render(tokens: any[], idx: number) {
        const tok = tokens[idx];
        if (tok.nesting === 1) {
          const title = tok.info.trim().slice(type.length).trim() || defaultTitle;
          return `<div class="callout callout-${type}"><div class="callout-title">${instance.utils.escapeHtml(title)}</div><div class="callout-body">\n`;
        }
        return '</div></div>\n';
      },
    });
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
    'class',
    'style',
    'href',
    'id',
    'encoding',
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

// ─── Component ───────────────────────────────────────────────────────────────

interface MarkdownPreviewProps {
  content: string;
  className?: string;
  onWikilinkClick?: (relativePath: string) => void;
  currentDocumentRelativePath?: string;
  onReady?: () => void;
}

function isPreviewableHttpUrl(value: string | null | undefined) {
  return !!value && /^https?:\/\//i.test(value);
}

function waitForImageLoad(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();
  if (typeof image.decode === 'function') {
    return image.decode().catch(() => undefined);
  }
  return new Promise((resolve) => {
    image.addEventListener('load', () => resolve(), { once: true });
    image.addEventListener('error', () => resolve(), { once: true });
  });
}

function waitForPlotCanvases(root: HTMLElement, expectedCanvases: number): Promise<void> {
  if (expectedCanvases === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      if (root.querySelectorAll('.markdown-preview-plots canvas').length >= expectedCanvases) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 5000) {
        resolve();
        return;
      }
      window.setTimeout(tick, 50);
    };
    tick();
  });
}

function MathPlotPreviewStack({ parsed }: { parsed: ParsedMathPlots }) {
  return (
    <div className="mt-3 space-y-3 text-left">
      {parsed.errors.map((error, index) => (
        <div
          key={`error-${index}`}
          className="rounded-md border border-destructive/35 bg-destructive/8 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      ))}
      {parsed.plots.map((plot, index) =>
        plot.kind === '2d' ? (
          <MathPlot2D
            key={`plot-${index}`}
            spec={plot}
            onShiftClick={() => openMathPlotModal(plot)}
          />
        ) : (
          <MathPlot3D
            key={`plot-${index}`}
            spec={plot}
            onShiftClick={() => openMathPlotModal(plot)}
          />
        ),
      )}
    </div>
  );
}

function PreviewInner({
  content,
  className = '',
  onWikilinkClick,
  currentDocumentRelativePath,
  onReady,
}: MarkdownPreviewProps) {
  const {
    webPreviewsEnabled,
    hoverWebLinkPreviewsEnabled,
    backgroundWebPreviewPrefetchEnabled,
    theme,
    accentColor,
  } = useUiStore();
  const vault = useVaultStore((state) => state.vault);
  const client = useMemo(() => (vault ? createVaultClient(vault) : null), [vault]);
  const fileTree = useVaultStore((state) => state.fileTree);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [hoveredUrl, setHoveredUrl] = useState<string | null>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const renderedPreview = useMemo(() => {
    try {
      const body = stripFrontmatter(content);
      const withMath = preprocessMath(body);
      const withPlots = preprocessDisplayMathPlots(withMath);
      const withLinks = preprocessWikilinks(withPlots.source);
      const rendered = md.render(withLinks);
      return {
        html: DOMPurify.sanitize(rendered, PURIFY_CONFIG) as unknown as string,
        plotBlocks: withPlots.plotBlocks,
      };
    } catch (e) {
      console.error('[MarkdownPreview] render error:', e);
      return {
        html: `<pre style="color:red;white-space:pre-wrap">${String(e)}</pre>`,
        plotBlocks: [],
      };
    }
  }, [content]);

  const html = renderedPreview.html;
  const plotBlocks = renderedPreview.plotBlocks;

  useEffect(() => {
    if (!webPreviewsEnabled || !hoverWebLinkPreviewsEnabled || !backgroundWebPreviewPrefetchEnabled)
      return;
    const urls = extractHttpUrls(content);
    if (urls.length === 0) return;
    prefetchWebPreviews(urls);
  }, [
    backgroundWebPreviewPrefetchEnabled,
    content,
    hoverWebLinkPreviewsEnabled,
    webPreviewsEnabled,
  ]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let cancelled = false;
    const imagePromises: Promise<void>[] = [];
    const mermaidJob = renderMermaidBlocks(root);

    const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'));

    for (const image of images) {
      const rawSrc = image.getAttribute('src');
      if (!rawSrc) continue;
      if (!client || !currentDocumentRelativePath) {
        imagePromises.push(waitForImageLoad(image));
        continue;
      }
      const target = resolveNoteAssetTarget(rawSrc, currentDocumentRelativePath, fileTree);
      if (!target || target.kind !== 'vault') {
        imagePromises.push(waitForImageLoad(image));
        continue;
      }

      image.dataset.assetKind = 'vault';
      image.dataset.assetValue = target.value;

      const imagePromise = client
        .readAssetDataUrl(target.value)
        .then((dataUrl) => {
          if (cancelled || !image.isConnected) return;
          image.src = dataUrl;
          const logicSource = extractLogicDiagramExportSource(dataUrl);
          if (logicSource) image.dataset.logicSourcePath = logicSource;
          return waitForImageLoad(image);
        })
        .catch(() => {
          if (cancelled || !image.isConnected) return;
          image.dataset.previewError = 'true';
        });
      imagePromises.push(imagePromise.then(() => undefined));
    }

    const expected3dCanvases = plotBlocks.reduce(
      (count, parsed) => count + parsed.plots.filter((plot) => plot.kind === '3d').length,
      0,
    );
    const ready = Promise.all([
      ...imagePromises,
      mermaidJob.ready,
      waitForPlotCanvases(root, expected3dCanvases),
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
    ]);

    void ready.then(() => {
      if (!cancelled) onReady?.();
    });

    return () => {
      cancelled = true;
      mermaidJob.cancel();
    };
  }, [
    accentColor,
    client,
    currentDocumentRelativePath,
    fileTree,
    html,
    onReady,
    plotBlocks,
    theme,
  ]);

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    const image = (e.target as HTMLElement).closest<HTMLImageElement>(
      'img[data-asset-kind="vault"]',
    );
    if (image?.dataset.assetValue) {
      const sourcePath = image.dataset.logicSourcePath;
      const sourceExists = sourcePath
        ? flattenVaultFiles(fileTree).some((entry) => entry.relativePath === sourcePath)
        : false;
      const targetPath = sourceExists ? sourcePath! : image.dataset.assetValue;
      useEditorStore
        .getState()
        .openTab(targetPath, getVaultDocumentTitle(targetPath), sourceExists ? 'logic' : 'image');
      useUiStore.getState().setActiveView('editor');
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!onWikilinkClick) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.wikilink');
    if (el?.dataset.path) onWikilinkClick(el.dataset.path);
  }

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!webPreviewsEnabled || !hoverWebLinkPreviewsEnabled) {
      if (hoveredUrl) {
        setHoveredUrl(null);
        setHoverRect(null);
      }
      return;
    }
    const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    const href = anchor?.getAttribute('href');
    if (anchor && isPreviewableHttpUrl(href)) {
      const nextUrl = href ?? null;
      const nextRect = anchor.getBoundingClientRect();
      if (nextUrl !== hoveredUrl) setHoveredUrl(nextUrl);
      setHoverRect(nextRect);
      return;
    }
    if (hoveredUrl) {
      setHoveredUrl(null);
      setHoverRect(null);
    }
  }

  function handleMouseLeave() {
    setHoveredUrl(null);
    setHoverRect(null);
  }

  return (
    <>
      <div
        ref={rootRef}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <div
          className={`markdown-preview ${className}`}
          // Deliberate: `html` comes from the sanitising renderer above, never
          // from untrusted input reaching this component directly.
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {plotBlocks.length > 0 && (
          <div className="markdown-preview-plots">
            {plotBlocks.map((parsed, index) => (
              <MathPlotPreviewStack key={index} parsed={parsed} />
            ))}
          </div>
        )}
      </div>
      <WebLinkPreviewPopover
        anchorRect={hoverRect}
        url={hoveredUrl}
        enabled={webPreviewsEnabled && hoverWebLinkPreviewsEnabled}
      />
    </>
  );
}

export function MarkdownPreview(props: MarkdownPreviewProps) {
  return (
    <PreviewErrorBoundary>
      <PreviewInner {...props} />
    </PreviewErrorBoundary>
  );
}
