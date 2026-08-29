import type { Node as FlowNode } from '@xyflow/react';

import type { CanvasWebCardDefaultMode } from '../../store/uiStore';
import type { CanvasNode, PlanningCanvasNode } from '../../types/canvas';

import type { CanvasNodeData } from './CanvasNodeTypes';
import { getPlanningNodeLabel, isPlanningNode } from './canvasPlanning';
import {
  buildNodePreviewState,
  buildWebPreviewState,
  type PreviewState,
} from './CanvasPreviewUtils';

const DEFAULT_NODE_SIZE = { width: 300, height: 180 };

type FlowNodeCallbacks = Pick<
  CanvasNodeData,
  | 'onOpen'
  | 'onTextChange'
  | 'onSnapToGrid'
  | 'onWebUrlChange'
  | 'onWebDisplayModeOverrideChange'
  | 'onRequestWebPreview'
  | 'onOpenUrl'
>;

export function toFlowNode(
  node: CanvasNode,
  preview: PreviewState | undefined,
  callbacks: FlowNodeCallbacks,
  defaultWebCardMode: CanvasWebCardDefaultMode,
  autoLoadEnabled: boolean,
  webPreviewsEnabled: boolean,
): FlowNode<CanvasNodeData> {
  if (isPlanningNode(node)) {
    return {
      id: node.id,
      type: `${node.type}Card`,
      position: node.position,
      selected: false,
      data: {
        nodeKind: node.type,
        title: node.title,
        subtitle: getPlanningNodeLabel(node.type),
        content: node.body,
        linkedRelativePath: node.linkedRelativePath,
        planning: node.planning,
        orientation: node.type === 'swimlane' ? (node.orientation ?? 'horizontal') : undefined,
        onSnapToGrid: callbacks.onSnapToGrid,
      },
      style: {
        width: node.width,
        height: node.height,
      },
    };
  }

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
        ...buildWebPreviewState(
          node,
          preview,
          defaultWebCardMode,
          autoLoadEnabled,
          webPreviewsEnabled,
        ),
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

  if (node.type === 'symbol') {
    return {
      id: node.id,
      type: 'symbolCard',
      position: node.position,
      selected: false,
      data: {
        title: node.title ?? '',
        subtitle: node.iconLabel ?? 'Canvas symbol',
        symbolGlyph: node.glyph,
        symbolId: node.iconId,
        symbolLabel: node.iconLabel,
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
  const width =
    typeof node.width === 'number'
      ? node.width
      : typeof node.measured?.width === 'number'
        ? node.measured.width
        : typeof node.style?.width === 'number'
          ? node.style.width
          : DEFAULT_NODE_SIZE.width;
  const height =
    typeof node.height === 'number'
      ? node.height
      : typeof node.measured?.height === 'number'
        ? node.measured.height
        : typeof node.style?.height === 'number'
          ? node.style.height
          : DEFAULT_NODE_SIZE.height;

  const nodeType = node.type ?? 'fileCard';
  const planningType = nodeType.endsWith('Card') ? nodeType.slice(0, -4) : nodeType;

  if (
    planningType !== 'note' &&
    planningType !== 'file' &&
    planningType !== 'text' &&
    planningType !== 'web' &&
    planningType !== 'symbol'
  ) {
    return {
      id: node.id,
      type: planningType as PlanningCanvasNode['type'],
      position: node.position,
      width,
      height,
      title: node.data.title ?? getPlanningNodeLabel(planningType as PlanningCanvasNode['type']),
      body: node.data.content ?? '',
      linkedRelativePath: node.data.linkedRelativePath || undefined,
      planning: node.data.planning,
      ...(planningType === 'swimlane'
        ? { orientation: node.data.orientation ?? 'horizontal' }
        : {}),
    } as PlanningCanvasNode;
  }

  if (nodeType === 'textCard') {
    return {
      id: node.id,
      type: 'text',
      position: node.position,
      width,
      height,
      content: node.data.content ?? '',
    };
  }

  if (nodeType === 'webCard') {
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

  if (nodeType === 'symbolCard') {
    return {
      id: node.id,
      type: 'symbol',
      position: node.position,
      width,
      height,
      glyph: node.data.symbolGlyph ?? '',
      iconId: node.data.symbolId || undefined,
      iconLabel: node.data.symbolLabel || undefined,
      title: node.data.title || undefined,
    };
  }

  if (nodeType === 'noteCard') {
    return {
      id: node.id,
      type: 'note',
      position: node.position,
      width,
      height,
      relativePath: node.data.relativePath ?? '',
      description: node.data.content || undefined,
    };
  }

  return {
    id: node.id,
    type: 'file',
    position: node.position,
    width,
    height,
    relativePath: node.data.relativePath ?? '',
    description: node.data.content || undefined,
  };
}
