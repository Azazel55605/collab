export type ImageOverlayTool = 'select' | 'text' | 'arrow' | 'pen';
export type ImageLineStyle = 'solid' | 'dashed' | 'dotted';

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface ImageTextOverlay {
  id: string;
  type: 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
  fontSize: number;
}

export interface ImageArrowOverlay {
  id: string;
  type: 'arrow';
  start: NormalizedPoint;
  end: NormalizedPoint;
  color: string;
  strokeWidth: number;
  lineStyle: ImageLineStyle;
}

export interface ImagePenOverlay {
  id: string;
  type: 'pen';
  points: NormalizedPoint[];
  color: string;
  strokeWidth: number;
}

export type ImageOverlayItem = ImageTextOverlay | ImageArrowOverlay | ImagePenOverlay;

export interface ImageOverlayDocument {
  version: 1;
  baseWidth: number;
  baseHeight: number;
  items: ImageOverlayItem[];
  updatedAt: number;
}

export interface ImageCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PermanentImageEdits {
  rotation: 0 | 90 | 180 | 270;
  crop: ImageCropRect | null;
  resizeWidth: number | null;
  resizeHeight: number | null;
  lockAspectRatio: boolean;
}
