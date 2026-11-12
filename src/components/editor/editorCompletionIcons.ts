import type { Completion } from '@codemirror/autocomplete';

/*
 * Lucide glyph geometry. Terminal and Type are derived from Feather.
 * ISC License
 *
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * The MIT License (MIT) (for the icons listed above)
 *
 * Copyright (c) 2013-present Cole Bemis
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

type Glyph = { frame?: boolean; paths: readonly string[] };

const glyphs = {
  table: { frame: true, paths: ['M12 3v18', 'M3 9h18', 'M3 15h18'] },
  property: { frame: true, paths: ['M9 3v18', 'M15 3v18'] },
  namespace: {
    paths: [
      'M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z',
      'M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z',
      'M3 5a2 2 0 0 0 2 2h3',
      'M3 3v13a2 2 0 0 0 2 2h3',
    ],
  },
  keyword: { paths: ['M12 19h8', 'm4 17 6-6-6-6'] },
  function: { frame: true, paths: ['M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3', 'M9 11.2h5.7'] },
  file: {
    paths: [
      'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
      'M14 2v5a1 1 0 0 0 1 1h5',
      'M10 9H8',
      'M16 13H8',
      'M16 17H8',
    ],
  },
  text: { paths: ['M12 4v16', 'M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2', 'M9 20h6'] },
  type: {
    paths: [
      'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
      'm3.3 7 8.7 5 8.7-5',
      'M12 22V12',
    ],
  },
  variable: {
    paths: [
      'M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1',
      'M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1',
    ],
  },
} satisfies Record<string, Glyph>;

const glyphByType = new Map<string, Glyph>([
  ...Object.entries(glyphs),
  ['method', glyphs.function],
  ['class', glyphs.type],
  ['interface', glyphs.type],
  ['enum', glyphs.type],
  ['constant', glyphs.variable],
]);

const svgNamespace = 'http://www.w3.org/2000/svg';

function renderCompletionIcon(completion: Completion) {
  const type = completion.type?.split(' ')[0] ?? 'text';
  const shape: Glyph = glyphByType.get(type) ?? glyphs.text;
  const icon = document.createElementNS(svgNamespace, 'svg');
  icon.classList.add('cm-collab-completion-icon');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  icon.setAttribute('stroke-linecap', 'round');
  icon.setAttribute('stroke-linejoin', 'round');
  icon.setAttribute('aria-hidden', 'true');
  if (shape.frame) {
    const frame = document.createElementNS(svgNamespace, 'rect');
    const bounds = { x: '3', y: '3', width: '18', height: '18', rx: '2' };
    for (const [attribute, value] of Object.entries(bounds)) frame.setAttribute(attribute, value);
    icon.appendChild(frame);
  }
  for (const d of shape.paths) {
    const path = document.createElementNS(svgNamespace, 'path');
    path.setAttribute('d', d);
    icon.appendChild(path);
  }
  return icon;
}

export const editorCompletionOptions = {
  icons: false,
  addToOptions: [{ render: renderCompletionIcon, position: 20 }],
};
