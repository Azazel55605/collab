import { useState, useEffect } from 'react';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '../ui/command';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const { notes } = useNoteIndexStore();
  const { openTab } = useEditorStore();
  const { setActiveView } = useUiStore();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleSelect = (relativePath: string, title: string) => {
    openTab(relativePath, title, 'note');
    setActiveView('editor');
    setOpen(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search notes… (⌘P)" className="text-sm" />
      <CommandList>
        <CommandEmpty className="py-6 text-sm text-center text-muted-foreground">No results found.</CommandEmpty>
        <CommandGroup heading="Notes">
          {notes.map((note) => (
            <CommandItem
              key={note.relativePath}
              onSelect={() => handleSelect(note.relativePath, note.title)}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate">{note.title}</span>
              <span className="text-[11px] text-muted-foreground/60 font-mono shrink-0 truncate max-w-[200px]">
                {note.relativePath}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
