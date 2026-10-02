/**
 * Every slide as a thumbnail, windowed: only the rows near the viewport mount,
 * so a long deck costs a screenful of SVGs. Columns follow the width, so the
 * grid reflows on rotation and on tablets.
 */
import { useLayoutEffect, useRef, useState } from 'react';

import { DeckSlide } from '../../../../src/components/deck/DeckSlide';
import type { ResolvedSlide } from '../../../../src/lib/deck/resolve';
import type { DeckTextMeasurer } from '../../../../src/lib/deck/textLayout';
import type { DeckAssetRef } from '../../../../src/types/deck';
import { thumbnailColumns, visibleThumbnailRange } from '../lib/deck';

import { useElementSize } from './useElementSize';

const GAP = 12;
const LABEL_HEIGHT = 22;

interface DeckThumbnailGridProps {
  slides: readonly ResolvedSlide[];
  /** Section names by the id of the slide each section begins at. */
  sectionStarts: ReadonlyMap<string, string>;
  activeIndex: number;
  measurer: DeckTextMeasurer;
  resolveAsset: (asset: DeckAssetRef) => string | null;
  onOpen: (index: number) => void;
}

export function DeckThumbnailGrid({
  slides,
  sectionStarts,
  activeIndex,
  measurer,
  resolveAsset,
  onOpen,
}: DeckThumbnailGridProps) {
  const [setHost, size] = useElementSize<HTMLDivElement>();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const columns = thumbnailColumns(size.width);
  const aspect = slides[0] ? slides[0].width / slides[0].height : 16 / 9;
  const thumbWidth = Math.max(0, Math.floor((size.width - GAP * (columns + 1)) / columns));
  const rowHeight = Math.round(thumbWidth / aspect) + LABEL_HEIGHT + GAP;
  const rows = Math.ceil(slides.length / columns);
  const range = visibleThumbnailRange(scrollTop, size.height, rowHeight, rows);

  // Bring the current slide into view when the grid opens or reflows.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || rowHeight <= GAP) return;
    const row = Math.floor(activeIndex / columns);
    const top = row * rowHeight;
    if (top < host.scrollTop || top + rowHeight > host.scrollTop + host.clientHeight) {
      host.scrollTop = Math.max(0, top - GAP);
      setScrollTop(host.scrollTop);
    }
    // Only on open and reflow, not while the person scrolls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, rowHeight]);

  const cells = [];
  for (let row = range.start; row < range.end; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      const slide = slides[index];
      if (!slide || thumbWidth <= 0) continue;
      const section = sectionStarts.get(slide.slideId);
      cells.push(
        <button
          key={slide.slideId}
          type="button"
          className={`deck-thumb${index === activeIndex ? ' active' : ''}${slide.hidden ? ' hidden-slide' : ''}`}
          style={{
            top: row * rowHeight + GAP,
            left: GAP + column * (thumbWidth + GAP),
            width: thumbWidth,
          }}
          aria-label={`Slide ${slide.number}${slide.hidden ? ', hidden' : ''}${section ? `, section ${section}` : ''}`}
          aria-current={index === activeIndex ? 'true' : undefined}
          onClick={() => onOpen(index)}
        >
          <DeckSlide
            slide={slide}
            width={thumbWidth}
            measurer={measurer}
            resolveAsset={resolveAsset}
            className="deck-thumb-image"
          />
          <span className="deck-thumb-label">
            <span>{slide.number}</span>
            {section && <span className="deck-thumb-section">{section}</span>}
            {slide.hidden && <span className="deck-thumb-hidden">Hidden</span>}
          </span>
        </button>,
      );
    }
  }

  return (
    <div
      ref={(node) => {
        hostRef.current = node;
        setHost(node);
      }}
      className="deck-grid"
      data-testid="deck-grid"
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="deck-grid-spacer" style={{ height: rows * rowHeight + GAP }}>
        {cells}
      </div>
    </div>
  );
}
