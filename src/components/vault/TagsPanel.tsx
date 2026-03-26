import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';

export default function TagsPanel() {
  const { notes } = useNoteIndexStore();
  const { openTab } = useEditorStore();
  const { setActiveView } = useUiStore();

  const tagMap = new Map<string, string[]>();
  for (const note of notes) {
    for (const tag of note.tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(note.relativePath);
    }
  }
  const tags = [...tagMap.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <div className="flex flex-col h-full overflow-y-auto p-2 gap-1">
      {tags.length === 0 && (
        <p className="text-xs text-muted-foreground px-2 py-4 text-center">No tags found</p>
      )}
      {tags.map(([tag, paths]) => (
        <div key={tag} className="group">
          <div className="flex items-center justify-between px-2 py-1 rounded hover:bg-accent/50 text-sm">
            <span className="font-medium">#{tag}</span>
            <span className="text-xs text-muted-foreground">{paths.length}</span>
          </div>
          <div className="ml-4 space-y-0.5">
            {paths.map((p) => {
              const note = notes.find((n) => n.relativePath === p);
              return (
                <button
                  key={p}
                  onClick={() => {
                    openTab(p, note?.title ?? p, 'note');
                    setActiveView('editor');
                  }}
                  className="w-full text-left px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground rounded hover:bg-accent/30 truncate"
                >
                  {note?.title ?? p}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
