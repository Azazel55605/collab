import { expect, it } from 'vitest';

import { reconcilePreviewBlocks } from './previewBlocks';

it('retains hydrated resources, duplicate blocks and ordering across surrounding text edits', () => {
  const root = document.createElement('div');
  reconcilePreviewBlocks(
    root,
    '<p>before</p><p><img src="asset.png"></p><pre>diagram</pre><p>before</p>',
  );
  const image = root.querySelector('img')!;
  image.src = 'data:image/png;base64,hydrated';
  const diagram = root.querySelector('pre')!;
  diagram.replaceWith(document.createElement('figure'));
  const figure = root.querySelector('figure');
  const duplicate = root.lastElementChild;
  reconcilePreviewBlocks(
    root,
    '<p>changed</p><p><img src="asset.png"></p><pre>diagram</pre><p>before</p>',
  );
  expect(root.querySelector('img')).toBe(image);
  expect(image.getAttribute('src')).toContain('hydrated');
  expect(root.querySelector('figure')).toBe(figure);
  // Identical duplicate blocks can reuse either instance; only one survives.
  expect(root.querySelectorAll('p')).toHaveLength(3);
  expect(duplicate?.isConnected).toBe(false);
});
