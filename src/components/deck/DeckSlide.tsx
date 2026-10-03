import { memo, useId, useMemo } from 'react';

import DOMPurify from 'dompurify';

import { accessibleItemLabel, accessibleSlideItems } from '../../lib/deck/accessibility';
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
  const accessibleId = useId();
  const height = (width * slide.height) / slide.width;
  const markup = useMemo(
    () =>
      DOMPurify.sanitize(
        renderSlideSvg(slide, { measurer, resolveAsset, pixelWidth: width, pixelHeight: height }),
        { USE_PROFILES: { svg: true } },
      ),
    [height, measurer, resolveAsset, slide, width],
  );
  const accessibleItems = useMemo(() => accessibleSlideItems(slide), [slide]);
  const slideLabel = label ?? `Slide ${slide.number}`;
  return (
    <div className={className} style={{ width, height }}>
      <div
        role="img"
        aria-label={slideLabel}
        aria-describedby={accessibleId}
        style={{ width: '100%', height: '100%' }}
        // Sanitized above; see the component comment.
        dangerouslySetInnerHTML={{ __html: markup }}
      />
      <ol id={accessibleId} className="sr-only" aria-label="Slide contents">
        {accessibleItems.map((item, index) => (
          <li key={`${item.origin}:${item.id}:${index}`}>{accessibleItemLabel(item)}</li>
        ))}
      </ol>
    </div>
  );
}

export const DeckSlide = memo(DeckSlideComponent);
