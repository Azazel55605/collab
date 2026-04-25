import type { Node as FlowNode } from '@xyflow/react';

import type { CanvasWebCardDefaultMode } from '../../store/uiStore';
import type { CanvasNode } from '../../types/canvas';
import type { CanvasNodeData } from './CanvasNodeTypes';
import {
  buildNodePreviewState,
  buildWebPreviewState,
  type PreviewState,
} from './CanvasPreviewUtils';

const DEFAULT_NODE_SIZE = { width: 300, height: 180 };

type FlowNodeCallbacks = Pick<
  CanvasNodeData,
  'onOpen' | 'onTextChange' | 'onSnapToGrid' | 'onWebUrlChange' | 'onWebDisplayModeOverrideChange' | 'onRequestWebPreview' | 'onOpenUrl'
>;

export function toFlowNode(
  node: CanvasNode,
  preview: PreviewState | undefined,
  callbacks: FlowNodeCallbacks,
  defaultWebCardMode: CanvasWebCardDefaultMode,
  autoLoadEnabled: boolean,
  webPreviewsEnabled: boolean,
): FlowNode<CanvasNodeData> {
  if (node.type === 'text') {
    return {
      id: node.id,
      type: 'textCard',
      position: node.position,
      selected: false,
      data: {
        title: 'Text',
        subtitle: 'Canvas note',
        content: node.content,
        onTextChange: callbacks.onTextChange,
        onSnapToGrid: callbacks.onSnapToGrid,
      },
      style: {
        width: node.width,
        height: node.height,
      },
    };
  }

  if (node.type === 'web') {
    return {
      id: node.id,
      type: 'webCard',
      position: node.position,
      selected: false,
      data: {
        ...buildWebPreviewState(node, preview, defaultWebCardMode, autoLoadEnabled, webPreviewsEnabled),
        onWebUrlChange: callbacks.onWebUrlChange,
        onWebDisplayModeOverrideChange: callbacks.onWebDisplayModeOverrideChange,
        onRequestWebPreview: callbacks.onRequestWebPreview,
        onOpenUrl: callbacks.onOpenUrl,
        onSnapToGrid: callbacks.onSnapToGrid,
      },
      style: {
        width: node.width,
        height: node.height,
      },
    };
  }

  const isNote = node.type === 'note';
  const cardPreview = buildNodePreviewState(node, preview);
  return {
    id: node.id,
    type: isNote ? 'noteCard' : 'fileCard',
    position: node.position,
    selected: false,
    data: {
      ...cardPreview,
      onOpen: callbacks.onOpen,
      onWikilinkClick: callbacks.onOpen,
      onSnapToGrid: callbacks.onSnapToGrid,
    },
    style: {
      width: node.width,
      height: node.height,
    },
  };
}

export function fromFlowNode(node: FlowNode<CanvasNodeData>): CanvasNode {
  const width = typeof node.width === 'number'
    ? node.width
    : typeof node.measured?.width === 'number'
      ? node.measured.width
      : typeof node.style?.width === 'number'
        ? node.style.width
        : DEFAULT_NODE_SIZE.width;
  const height = typeof node.height === 'number'
    ? node.height
    : typeof node.measured?.height === 'number'
      ? node.measured.height
      : typeof node.style?.height === 'number'
        ? node.style.height
        : DEFAULT_NODE_SIZE.height;

  if (node.type === 'textCard') {
    return {
      id: node.id,
      type: 'text',
      position: node.position,
      width,
      height,
      content: node.data.content ?? '',
    };
  }

  if (node.type === 'webCard') {
    return {
      id: node.id,
      type: 'web',
      position: node.position,
      width,
      height,
      url: node.data.url ?? '',
      displayModeOverride: node.data.displayModeOverride ?? null,
    };
  }

  if (node.type === 'noteCard') {
    return {
      id: node.id,
      type: 'note',
      position: node.position,
      width,
      height,
      relativePath: node.data.relativePath ?? '',
    };
  }

  return {
    id: node.id,
    type: 'file',
    position: node.position,
    width,
    height,
    relativePath: node.data.relativePath ?? '',
  };
}
