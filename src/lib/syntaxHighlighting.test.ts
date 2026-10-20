import { describe, expect, it } from 'vitest';

import {
  highlightCommonCode,
  highlightDeferredCodeBlocks,
  highlightLanguage,
} from './syntaxHighlighting';

describe('deferred syntax highlighting', () => {
  it('keeps common aliases immediate and unknown/prototype names as plain text', () => {
    expect(highlightCommonCode('const answer = 42;', 'js')).toContain('hljs-keyword');
    expect(highlightCommonCode('<b>source</b>', 'txt')).toContain('&lt;b&gt;');
    expect(highlightCommonCode('fun main() {}', 'kotlin')).toBeNull();
    expect(highlightLanguage('kt')).toBe('kotlin');
    expect(highlightLanguage('not-a-language')).toBeNull();
    expect(highlightLanguage('constructor')).toBeNull();
    expect(highlightLanguage('__proto__')).toBeNull();
  });

  it('loads uncommon grammars without changing copied source or inserting HTML from code', async () => {
    const root = document.createElement('div');
    const code = document.createElement('code');
    const source = 'fun main() { println("<img src=x onerror=alert(1)>") }';
    code.dataset.highlightLanguage = 'kotlin';
    code.textContent = source;
    root.append(code);
    document.body.append(root);
    await highlightDeferredCodeBlocks(root, new AbortController().signal);
    expect(code.querySelector('.hljs-keyword')).not.toBeNull();
    expect(code.querySelector('img')).toBeNull();
    expect(code.textContent).toBe(source);
    expect(code.dataset.highlightLanguage).toBeUndefined();
  });

  it('does not apply late highlighting after editing, detaching or cancelling', async () => {
    for (const operation of ['edit', 'detach', 'cancel']) {
      const root = document.createElement('div');
      const code = document.createElement('code');
      code.dataset.highlightLanguage = 'kotlin';
      code.textContent = 'fun main() {}';
      root.append(code);
      document.body.append(root);
      const controller = new AbortController();
      const work = highlightDeferredCodeBlocks(root, controller.signal);
      if (operation === 'edit') code.textContent = 'new source';
      if (operation === 'detach') root.remove();
      if (operation === 'cancel') controller.abort();
      await work;
      expect(code.querySelector('span')).toBeNull();
    }
  });
});
