import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

import aliases from '../generated/highlight-languages.json';

for (const [name, grammar] of Object.entries({
  javascript,
  typescript,
  json,
  bash,
  css,
  xml,
  python,
  rust,
  markdown,
  plaintext,
  yaml,
  sql,
})) {
  hljs.registerLanguage(name, grammar);
}

export function highlightLanguage(language: string): string | null {
  const key = language.toLowerCase();
  return Object.prototype.hasOwnProperty.call(aliases, key)
    ? (aliases as Record<string, string>)[key]
    : null;
}

export function highlightCommonCode(code: string, language: string): string | null {
  const canonical = highlightLanguage(language);
  if (!canonical || !hljs.getLanguage(canonical)) return null;
  try {
    return hljs.highlight(code, { language: canonical, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

// Keep the complete uncommon-language catalog in one deferred chunk. Loading
// the full registry here preserves aliases and embedded/sub-language behavior.
let uncommon: Promise<typeof import('highlight.js')> | undefined;
export async function highlightDeferredCodeBlocks(root: HTMLElement, signal: AbortSignal) {
  const blocks = [...root.querySelectorAll<HTMLElement>('code[data-highlight-language]')].filter(
    (element) => highlightLanguage(element.dataset.highlightLanguage ?? ''),
  );
  if (!blocks.length) return;
  const pending = blocks.map((element) => ({
    element,
    source: element.textContent ?? '',
    language: element.dataset.highlightLanguage!,
  }));
  try {
    await (uncommon ??= import('highlight.js'));
  } catch {
    return;
  } // Plain text remains usable if optional highlighting fails.
  for (const { element, source, language } of pending) {
    if (
      signal.aborted ||
      !element.isConnected ||
      element.textContent !== source ||
      element.dataset.highlightLanguage !== language
    )
      continue;
    const highlighted = highlightCommonCode(source, language);
    if (highlighted === null) continue;
    element.innerHTML = DOMPurify.sanitize(highlighted) as string;
    delete element.dataset.highlightLanguage;
  }
}
