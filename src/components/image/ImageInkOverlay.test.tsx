import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { defaultToolState } from '../../lib/ink/tools';
import { createAnchoredAnnotationDocument } from '../../lib/viewAnnotations';

import ImageInkOverlay from './ImageInkOverlay';

describe('ImageInkOverlay', () => {
  it('does not allocate an empty canvas overlay in view mode', () => {
    const { container } = render(
      <ImageInkOverlay
        document={createAnchoredAnnotationDocument('image.png')}
        width={1_920}
        height={1_080}
        displayWidth={960}
        displayHeight={540}
        enabled={false}
        readOnly={false}
        tool={defaultToolState()}
        onChange={vi.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });
});
