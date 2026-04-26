import { ChevronDown, ExternalLink, Paperclip, Tag, X } from 'lucide-react';

import { cn } from '../../lib/utils';
import type { KanbanCard } from '../../types/kanban';
import type { NoteFile } from '../../types/vault';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

type Props = {
  draft: KanbanCard;
  tagInput: string;
  suggestedTags: string[];
  showTagSuggestions: boolean;
  attachmentPaths: string[];
  vaultFiles: NoteFile[];
  notePickerOpen: boolean;
  setTagInput: (value: string) => void;
  setTagInputFocused: (focused: boolean) => void;
  setNotePickerOpen: (open: boolean) => void;
  addTag: () => void;
  removeTag: (tag: string) => void;
  patchDraft: (changes: Partial<KanbanCard>) => void;
  addAttachment: (path: string) => void;
  removeAttachment: (path: string) => void;
  openAttachment: (path: string) => void;
};

export function CardDialogTagsAttachments({
  draft,
  tagInput,
  suggestedTags,
  showTagSuggestions,
  attachmentPaths,
  vaultFiles,
  notePickerOpen,
  setTagInput,
  setTagInputFocused,
  setNotePickerOpen,
  addTag,
  removeTag,
  patchDraft,
  addAttachment,
  removeAttachment,
  openAttachment,
}: Props) {
  return (
    <>
      <section>
        <label className="section-label flex items-center gap-1"><Tag size={11} /> Tags</label>
        <div className="flex flex-wrap gap-1.5 mb-2">
            {draft.tags.map((tag) => (
              <span key={tag} className="flex items-center gap-1 text-xs px-2 py-0.5 bg-primary/15 text-primary/80 rounded-full">
                {tag}
                <button
                  onClick={() => removeTag(tag)}
                  className="hover:text-primary ml-0.5"
                  aria-label={`Remove tag ${tag}`}
                  title={`Remove tag ${tag}`}
                >
                  <X size={9} />
                </button>
              </span>
            ))}
        </div>
        <div className="relative flex gap-2">
          <div className="flex-1 relative">
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onFocus={() => setTagInputFocused(true)}
              onBlur={() => setTimeout(() => setTagInputFocused(false), 150)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addTag();
                }
                if (e.key === 'Escape') setTagInputFocused(false);
              }}
              placeholder="Type tag, press Enter"
              className="w-full bg-muted/25 border border-border/30 rounded text-xs text-foreground px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/40"
            />
            {showTagSuggestions && (
              <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-popover border border-border/50 rounded-md shadow-lg overflow-hidden max-h-40 overflow-y-auto">
                {suggestedTags.map((tag) => (
                  <button
                    key={tag}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      patchDraft({ tags: [...draft.tags, tag] });
                      setTagInput('');
                      setTagInputFocused(false);
                    }}
                    className="w-full text-left text-xs px-2.5 py-1.5 hover:bg-accent/60 transition-colors text-foreground/80"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={addTag} className="text-xs px-3 py-1.5 bg-primary/15 hover:bg-primary/25 text-primary rounded transition-colors shrink-0">
            Add
          </button>
        </div>
      </section>

      <section>
        <label className="section-label flex items-center gap-1">
          <Paperclip size={11} />
          Attachments
          {attachmentPaths.length > 0 && (
            <span className="ml-auto font-normal normal-case tracking-normal text-[11px] text-muted-foreground">
              {attachmentPaths.length}
            </span>
          )}
        </label>

        {attachmentPaths.length > 0 && (
          <div className="flex flex-col gap-1.5 mb-2">
            {attachmentPaths.map((path) => (
              <div key={path} className="flex items-center gap-2 rounded border border-border/30 bg-muted/20 px-2.5 py-1.5">
                <Paperclip size={11} className="shrink-0 text-primary/70" />
                <span className="flex-1 truncate font-mono text-xs text-foreground" title={path}>{path}</span>
                <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-0.5 text-[10px] text-primary/80">
                  Attached
                </span>
                <button
                  onClick={() => openAttachment(path)}
                  className="flex items-center gap-1 text-xs px-2 py-1 bg-primary/15 hover:bg-primary/25 text-primary rounded transition-colors shrink-0"
                  title="Open file"
                >
                  <ExternalLink size={11} />
                </button>
                <button
                  onClick={() => removeAttachment(path)}
                  className="flex items-center gap-1 text-xs px-2 py-1 text-muted-foreground hover:text-foreground rounded transition-colors shrink-0"
                  title="Remove attachment"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <Popover open={notePickerOpen} onOpenChange={setNotePickerOpen}>
            <PopoverTrigger asChild>
              <button className={cn(
                'flex-1 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded border text-xs text-left transition-colors',
                'bg-muted/25 border-border/30 hover:border-border/60 focus:outline-none focus:ring-1 focus:ring-primary/40',
                'text-muted-foreground/60',
              )}>
                <span className="truncate">Add file…</span>
                <ChevronDown size={11} className="shrink-0 text-muted-foreground/50" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 p-0">
              <Command>
                <CommandInput placeholder="Search vault files…" />
                <CommandList>
                  <CommandEmpty>No files found.</CommandEmpty>
                  <CommandGroup>
                    {vaultFiles.map((file) => (
                      <CommandItem
                        key={file.relativePath}
                        value={`${file.relativePath} ${file.name}`}
                        onSelect={() => addAttachment(file.relativePath)}
                      >
                        <span className="font-medium truncate">{file.name.replace(/\.[^.]+$/, '')}</span>
                        {attachmentPaths.includes(file.relativePath) && (
                          <span className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[10px] text-primary/80 shrink-0">
                            Attached
                          </span>
                        )}
                        <span className="ml-auto text-[10px] text-muted-foreground/60 font-mono truncate max-w-[120px]">
                          {file.relativePath}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
      </section>
    </>
  );
}
