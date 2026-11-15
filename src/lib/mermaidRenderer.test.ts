import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearMermaidRenderCache,
  isMermaidLanguage,
  mermaidCompatibleColor,
  renderMermaidBlocks,
  renderMermaidInto,
} from './mermaidRenderer';

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (_id: string, source: string) => ({
    svg: `<svg viewBox="0 0 320 120"><script>alert(1)</script><text>${source}</text></svg>`,
  })),
}));

describe('mermaidRenderer', () => {
  beforeEach(() => {
    clearMermaidRenderCache();
    Object.assign(globalThis, { mermaid: mermaidMocks });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'mermaid');
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('recognizes Mermaid fence info strings', () => {
    expect(isMermaidLanguage('mermaid')).toBe(true);
    expect(isMermaidLanguage('Mermaid title="Sync flow"')).toBe(true);
    expect(isMermaidLanguage('typescript')).toBe(false);
  });

  it('converts Collab OKLCH theme colors to Mermaid-compatible colors', () => {
    expect(mermaidCompatibleColor('oklch(1 0 0)', '#000000')).toBe('#ffffff');
    expect(mermaidCompatibleColor('oklch(0 0 0)', '#ffffff')).toBe('#000000');
    expect(mermaidCompatibleColor('oklch(1 0 0 / 11%)', '#000000')).toBe(
      'rgba(255, 255, 255, 0.11)',
    );
    expect(mermaidCompatibleColor('oklch(0.67 0.22 293)', '#a78bfa')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('renders fenced sources as sanitized accessible SVGs', async () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<pre class="md-mermaid-source">',
      '<code class="language-mermaid">flowchart LR\nA --&gt; B</code>',
      '</pre>',
    ].join('');
    document.body.appendChild(root);

    const job = renderMermaidBlocks(root);
    await job.ready;

    expect(mermaidMocks.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
        maxEdges: 500,
        maxTextSize: 50_000,
      }),
    );
    expect(mermaidMocks.render).toHaveBeenCalledWith(
      expect.stringMatching(/^collab-mermaid-/),
      'flowchart LR\nA --> B',
    );
    const svg = root.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('Mermaid diagram');
    expect(svg?.querySelector('script')).toBeNull();
  });

  it('rerenders an existing diagram so theme changes can update its colors', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<pre class="md-mermaid-source"><code>flowchart LR\nA --> B</code></pre>';
    document.body.appendChild(root);

    await renderMermaidBlocks(root).ready;
    // A theme switch changes the colours the diagram is rendered with.
    const style = vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--card' ? '#123456' : ''),
    } as CSSStyleDeclaration);
    await renderMermaidBlocks(root).ready;
    style.mockRestore();

    expect(mermaidMocks.render).toHaveBeenCalledTimes(2);
    expect(root.querySelectorAll('.md-mermaid-block')).toHaveLength(1);
  });

  it('reuses a rendered diagram when the same source comes back with the same theme', async () => {
    const first = document.createElement('div');
    const second = document.createElement('div');
    document.body.append(first, second);
    const source = 'flowchart LR\nCached --> Again';

    await renderMermaidInto(first, source).ready;
    const calls = mermaidMocks.render.mock.calls.length;
    await renderMermaidInto(second, source).ready;

    expect(mermaidMocks.render.mock.calls.length).toBe(calls);
    expect(second.querySelector('svg')).toBeTruthy();
  });
});
