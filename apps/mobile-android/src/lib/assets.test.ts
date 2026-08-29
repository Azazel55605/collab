import { describe, expect, it } from 'vitest';

import type { HostedFileEntry } from '../mobileTauri';

import {
  base64DataUrl,
  dataUrlToBase64,
  isImageFile,
  isPdfFile,
  isRichViewableFile,
  mediaTypeForFile,
  svgDataUrl,
  uint8ArrayFromDataUrlChunked,
} from './assets';

function file(partial: Partial<HostedFileEntry> & { id: string; name: string }): HostedFileEntry {
  return {
    parentId: null,
    relativePath: partial.name,
    kind: 'asset',
    documentType: null,
    state: 'active',
    updatedAt: null,
    sizeBytes: null,
    contentHash: null,
    revisionSequence: null,
    ...partial,
  };
}

describe('mobile asset helpers', () => {
  it('classifies visual viewer files', () => {
    expect(isImageFile(file({ id: 'png', name: 'diagram.PNG' }))).toBe(true);
    expect(isImageFile(file({ id: 'svg', name: 'icon.svg', kind: 'document' }))).toBe(true);
    expect(isPdfFile(file({ id: 'pdf', name: 'brief.pdf' }))).toBe(true);
    expect(isRichViewableFile(file({ id: 'bin', name: 'archive.zip' }))).toBe(false);
  });

  it('maps media types for cached asset fallback', () => {
    expect(mediaTypeForFile(file({ id: 'jpg', name: 'photo.jpeg' }))).toBe('image/jpeg');
    expect(mediaTypeForFile(file({ id: 'pdf', name: 'spec.pdf' }))).toBe('application/pdf');
    expect(mediaTypeForFile(file({ id: 'unknown', name: 'blob.bin' }))).toBe(
      'application/octet-stream',
    );
  });

  it('converts data URL formats used by the replica cache', () => {
    expect(dataUrlToBase64('data:image/png;base64,abc123')).toBe('abc123');
    expect(dataUrlToBase64('plain text')).toBeNull();
    expect(base64DataUrl('abc123', 'image/png')).toBe('data:image/png;base64,abc123');
    expect(svgDataUrl('<svg viewBox="0 0 1 1"></svg>')).toContain('data:image/svg+xml');
  });

  it('decodes data URLs without requiring a single tight loop', async () => {
    await expect(uint8ArrayFromDataUrlChunked('data:text/plain;base64,SGVsbG8=')).resolves.toEqual(
      new Uint8Array([72, 101, 108, 108, 111]),
    );
  });
});
