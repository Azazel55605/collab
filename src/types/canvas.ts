export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: { x: number; y: number; zoom: number };
}

export type CanvasNodeType = 'note' | 'file' | 'text';

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

export type CanvasNode = NoteCanvasNode | FileCanvasNode | TextCanvasNode;

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
