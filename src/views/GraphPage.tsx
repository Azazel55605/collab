import { memo, useCallback } from 'react';

import GraphView from '../components/graph/GraphView';
import { useEditorStore } from '../store/editorStore';
import { useNoteIndexStore } from '../store/noteIndexStore';
import { useUiStore } from '../store/uiStore';

interface Props {
  /** Override node-click behaviour — grid cells use this to load the note into the same cell */
  onNodeClick?: (relativePath: string, title: string) => void;
}

function GraphPage({ onNodeClick }: Props = {}) {
  const notes = useNoteIndexStore((state) => state.notes);
  const openTab = useEditorStore((state) => state.openTab);
  const setActiveView = useUiStore((state) => state.setActiveView);

  const defaultNodeClick = useCallback(
    (relativePath: string, title: string) => {
      openTab(relativePath, title, 'note');
      setActiveView('editor');
    },
    [openTab, setActiveView],
  );

  const handleNodeClick = onNodeClick ?? defaultNodeClick;

  return (
    <div className="w-full h-full app-fade-slide-in">
      <GraphView notes={notes} onNodeClick={handleNodeClick} />
    </div>
  );
}

export default memo(GraphPage);
