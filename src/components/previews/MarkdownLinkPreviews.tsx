import type { MarkdownLinkPreviewState } from '../../lib/markdownLinkPreview';

import { FileTreeHoverPreviewPopover } from './FileTreeHoverPreviewPopover';
import { WebLinkPreviewPopover } from './WebLinkPreviewPopover';

export function MarkdownLinkPreviews({ preview }: { preview: MarkdownLinkPreviewState }) {
  return (
    <>
      <WebLinkPreviewPopover anchorRect={preview.rect} url={preview.url} enabled={!!preview.url} />
      <FileTreeHoverPreviewPopover
        key={preview.file?.relativePath ?? ''}
        anchorRect={preview.rect}
        relativePath={preview.file?.relativePath ?? null}
        type={preview.file?.type ?? null}
        enabled={!!preview.file}
        placement="below"
      />
    </>
  );
}
