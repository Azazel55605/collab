import { useNoteIndexStore } from '../store/noteIndexStore';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import GraphView from '../components/graph/GraphView';

interface Props {
  /** Override node-click behaviour — grid cells use this to load the note into the same cell */
  onNodeClick?: (relativePath: string, title: string) => void;
}

export default function GraphPage({ onNodeClick }: Props = {}) {
  const { notes } = useNoteIndexStore();
  const { openTab } = useEditorStore();
  const { setActiveView } = useUiStore();

  const handleNodeClick = onNodeClick ?? ((relativePath: string, title: string) => {
    openTab(relativePath, title, 'note');
    setActiveView('editor');
  });

  return (
    <div className="w-full h-full">
      <GraphView notes={notes} onNodeClick={handleNodeClick} />
    </div>
  );
}
