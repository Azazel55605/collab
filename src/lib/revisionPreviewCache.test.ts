import { expect, it } from 'vitest';

import { cachedRevisionPreview, rememberRevisionPreview } from './revisionPreviewCache';

it('requires account-scoped keys, source hashes and the current renderer', () => {
  rememberRevisionPreview('server:userA:vault:path', {
    hash: 'one',
    renderer: 2,
    dataUrl: 'preview',
  });
  expect(cachedRevisionPreview('server:userA:vault:path', 'one')).toBe('preview');
  expect(cachedRevisionPreview('server:userB:vault:path', 'one')).toBeNull();
  expect(cachedRevisionPreview('server:userA:vault:path', 'two')).toBeNull();
  rememberRevisionPreview('old', { hash: 'one', renderer: 1, dataUrl: 'old' });
  expect(cachedRevisionPreview('old', 'one')).toBeNull();
});
it('evicts old thumbnails under an entry and byte budget', () => {
  for (let i = 0; i < 70; i++)
    rememberRevisionPreview(`item${i}`, { hash: 'hash', renderer: 2, dataUrl: 'svg' });
  expect(cachedRevisionPreview('item0', 'hash')).toBeNull();
  expect(cachedRevisionPreview('item69', 'hash')).toBe('svg');
  rememberRevisionPreview('oversized', {
    hash: 'hash',
    renderer: 2,
    dataUrl: 'x'.repeat(9 * 1024 * 1024),
  });
  expect(cachedRevisionPreview('oversized', 'hash')).toBeNull();
});
