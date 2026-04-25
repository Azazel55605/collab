import { useCallback } from 'react';

import type { CanvasNode, FileCanvasNode, NoteCanvasNode, TextCanvasNode, WebCanvasNode } from '../../types/canvas';
import type { NoteFile } from '../../types/vault';
import type { CanvasPickerMode } from './CanvasPickerDialog';

const DEFAULT_NODE_SIZE = { width: 300, height: 180 };
const DEFAULT_TEXT_NODE_SIZE = { width: 280, height: 160 };

interface ReactFlowPositionApi {
  screenToFlowPosition: (position: { x: number; y: number }) => { x: number; y: number };
}

interface UseCanvasNodeCommandsOptions {
  reactFlow: ReactFlowPositionApi;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  pickerMode: CanvasPickerMode;
  setPickerMode: (mode: CanvasPickerMode) => void;
  allFiles: NoteFile[];
  addCanvasNode: (node: CanvasNode) => void;
}

export function useCanvasNodeCommands({
  reactFlow,
  viewportRef,
  pickerMode,
  setPickerMode,
  allFiles,
  addCanvasNode,
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

  const handlePickerSelect = useCallback((file: NoteFile) => {
    const center = getViewportCenterPosition();
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
      addCanvasNode(node);
    } else {
      const node: FileCanvasNode = {
        id,
        type: 'file',
        relativePath: file.relativePath,
        position: center,
        width: DEFAULT_NODE_SIZE.width,
        height: DEFAULT_NODE_SIZE.height,
      };
      addCanvasNode(node);
    }
    setPickerMode(null);
  }, [addCanvasNode, getViewportCenterPosition, pickerMode, setPickerMode]);

  const addTextNode = useCallback(() => {
    const center = getViewportCenterPosition();
    const node: TextCanvasNode = {
      id: crypto.randomUUID(),
      type: 'text',
      content: '',
      position: center,
      width: DEFAULT_TEXT_NODE_SIZE.width,
      height: DEFAULT_TEXT_NODE_SIZE.height,
    };
    addCanvasNode(node);
  }, [addCanvasNode, getViewportCenterPosition]);

  const addWebNode = useCallback(() => {
    const center = getViewportCenterPosition();
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
  }, [addCanvasNode, getViewportCenterPosition]);

  const handleDropOnCanvas = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const relativePath = event.dataTransfer.getData('text/plain');
    if (!relativePath) return;

    const file = allFiles.find((entry) => entry.relativePath === relativePath);
    if (!file) return;

    const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const node: CanvasNode = file.extension.toLowerCase() === 'md'
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
  }, [addCanvasNode, allFiles, reactFlow]);

  return {
    addTextNode,
    addWebNode,
    handleDropOnCanvas,
    handlePickerSelect,
  };
}
