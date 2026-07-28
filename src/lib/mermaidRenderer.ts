import DOMPurify from 'dompurify';
import mermaidBundleUrl from 'mermaid/dist/mermaid.min.js?url';

const MAX_MERMAID_SOURCE_CHARS = 50_000;
const MAX_MERMAID_EDGES = 500;
const MERMAID_SCRIPT_ATTRIBUTE = 'data-collab-mermaid';

let renderSequence = 0;
type MermaidApi = typeof import('mermaid')['default'];
type MermaidGlobal = typeof globalThis & { mermaid?: MermaidApi };

let mermaidModule: Promise<MermaidApi> | null = null;
let renderQueue: Promise<void> = Promise.resolve();
const renderedBlockSources = new WeakMap<HTMLElement, string>();

export interface MermaidRenderJob {
  ready: Promise<void>;
  cancel(): void;
}

function loadMermaid() {
  const existing = (globalThis as MermaidGlobal).mermaid;
  if (existing) return Promise.resolve(existing);
  if (mermaidModule) return mermaidModule;

  mermaidModule = new Promise<MermaidApi>((resolve, reject) => {
    document.querySelector<HTMLScriptElement>(
      `script[${MERMAID_SCRIPT_ATTRIBUTE}]`,
    )?.remove();

    const script = document.createElement('script');
    const finish = () => {
      const mermaid = (globalThis as MermaidGlobal).mermaid;
      if (mermaid) resolve(mermaid);
      else {
        script.remove();
        reject(new Error('Mermaid browser bundle loaded without exposing its API'));
      }
    };
    script.src = mermaidBundleUrl;
    script.async = true;
    script.setAttribute(MERMAID_SCRIPT_ATTRIBUTE, '');
    script.addEventListener('load', finish, { once: true });
    script.addEventListener(
      'error',
      () => {
        script.remove();
        reject(new Error('Mermaid browser bundle could not load'));
      },
      { once: true },
    );
    document.head.appendChild(script);
  }).catch((error) => {
    mermaidModule = null;
    throw error;
  });

  return mermaidModule;
}

function cssVariable(style: CSSStyleDeclaration, name: string, fallback: string) {
  return style.getPropertyValue(name).trim() || fallback;
}

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value));
}

function linearSrgbToByte(value: number) {
  const clamped = clampUnit(value);
  const gamma = clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.round(clampUnit(gamma) * 255);
}

export function mermaidCompatibleColor(value: string, fallback: string) {
  const match = value.trim().match(
    /^oklch\(\s*([+-]?(?:\d+\.?\d*|\.\d+))(%?)\s*(?:,|\s)\s*([+-]?(?:\d+\.?\d*|\.\d+))(%?)\s*(?:,|\s)\s*([+-]?(?:\d+\.?\d*|\.\d+))(?:deg)?(?:\s*\/\s*([+-]?(?:\d+\.?\d*|\.\d+))(%?))?\s*\)$/i,
  );
  if (!match) return value || fallback;

  const lightness = Number(match[1]) / (match[2] ? 100 : 1);
  const chroma = Number(match[3]) * (match[4] ? 0.004 : 1);
  const hue = Number(match[5]) * Math.PI / 180;
  const alpha = match[6] === undefined
    ? 1
    : Number(match[6]) / (match[7] ? 100 : 1);
  if (![lightness, chroma, hue, alpha].every(Number.isFinite)) return fallback;

  const labA = chroma * Math.cos(hue);
  const labB = chroma * Math.sin(hue);
  const lPrime = lightness + 0.3963377774 * labA + 0.2158037573 * labB;
  const mPrime = lightness - 0.1055613458 * labA - 0.0638541728 * labB;
  const sPrime = lightness - 0.0894841775 * labA - 1.291485548 * labB;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const red = linearSrgbToByte(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = linearSrgbToByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = linearSrgbToByte(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);

  if (alpha < 1) {
    return `rgba(${red}, ${green}, ${blue}, ${Number(clampUnit(alpha).toFixed(4))})`;
  }
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function mermaidThemeColor(
  style: CSSStyleDeclaration,
  name: string,
  fallback: string,
) {
  return mermaidCompatibleColor(cssVariable(style, name, fallback), fallback);
}

function mermaidThemeVariables(target: HTMLElement) {
  const style = getComputedStyle(target.isConnected ? target : document.documentElement);
  return {
    background: mermaidThemeColor(style, '--background', '#101116'),
    primaryColor: mermaidThemeColor(style, '--card', '#181a22'),
    primaryTextColor: mermaidThemeColor(style, '--foreground', '#f4f4f5'),
    primaryBorderColor: mermaidThemeColor(style, '--border', '#343741'),
    lineColor: mermaidThemeColor(style, '--primary', '#a78bfa'),
    secondaryColor: mermaidThemeColor(style, '--muted', '#252833'),
    tertiaryColor: mermaidThemeColor(style, '--accent', '#2f3340'),
    fontFamily: cssVariable(style, '--font-interface', 'Inter, sans-serif'),
  };
}

function enqueueRender(task: () => Promise<void>) {
  const pending = renderQueue.then(task, task);
  renderQueue = pending.catch(() => undefined);
  return pending;
}

function renderError(target: HTMLElement, source: string, reason: unknown) {
  target.replaceChildren();
  target.classList.remove('is-loading');
  target.classList.add('is-error');

  const message = document.createElement('div');
  message.className = 'md-mermaid-error';
  const detail = reason instanceof Error ? reason.message.trim().slice(0, 300) : '';
  message.textContent = detail
    ? `Diagram could not render: ${detail}`
    : 'Diagram could not render.';

  const pre = document.createElement('pre');
  pre.className = 'md-mermaid-fallback';
  const code = document.createElement('code');
  code.textContent = source;
  pre.appendChild(code);
  target.append(message, pre);
}

export function isMermaidLanguage(language: string) {
  return language.trim().split(/\s+/, 1)[0]?.toLowerCase() === 'mermaid';
}

export function renderMermaidInto(target: HTMLElement, source: string): MermaidRenderJob {
  let cancelled = false;
  target.classList.add('md-mermaid-canvas', 'is-loading');
  target.setAttribute('aria-busy', 'true');
  target.textContent = 'Rendering diagram...';

  const ready = enqueueRender(async () => {
    if (source.length > MAX_MERMAID_SOURCE_CHARS) {
      throw new Error(`diagram source exceeds ${MAX_MERMAID_SOURCE_CHARS.toLocaleString()} characters`);
    }

    const mermaid = await loadMermaid();
    if (!target.isConnected && typeof requestAnimationFrame === 'function') {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    if (cancelled) return;

    const themeVariables = mermaidThemeVariables(target);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      look: 'classic',
      htmlLabels: false,
      maxTextSize: MAX_MERMAID_SOURCE_CHARS,
      maxEdges: MAX_MERMAID_EDGES,
      fontFamily: themeVariables.fontFamily,
      themeVariables,
      flowchart: {
        useMaxWidth: true,
      },
    });

    const id = `collab-mermaid-${++renderSequence}`;
    const { svg } = await mermaid.render(id, source);
    if (cancelled) return;

    const sanitized = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['foreignObject', 'script'],
    }) as unknown as string;
    const template = document.createElement('template');
    template.innerHTML = sanitized;
    const renderedSvg = template.content.querySelector('svg');
    if (!renderedSvg) throw new Error('renderer returned no SVG');

    renderedSvg.setAttribute('role', 'img');
    renderedSvg.setAttribute('aria-label', 'Mermaid diagram');
    renderedSvg.removeAttribute('height');
    renderedSvg.setAttribute('width', '100%');
    target.replaceChildren(renderedSvg);
    target.classList.remove('is-loading', 'is-error');
    target.removeAttribute('aria-busy');
  }).catch((reason) => {
    if (!cancelled) renderError(target, source, reason);
  });

  return {
    ready,
    cancel() {
      cancelled = true;
    },
  };
}

export function renderMermaidBlocks(root: HTMLElement): MermaidRenderJob {
  let cancelled = false;
  const jobs: MermaidRenderJob[] = [];

  for (const figure of root.querySelectorAll<HTMLElement>('.md-mermaid-block')) {
    const source = renderedBlockSources.get(figure);
    const canvas = figure.querySelector<HTMLElement>('.md-mermaid-canvas');
    if (source !== undefined && canvas) {
      jobs.push(renderMermaidInto(canvas, source));
    }
  }

  for (const sourceBlock of root.querySelectorAll<HTMLPreElement>('pre.md-mermaid-source')) {
    const source = sourceBlock.querySelector('code')?.textContent ?? sourceBlock.textContent ?? '';
    const figure = document.createElement('figure');
    figure.className = 'md-mermaid-block';
    const canvas = document.createElement('div');
    figure.appendChild(canvas);
    renderedBlockSources.set(figure, source);
    sourceBlock.replaceWith(figure);
    jobs.push(renderMermaidInto(canvas, source));
  }

  return {
    ready: Promise.all(jobs.map((job) => job.ready)).then(() => undefined),
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const job of jobs) job.cancel();
    },
  };
}
