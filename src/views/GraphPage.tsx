import { useNoteIndexStore } from '../store/noteIndexStore';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import GraphView from '../components/graph/GraphView';

export default function GraphPage() {
  const { notes } = useNoteIndexStore();
  const { openTab } = useEditorStore();
  const { setActiveView } = useUiStore();

  const handleNodeClick = (relativePath: string, title: string) => {
    openTab(relativePath, title, 'note');
    setActiveView('editor');
  };

  return (
    <div className="w-full h-full">
      <GraphView notes={notes} onNodeClick={handleNodeClick} />
    </div>
  );
}
