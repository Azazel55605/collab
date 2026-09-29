import { memo, useMemo } from 'react';

import DOMPurify from 'dompurify';

import type { ResolvedSlide } from '../../lib/deck/resolve';
import { renderSlideSvg } from '../../lib/deck/svg';
import type { DeckTextMeasurer } from '../../lib/deck/textLayout';
import type { DeckAssetRef } from '../../types/deck';

interface DeckSlideProps {
  slide: ResolvedSlide;
  /** Output width in CSS pixels; the height follows the slide's aspect ratio. */
  width: number;
  measurer: DeckTextMeasurer;
  resolveAsset: (asset: DeckAssetRef) => string | null;
  className?: string;
  label?: string;
}

/**
 * One slide, drawn from the shared resolved scene.
 *
 * The SVG is inline so it uses the page's loaded fonts (an SVG in an `<img>`
 * cannot). `svg.ts` already escapes every document string and refuses any
 * `href` that is not an inline image; DOMPurify's SVG profile is a second,
 * independent guard against a renderer bug turning document text into markup.
 */
function DeckSlideComponent({
  slide,
  width,
  measurer,
  resolveAsset,
  className,
  label,
}: DeckSlideProps) {
  const height = (width * slide.height) / slide.width;
  const markup = useMemo(
    () =>
      DOMPurify.sanitize(
        renderSlideSvg(slide, { measurer, resolveAsset, pixelWidth: width, pixelHeight: height }),
        { USE_PROFILES: { svg: true } },
      ),
    [height, measurer, resolveAsset, slide, width],
  );
  return (
    <div
      role="img"
      aria-label={label ?? `Slide ${slide.number}`}
      className={className}
      style={{ width, height }}
      // Sanitized above; see the component comment.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

export const DeckSlide = memo(DeckSlideComponent);
