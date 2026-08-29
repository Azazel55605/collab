import { useCallback } from 'react';

import type {
  CanvasEdge,
  CanvasNode,
  CanvasSymbolDefinition,
  FileCanvasNode,
  NoteCanvasNode,
  PlanningCanvasNode,
  SymbolCanvasNode,
  TextCanvasNode,
  WebCanvasNode,
} from '../../types/canvas';
import type { NoteFile } from '../../types/vault';

import type { CanvasPickerMode } from './CanvasPickerDialog';
import {
  buildPlanningPreset,
  type CanvasPlanningPreset,
  getPlanningNodeDefaults,
} from './canvasPlanning';

const DEFAULT_NODE_SIZE = { width: 300, height: 180 };
const DEFAULT_TEXT_NODE_SIZE = { width: 280, height: 160 };
const DEFAULT_SYMBOL_NODE_SIZE = { width: 180, height: 180 };

interface ReactFlowPositionApi {
  screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
}

export interface PendingAutoConnect {
  source: string;
  sourceHandle?: string;
  sourceSide?: string | null;
  handleType?: 'source' | 'target';
}

interface UseCanvasNodeCommandsOptions {
  reactFlow: ReactFlowPositionApi;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  pickerMode: CanvasPickerMode;
  setPickerMode: (mode: CanvasPickerMode) => void;
  pickerInsertPosition?: { x: number; y: number } | null;
  allFiles: NoteFile[];
  addCanvasNode: (node: CanvasNode, pendingAutoConnect?: PendingAutoConnect | null) => void;
  addCanvasNodes?: (nodes: CanvasNode[]) => void;
  addCanvasEdges?: (edges: CanvasEdge[]) => void;
}

export function useCanvasNodeCommands({
  reactFlow,
  viewportRef,
  pickerMode,
  setPickerMode,
  pickerInsertPosition,
  allFiles,
  addCanvasNode,
  addCanvasNodes,
  addCanvasEdges,
}: UseCanvasNodeCommandsOptions) {
  const getViewportCenterPosition = useCallback(() => {
    const viewportEl = viewportRef.current;
    if (!viewportEl) return { x: 0, y: 0 };
    const rect = viewportEl.getBoundingClientRect();
    return reactFlow.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  }, [reactFlow, viewportRef]);

  const handlePickerSelect = useCallback(
    (file: NoteFile, pendingAutoConnect?: PendingAutoConnect | null) => {
      const center = pickerInsertPosition ?? getViewportCenterPosition();
      const id = crypto.randomUUID();
      if (pickerMode === 'note') {
        const node: NoteCanvasNode = {
          id,
          type: 'note',
          relativePath: file.relativePath,
          position: center,
          width: DEFAULT_NODE_SIZE.width,
          height: DEFAULT_NODE_SIZE.height,
        };
        addCanvasNode(node, pendingAutoConnect);
      } else {
        const node: FileCanvasNode = {
          id,
          type: 'file',
          relativePath: file.relativePath,
          position: center,
          width: DEFAULT_NODE_SIZE.width,
          height: DEFAULT_NODE_SIZE.height,
        };
        addCanvasNode(node, pendingAutoConnect);
      }
      setPickerMode(null);
    },
    [addCanvasNode, getViewportCenterPosition, pickerInsertPosition, pickerMode, setPickerMode],
  );

  const addTextNodeAt = useCallback(
    (position?: { x: number; y: number }) => {
      const center = position ?? getViewportCenterPosition();
      const node: TextCanvasNode = {
        id: crypto.randomUUID(),
        type: 'text',
        content: '',
        position: center,
        width: DEFAULT_TEXT_NODE_SIZE.width,
        height: DEFAULT_TEXT_NODE_SIZE.height,
      };
      addCanvasNode(node);
    },
    [addCanvasNode, getViewportCenterPosition],
  );

  const addTextNode = useCallback(() => {
    addTextNodeAt();
  }, [addTextNodeAt]);

  const addWebNodeAt = useCallback(
    (position?: { x: number; y: number }) => {
      const center = position ?? getViewportCenterPosition();
      const node: WebCanvasNode = {
        id: crypto.randomUUID(),
        type: 'web',
        url: '',
        displayModeOverride: null,
        position: center,
        width: 360,
        height: 240,
      };
      addCanvasNode(node);
    },
    [addCanvasNode, getViewportCenterPosition],
  );

  const addWebNode = useCallback(() => {
    addWebNodeAt();
  }, [addWebNodeAt]);

  const addSymbolNodeAt = useCallback(
    (
      symbol: CanvasSymbolDefinition,
      position?: { x: number; y: number },
      pendingAutoConnect?: PendingAutoConnect | null,
    ) => {
      const center = position ?? getViewportCenterPosition();
      const node: SymbolCanvasNode = {
        id: crypto.randomUUID(),
        type: 'symbol',
        glyph: symbol.glyph,
        iconId: symbol.iconId,
        iconLabel: symbol.iconLabel,
        title: symbol.iconLabel,
        position: center,
        width: DEFAULT_SYMBOL_NODE_SIZE.width,
        height: DEFAULT_SYMBOL_NODE_SIZE.height,
      };
      addCanvasNode(node, pendingAutoConnect);
    },
    [addCanvasNode, getViewportCenterPosition],
  );

  const addSymbolNode = useCallback(
    (symbol: CanvasSymbolDefinition) => {
      addSymbolNodeAt(symbol);
    },
    [addSymbolNodeAt],
  );

  const addPlanningNodeAt = useCallback(
    (type: PlanningCanvasNode['type'], position?: { x: number; y: number }) => {
      const center = position ?? getViewportCenterPosition();
      const defaults = getPlanningNodeDefaults(type);
      const node: PlanningCanvasNode = {
        id: crypto.randomUUID(),
        type,
        title: defaults.title,
        body: defaults.body,
        planning: defaults.planning,
        ...(defaults.orientation ? { orientation: defaults.orientation } : {}),
        position: center,
        width: defaults.width,
        height: defaults.height,
      } as PlanningCanvasNode;
      addCanvasNode(node);
    },
    [addCanvasNode, getViewportCenterPosition],
  );

  const addPlanningNode = useCallback(
    (type: PlanningCanvasNode['type']) => {
      addPlanningNodeAt(type);
    },
    [addPlanningNodeAt],
  );

  const applyPlanningPreset = useCallback(
    (preset: CanvasPlanningPreset) => {
      const center = getViewportCenterPosition();
      const { nodes, edges } = buildPlanningPreset(preset, center);
      if (addCanvasNodes) addCanvasNodes(nodes);
      else nodes.forEach((node) => addCanvasNode(node));
      addCanvasEdges?.(edges);
    },
    [addCanvasEdges, addCanvasNode, addCanvasNodes, getViewportCenterPosition],
  );

  const handleDropOnCanvas = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const relativePath = event.dataTransfer.getData('text/plain');
      if (!relativePath) return;

      const file = allFiles.find((entry) => entry.relativePath === relativePath);
      if (!file) return;

      const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const node: CanvasNode =
        file.extension.toLowerCase() === 'md'
          ? {
              id: crypto.randomUUID(),
              type: 'note',
              relativePath: file.relativePath,
              position,
              width: DEFAULT_NODE_SIZE.width,
              height: DEFAULT_NODE_SIZE.height,
            }
          : {
              id: crypto.randomUUID(),
              type: 'file',
              relativePath: file.relativePath,
              position,
              width: DEFAULT_NODE_SIZE.width,
              height: DEFAULT_NODE_SIZE.height,
            };

      addCanvasNode(node);
    },
    [addCanvasNode, allFiles, reactFlow],
  );

  return {
    addTextNode,
    addTextNodeAt,
    addWebNode,
    addWebNodeAt,
    addSymbolNode,
    addSymbolNodeAt,
    addPlanningNode,
    addPlanningNodeAt,
    applyPlanningPreset,
    handleDropOnCanvas,
    handlePickerSelect,
  };
}
