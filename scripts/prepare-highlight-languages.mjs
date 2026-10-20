import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import hljs from 'highlight.js';

// Only this Node build helper imports the complete grammar catalog eagerly.
const aliases = {};
for (const language of hljs.listLanguages().sort()) {
  aliases[language] = language;
  for (const alias of hljs.getLanguage(language).aliases ?? [])
    aliases[alias.toLowerCase()] = language;
}
const destination = new URL('../src/generated/highlight-languages.json', import.meta.url);
const content = JSON.stringify(Object.fromEntries(Object.entries(aliases).sort()), null, 2) + '\n';
let previous;
try {
  previous = await readFile(destination, 'utf8');
} catch {
  /* First generation. */
}
if (previous !== content) {
  if (process.argv.includes('--check'))
    throw new Error(
      'Highlight language aliases are stale. Run node scripts/prepare-highlight-languages.mjs.',
    );
  await writeFile(fileURLToPath(destination), content);
}
