/**
 * Vector-editing scene model for `.svg` files.
 *
 * The editor reuses the image viewer shell but works on an SVG's own vector
 * content instead of a raster pixel buffer. The document is parsed into an
 * ordered list of {@link SvgSlot}s: recognized top-level primitives become
 * editable {@link SvgNode}s, while everything else (`<defs>`, gradients,
 * filters, `<style>`, groups, `<use>`, and unknown elements) is preserved
 * verbatim as a {@link SvgRawSlot} and written back untouched on save
 * ("preserve & passthrough"). All geometry is expressed in the SVG's own user
 * units, derived from its `viewBox`, so edits round-trip losslessly.
 */

/** Primitive types the editor can both create and fully edit (move/resize/style). */
export type SvgPrimitiveType = 'rect' | 'ellipse' | 'circle' | 'line' | 'text';

/**
 * All element types parsed into an editable node. Path/polyline/polygon are
 * editable for styling, move, delete, and reorder, but are not resizable and
 * cannot be created from the toolbar in the current stages.
 */
export type SvgEditableType = SvgPrimitiveType | 'polyline' | 'polygon' | 'path';

export interface SvgStyle {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number | null;
  /** Element opacity in the 0..1 range, or null when unset. */
  opacity: number | null;
}

/** Rectangle in SVG user units — also used as a selection/hit-test box. */
export interface SvgRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SvgNode {
  /** Stable id, mirrored onto the element as `data-cid` while editing. */
  id: string;
  type: SvgEditableType;

  // rect (also the modeled box for `text` selection is measured, not stored)
  x?: number;
  y?: number;
  width?: number;
  height?: number;

  // ellipse / circle
  cx?: number;
  cy?: number;
  rx?: number;
  ry?: number;
  r?: number;

  // line
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;

  // text
  text?: string;
  fontSize?: number;

  // path / polyline / polygon (opaque geometry; move applied via transform)
  d?: string;
  points?: string;

  /** Preserved (or editor-applied) transform attribute value. */
  transform?: string;
  style: SvgStyle;
  /** Any attributes not otherwise modeled, preserved on serialize. */
  extraAttrs: Record<string, string>;
}

export type SvgSlot = { kind: 'node'; node: SvgNode } | { kind: 'raw'; markup: string };

export interface SvgScene {
  viewBox: SvgRect;
  /** Optional explicit pixel width/height attributes on the root `<svg>`. */
  width: number | null;
  height: number | null;
  /** Preserved root `<svg>` attributes (namespaces, class, style, …). */
  rootAttrs: Record<string, string>;
  slots: SvgSlot[];
}
