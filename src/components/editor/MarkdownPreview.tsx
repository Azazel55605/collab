import {
  Component,
  type ErrorInfo,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';

import DOMPurify from 'dompurify';
import 'highlight.js/styles/atom-one-dark.css';
import katex from 'katex';
import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from 'markdown-it';
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

import '../../generated/katex.css';
import { extractInkExportSource } from '../../lib/ink/export';
import { extractLogicDiagramExportSource } from '../../lib/logicDiagramExport';
import { isMermaidLanguage, renderMermaidBlocks } from '../../lib/mermaidRenderer';
import { isLikelyImagePath, resolveNoteAssetTarget, waitForNoteImage } from '../../lib/noteAssets';
import { reconcilePreviewBlocks } from '../../lib/previewBlocks';
import {
  highlightCommonCode,
  highlightDeferredCodeBlocks,
  highlightLanguage,
} from '../../lib/syntaxHighlighting';
import { createVaultClient } from '../../lib/vaultClient';
import { flattenVaultFiles, getVaultDocumentTitle } from '../../lib/vaultLinks';
import { vaultTreeIndex } from '../../lib/vaultTreeIndex';
import { extractHttpUrls, prefetchWebPreviews } from '../../lib/webPreviewCache';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { useVaultStore } from '../../store/vaultStore';
import { MarkdownLinkPreviews } from '../previews/MarkdownLinkPreviews';
import { useMarkdownLinkPreviews } from '../previews/useMarkdownLinkPreviews';

import { MathPlot2D } from './MathPlot2D';
import { MathPlot3D } from './MathPlot3D';
import { openMathPlotModal } from './MathPlotModalHost';
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

const BARE_NOTE_IMAGE = /!\[([^\]\n]*)\]\\?\(([^()<>\n]+)\)/y;

function buildMd(): MarkdownItInstance {
  const instance: MarkdownItInstance = new MarkdownIt({
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
      const language = highlightLanguage(lang);
      const highlighted = language ? highlightCommonCode(str, language) : null;
      if (highlighted !== null) {
        return `<pre class="hljs md-code-block"><code class="language-${language}">${highlighted}</code></pre>`;
      }
      if (language) {
        return `<pre class="hljs md-code-block"><code class="language-${language}" data-highlight-language="${language}">${instance.utils.escapeHtml(str)}</code></pre>`;
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

  instance.inline.ruler.before('link', 'collab_wikilink', (state, silent) => {
    const start = state.pos;
    if (!state.src.startsWith('[[', start) && !state.src.startsWith('![[', start)) return false;
    const match = /^(!?)\[\[([^\]|\r\n]+)(?:\|([^\]\r\n]+))?\]\]/.exec(
      state.src.slice(start, state.posMax),
    );
    if (!match) return false;
    const [, embed, rawPath, alias] = match;
    const path = rawPath.trim();
    if (!path || (embed && (!isLikelyImagePath(path) || !instance.validateLink(path))))
      return false;
    if (!silent) {
      if (embed) {
        const image = state.push('wiki_image', 'img', 0);
        image.attrSet('src', path);
        image.attrSet('alt', alias ?? path.split('/').pop() ?? path);
      } else {
        const span = state.push('wikilink_open', 'span', 1);
        span.attrSet('class', 'wikilink');
        span.attrSet('data-path', path);
        state.push('text', '', 0).content = alias ?? path;
        state.push('wikilink_close', 'span', -1);
      }
    }
    state.pos += match[0].length;
    return true;
  });

  // The editor also accepts bare vault image paths containing spaces. Recover
  // those in rendered notes, including when the opening parenthesis was escaped.
  instance.inline.ruler.after('image', 'collab_bare_note_image', (state, silent) => {
    if (!state.src.startsWith('![', state.pos)) return false;
    BARE_NOTE_IMAGE.lastIndex = state.pos;
    const match = BARE_NOTE_IMAGE.exec(state.src);
    const end = match ? state.pos + match[0].length : state.pos;
    if (!match || end > state.posMax) return false;
    const [, alt, destination] = match;
    const path = destination.trim();
    if (
      !/\s/.test(path) ||
      !isLikelyImagePath(path) ||
      resolveNoteAssetTarget(path, '')?.kind !== 'vault'
    ) {
      return false;
    }
    const href = instance.normalizeLink(path);
    if (!instance.validateLink(href)) return false;
    if (!silent) {
      const image = state.push('note_image', 'img', 0);
      image.attrSet('src', href);
      image.attrSet('alt', instance.utils.unescapeAll(alt));
    }
    state.pos = end;
    return true;
  });

  instance.core.ruler.after('block', 'collab_print_spacing', (state) => {
    if (!state.env.preserveBlankLines) return;
    const lines = state.src.split('\n');
    const tokens: typeof state.tokens = [];
    let seenBlock = false;
    for (const token of state.tokens) {
      if (token.level === 0 && token.map) {
        // Lists and raw HTML can absorb trailing blank lines in their source
        // ranges. Count backwards from the next block's first line.
        const start = token.map[0];
        if (seenBlock && start > 0 && /^[ \t]*$/.test(lines[start - 1])) {
          for (let line = start - 2; line >= 0 && /^[ \t]*$/.test(lines[line]); line--) {
            const spacer = new state.Token('note_print_blank_line', 'div', 0);
            spacer.block = true;
            tokens.push(spacer);
          }
        }
        seenBlock = true;
      }
      tokens.push(token);
    }
    state.tokens = tokens;
  });
  instance.renderer.rules.note_print_blank_line = () =>
    '<div class="note-print-blank-line" aria-hidden="true"><br></div>\n';

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

let md: MarkdownItInstance;
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
  const source = src.replace(
    /\$\$([\s\S]+?)\$\$/g,
    (match: string, mathSource: string, offset: number) => {
      if (!/%plot[23]d\b/.test(mathSource)) return match;
      const parsed = parseMathPlots(mathSource);
      plotBlocks.push(parsed);
      const following = src.slice(offset + match.length);
      const lineBreak = /^[ \t]*(?:\r?\n|$)/.test(following) ? '' : '\n';
      return `$$${parsed.mathSource || mathSource}$$${lineBreak}`;
    },
  );
  return { source, plotBlocks };
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
  preserveBlankLines?: boolean;
  className?: string;
  onWikilinkClick?: (relativePath: string) => void;
  currentDocumentRelativePath?: string;
  onReady?: () => void;
}

function waitForPlotCanvases(root: HTMLElement, expectedCanvases: number): Promise<void> {
  if (expectedCanvases === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      if (
        root.querySelectorAll(
          '.markdown-preview-plots canvas, .markdown-preview-plots [data-plot-state="paused"], .markdown-preview-plots [data-plot-state="error"]',
        ).length >= expectedCanvases
      ) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > 5000) {
        resolve();
        return;
      }
      window.setTimeout(tick, 50);
    };
    // IntersectionObserver gets a frame to distinguish paused/offscreen plots
    // from visible plots which are still awaiting samples or WebGL startup.
    requestAnimationFrame(() => requestAnimationFrame(tick));
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
  preserveBlankLines = false,
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
  const linkPreviews = useMarkdownLinkPreviews(currentDocumentRelativePath);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const deferredContent = useDeferredValue(content);
  const imageSources = useRef(new WeakMap<HTMLImageElement, string>());
  const imageJobs = useRef(
    new WeakMap<
      HTMLImageElement,
      { revision: unknown; scope: string; client: unknown; promise: Promise<void> }
    >(),
  );
  const renderedPreview = useMemo(() => {
    try {
      const body = stripFrontmatter(deferredContent);
      const withMath = preprocessMath(body);
      const withPlots = preprocessDisplayMathPlots(withMath);
      const rendered = md.render(withPlots.source, { preserveBlankLines });
      return {
        html: DOMPurify.sanitize(rendered, PURIFY_CONFIG) as unknown as string,
        plotBlocks: withPlots.plotBlocks,
      };
    } catch (e) {
      console.error('[MarkdownPreview] render error:', e);
      return {
        html: `<pre style="color:red;white-space:pre-wrap">${md.utils.escapeHtml(String(e))}</pre>`,
        plotBlocks: [],
      };
    }
  }, [deferredContent, preserveBlankLines]);

  const html = renderedPreview.html;
  const plotBlocks = renderedPreview.plotBlocks;
  useLayoutEffect(() => {
    if (previewRef.current) reconcilePreviewBlocks(previewRef.current, html);
  }, [html]);

  useEffect(() => {
    if (!webPreviewsEnabled || !hoverWebLinkPreviewsEnabled || !backgroundWebPreviewPrefetchEnabled)
      return;
    const urls = extractHttpUrls(content);
    if (urls.length === 0) return;
    return prefetchWebPreviews(urls);
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
    const mermaidJob = renderMermaidBlocks(root, `${theme}:${accentColor}`);
    const highlighting = new AbortController();
    const highlightJob = highlightDeferredCodeBlocks(root, highlighting.signal);

    const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[src]'));

    for (const image of images) {
      if (onReady) image.loading = 'eager';
      const rawSrc = imageSources.current.get(image) ?? image.getAttribute('src');
      if (rawSrc) imageSources.current.set(image, rawSrc);
      if (!rawSrc) continue;
      if (!client || !currentDocumentRelativePath) {
        imagePromises.push(waitForNoteImage(image));
        continue;
      }
      const target = resolveNoteAssetTarget(rawSrc, currentDocumentRelativePath, fileTree);
      if (!target || target.kind !== 'vault') {
        imagePromises.push(waitForNoteImage(image));
        continue;
      }

      image.dataset.assetKind = 'vault';
      image.dataset.assetValue = target.value;

      const revision = vaultTreeIndex(fileTree).byPath.get(target.value);
      const scope = `${currentDocumentRelativePath}:${target.value}`;
      const retained = imageJobs.current.get(image);
      if (
        retained &&
        retained.revision === revision &&
        retained.scope === scope &&
        retained.client === client
      ) {
        imagePromises.push(retained.promise);
        continue;
      }
      const imagePromise = client
        .readAssetDataUrl(target.value)
        .then((dataUrl) => {
          if (!image.isConnected || imageJobs.current.get(image)?.promise !== imagePromise) return;
          image.src = dataUrl;
          const logicSource = extractLogicDiagramExportSource(dataUrl);
          if (logicSource) image.dataset.logicSourcePath = logicSource;
          const inkSource = extractInkExportSource(dataUrl);
          if (inkSource) image.dataset.inkSource = JSON.stringify(inkSource);
          return waitForNoteImage(image);
        })
        .catch(() => {
          if (!image.isConnected || imageJobs.current.get(image)?.promise !== imagePromise) return;
          image.dataset.previewError = 'true';
        });
      imageJobs.current.set(image, { revision, scope, client, promise: imagePromise });
      imagePromises.push(imagePromise);
    }

    const expected3dCanvases = plotBlocks.reduce(
      (count, parsed) => count + parsed.plots.filter((plot) => plot.kind === '3d').length,
      0,
    );
    const ready = Promise.all([
      ...imagePromises,
      mermaidJob.ready,
      highlightJob,
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
      highlighting.abort();
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
      const inkSource = image.dataset.inkSource
        ? extractStoredInkSource(image.dataset.inkSource)
        : null;
      const sourcePath = inkSource?.source ?? image.dataset.logicSourcePath;
      const sourceExists = sourcePath
        ? flattenVaultFiles(fileTree).some((entry) => entry.relativePath === sourcePath)
        : false;
      const targetPath = sourceExists ? sourcePath! : image.dataset.assetValue;
      const editor = useEditorStore.getState();
      if (sourceExists && inkSource) {
        editor.setInkViewState(inkSource.source, {
          pageId: inkSource.pageId,
          originX: inkSource.bounds.minX,
          originY: inkSource.bounds.minY,
          zoom: editor.inkViewStates[inkSource.source]?.zoom ?? 1,
        });
      }
      editor.openTab(
        targetPath,
        getVaultDocumentTitle(targetPath),
        sourceExists ? (inkSource ? 'ink' : 'logic') : 'image',
      );
      useUiStore.getState().setActiveView('editor');
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!onWikilinkClick) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.wikilink');
    if (el?.dataset.path) onWikilinkClick(el.dataset.path);
  }

  return (
    <>
      <div
        ref={rootRef}
        onClick={handleClick}
        onMouseMove={linkPreviews.move}
        onMouseLeave={linkPreviews.clear}
      >
        <div className={`markdown-preview ${className}`} ref={previewRef} />
        {plotBlocks.length > 0 && (
          <div className="markdown-preview-plots">
            {plotBlocks.map((parsed, index) => (
              <MathPlotPreviewStack
                key={`${JSON.stringify(parsed)}:${plotBlocks.slice(0, index).filter((block) => JSON.stringify(block) === JSON.stringify(parsed)).length}`}
                parsed={parsed}
              />
            ))}
          </div>
        )}
      </div>
      <MarkdownLinkPreviews preview={linkPreviews.preview} />
    </>
  );
}

function extractStoredInkSource(value: string) {
  try {
    const parsed = JSON.parse(value) as {
      marker?: string;
      source?: string;
      pageId?: string;
      bounds?: { minX?: number; minY?: number; maxX?: number; maxY?: number };
    };
    if (
      parsed.marker !== 'collab-ink-export' ||
      typeof parsed.source !== 'string' ||
      typeof parsed.pageId !== 'string' ||
      !parsed.bounds ||
      ![parsed.bounds.minX, parsed.bounds.minY, parsed.bounds.maxX, parsed.bounds.maxY].every(
        (entry) => typeof entry === 'number' && Number.isFinite(entry),
      )
    ) {
      return null;
    }
    return parsed as {
      marker: 'collab-ink-export';
      source: string;
      pageId: string;
      bounds: { minX: number; minY: number; maxX: number; maxY: number };
    };
  } catch {
    return null;
  }
}

export function MarkdownPreview(props: MarkdownPreviewProps) {
  return (
    <PreviewErrorBoundary>
      <PreviewInner {...props} />
    </PreviewErrorBoundary>
  );
}
