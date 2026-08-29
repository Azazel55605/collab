import { ChevronDown, ExternalLink, Paperclip, Tag, X } from 'lucide-react';

import { cn } from '../../lib/utils';
import type { KanbanCard } from '../../types/kanban';
import type { NoteFile } from '../../types/vault';
import { FULL_KANBAN_CAPABILITIES, type KanbanCapabilities } from '../../views/KanbanPage';
import { Button } from '../ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Input } from '../ui/input';
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
  caps?: KanbanCapabilities;
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
  caps = FULL_KANBAN_CAPABILITIES,
}: Props) {
  const secondaryFieldClass =
    'border-border/40 bg-background/55 text-foreground placeholder:text-muted-foreground/50';

  return (
    <>
      <section>
        <label className="section-label flex items-center gap-1">
          <Tag size={11} /> Tags
        </label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {draft.tags.map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 rounded-full border border-primary/25 bg-primary/12 px-2 py-0.5 text-xs text-primary/85"
            >
              {tag}
              {caps.editContent && (
                <button
                  onClick={() => removeTag(tag)}
                  className="ml-0.5 rounded-full text-primary/70 transition-colors hover:text-primary"
                  aria-label={`Remove tag ${tag}`}
                  title={`Remove tag ${tag}`}
                >
                  <X size={9} />
                </button>
              )}
            </span>
          ))}
        </div>
        {caps.editContent && (
          <div className="relative flex gap-2">
            <div className="flex-1 relative">
              <Input
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
                className={cn('h-8 text-xs', secondaryFieldClass)}
              />
              {showTagSuggestions && (
                <div className="absolute top-full left-0 right-0 z-50 mt-1 max-h-40 overflow-y-auto overflow-hidden rounded-xl border border-border/60 bg-popover/96 shadow-xl shadow-black/10">
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
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addTag}
              className="shrink-0 text-xs"
            >
              Add
            </Button>
          </div>
        )}
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
              <div
                key={path}
                className="flex items-center gap-2 rounded-xl border border-border/40 bg-card/35 px-2.5 py-1.5"
              >
                <Paperclip size={11} className="shrink-0 text-primary/70" />
                <span className="flex-1 truncate font-mono text-xs text-foreground" title={path}>
                  {path}
                </span>
                <span className="shrink-0 rounded-full bg-primary/12 px-1.5 py-0.5 text-[10px] text-primary/80">
                  Attached
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => openAttachment(path)}
                  className="h-7 gap-1 px-2 text-xs text-primary hover:text-primary shrink-0"
                  title="Open file"
                >
                  <ExternalLink size={11} />
                </Button>
                {caps.editContent && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeAttachment(path)}
                    className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground shrink-0"
                    title="Remove attachment"
                  >
                    <X size={11} />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {caps.editContent && (
          <div className="flex gap-2">
            <Popover open={notePickerOpen} onOpenChange={setNotePickerOpen}>
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    'flex h-8 w-full items-center justify-between gap-2 rounded-lg border px-2.5 text-left text-xs transition-colors',
                    secondaryFieldClass,
                    'hover:border-border/70',
                  )}
                >
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
                          <span className="font-medium truncate">
                            {file.name.replace(/\.[^.]+$/, '')}
                          </span>
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
        )}
      </section>
    </>
  );
}
