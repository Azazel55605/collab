import { shapePath } from '../../lib/deck/geometry';
import type { DeckShapeGeometry } from '../../types/deck';

/** A small outline of a shape geometry, drawn from the same path the slide uses. */
export function DeckShapeIcon({
  geometry,
  size = 14,
}: {
  geometry: DeckShapeGeometry;
  size?: number;
}) {
  const box = 20;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`-2 -2 ${box + 4} ${box + 4}`}
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d={shapePath(geometry, box, box)}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}
