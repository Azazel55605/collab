import { describe, expect, it, vi } from 'vitest';

import { openNonVaultMarkdownPreviewLink } from './markdownLinkOpen';

describe('MarkdownEditor link helpers', () => {
  it('does not try to open malformed non-web markdown links', () => {
    const openExternal = vi.fn();
    const onInvalidLink = vi.fn();

    expect(openNonVaultMarkdownPreviewLink('note', { openExternal, onInvalidLink })).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
    expect(onInvalidLink).toHaveBeenCalledWith('This link is not a valid vault file or web URL.');
  });

  it('opens valid web urls through the external opener', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const onInvalidLink = vi.fn();

    expect(
      openNonVaultMarkdownPreviewLink('https://example.com', { openExternal, onInvalidLink }),
    ).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://example.com');
    expect(onInvalidLink).not.toHaveBeenCalled();
  });
});
