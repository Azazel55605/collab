import { describe, expect, it } from 'vitest';

import {
  buildNodePreviewState,
  buildWebPreviewState,
  cleanPreviewText,
  getPreviewKey,
} from './CanvasPreviewUtils';

describe('CanvasPreviewUtils', () => {
  it('cleans markdown-heavy preview text', () => {
    expect(cleanPreviewText('---\ntitle: Test\n---\n# Heading\nA [link](https://example.com) and ![img](x.png) text.')).toBe(
      'Heading A link and text.',
    );
  });

  it('builds stable preview keys for vault files and web cards', () => {
    expect(getPreviewKey({
      id: 'note-1',
      type: 'note',
      relativePath: 'Notes/alpha.md',
      position: { x: 0, y: 0 },
      width: 300,
      height: 180,
    })).toBe('vault:Notes/alpha.md');

    expect(getPreviewKey({
      id: 'web-1',
      type: 'web',
      url: 'example.com/docs',
      displayModeOverride: null,
      position: { x: 0, y: 0 },
      width: 360,
      height: 240,
    })).toBe('web:https://example.com/docs');
  });

  it('builds node preview state from relative paths', () => {
    expect(buildNodePreviewState({
      id: 'file-1',
      type: 'file',
      relativePath: 'Docs/spec.md',
      position: { x: 0, y: 0 },
      width: 300,
      height: 180,
    }, {
      excerpt: 'preview body',
      markdownContent: '# Spec',
    })).toMatchObject({
      title: 'spec',
      subtitle: 'Docs',
      excerpt: 'preview body',
      markdownContent: '# Spec',
      extension: 'md',
    });
  });

  it('builds web preview state with metadata and fallback mode', () => {
    expect(buildWebPreviewState({
      id: 'web-1',
      type: 'web',
      url: 'https://example.com/docs',
      displayModeOverride: null,
      position: { x: 0, y: 0 },
      width: 360,
      height: 240,
    }, {
      linkPreview: {
        resolvedUrl: 'https://example.com/docs',
        title: 'Example Docs',
        description: 'Reference material',
        siteName: 'Example',
        imageUrl: 'https://example.com/image.png',
        faviconUrl: 'https://example.com/favicon.ico',
        embeddable: true,
      },
      loaded: true,
    }, 'preview', true, true)).toMatchObject({
      title: 'Example Docs',
      subtitle: 'Example',
      excerpt: 'Reference material',
      hasRichPreview: true,
      displayMode: 'preview',
      embedAvailable: true,
      previewLoaded: true,
    });
  });
});
