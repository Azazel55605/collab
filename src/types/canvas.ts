export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: { x: number; y: number; zoom: number };
}

export type CanvasNodeType = 'note' | 'text' | 'group';

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

export interface TextCanvasNode extends CanvasNodeBase {
  type: 'text';
  content: string;
}

export interface GroupCanvasNode extends CanvasNodeBase {
  type: 'group';
  label: string;
  color?: string;
}

export type CanvasNode = NoteCanvasNode | TextCanvasNode | GroupCanvasNode;

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  animated?: boolean;
}
