import { useMemo, useRef, useState } from 'react';

import { FileUp } from 'lucide-react';

import { flattenVaultPaths } from '../../lib/deck/vaultAssets';
import type { NoteFile } from '../../types/vault';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';

interface DeckVaultPickerProps {
  open: boolean;
  title: string;
  description: string;
  fileTree: NoteFile[];
  /** Which vault files may be picked. */
  accept: (path: string) => boolean;
  /** Offers "From this computer…" with this `accept` attribute (images). */
  uploadAccept?: string;
  onOpenChange: (open: boolean) => void;
  onPick: (path: string) => void;
  onUpload?: (file: File) => void;
}

const MAX_SHOWN = 200;

/** Picks a file from the vault, filtered by type and by a search. */
export function DeckVaultPicker({
  open,
  title,
  description,
  fileTree,
  accept,
  uploadAccept,
  onOpenChange,
  onPick,
  onUpload,
}: DeckVaultPickerProps) {
  const [query, setQuery] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);
  const paths = useMemo(
    () =>
      flattenVaultPaths(fileTree)
        .filter((path) => accept(path) && !path.split('/').some((part) => part.startsWith('.')))
        .sort((a, b) => a.localeCompare(b)),
    [accept, fileTree],
  );
  const needle = query.trim().toLowerCase();
  const shown = (
    needle ? paths.filter((path) => path.toLowerCase().includes(needle)) : paths
  ).slice(0, MAX_SHOWN);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Search the vault"
          placeholder="Search the vault"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && shown[0]) onPick(shown[0]);
          }}
        />
        <div className="max-h-72 overflow-y-auto rounded-md border border-border/60" role="listbox">
          {shown.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No matching files in this vault.</p>
          ) : (
            shown.map((path) => {
              const slash = path.lastIndexOf('/');
              return (
                <button
                  key={path}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="flex w-full flex-col items-start px-3 py-1.5 text-left text-sm hover:bg-muted/60"
                  onClick={() => onPick(path)}
                >
                  <span className="truncate">{path.slice(slash + 1)}</span>
                  {slash > 0 && (
                    <span className="truncate text-[11px] text-muted-foreground">
                      {path.slice(0, slash)}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
        {uploadAccept && onUpload && (
          <DialogFooter>
            <input
              ref={fileInput}
              type="file"
              accept={uploadAccept}
              className="hidden"
              aria-label="Choose a file from this computer"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) onUpload(file);
              }}
            />
            <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()}>
              <FileUp className="size-4" />
              From this computer…
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
