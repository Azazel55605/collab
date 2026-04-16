export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: { x: number; y: number; zoom: number };
}

export type CanvasNodeType = 'note' | 'file' | 'text' | 'web';
export type CanvasWebDisplayMode = 'preview' | 'embed';

export interface CanvasNodeBase {
  id: string;
  type: CanvasNodeType;
  position: { x: number; y: number };
  width: number;
  height: number;
}

export interface NoteCanvasNode extends CanvasNodeBase {
  type: 'note';
  relativePath: string;
}

export interface FileCanvasNode extends CanvasNodeBase {
  type: 'file';
  relativePath: string;
}

export interface TextCanvasNode extends CanvasNodeBase {
  type: 'text';
  content: string;
}

export interface WebCanvasNode extends CanvasNodeBase {
  type: 'web';
  url: string;
  displayModeOverride?: CanvasWebDisplayMode | null;
}

export type CanvasNode = NoteCanvasNode | FileCanvasNode | TextCanvasNode | WebCanvasNode;

export type CanvasEdgeLineStyle = 'solid' | 'dashed' | 'dotted';

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  lineStyle?: CanvasEdgeLineStyle;
  animated?: boolean;
  animationReverse?: boolean;
  markerStart?: boolean;
  markerEnd?: boolean;
}
