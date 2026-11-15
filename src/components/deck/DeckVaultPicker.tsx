import { useMemo, useRef, useState } from 'react';

import { FileText, FileUp, Image as ImageIcon } from 'lucide-react';

import { flattenVaultPaths } from '../../lib/deck/vaultAssets';
import type { NoteFile } from '../../types/vault';
import { Button } from '../ui/button';
import { PickerDialog, PickerRow } from '../ui/picker-dialog';

interface DeckVaultPickerProps {
  /** Where focus goes when the dialog closes (the slide, rather than the menu that opened it). */
  onReturnFocus?: () => void;
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
  onReturnFocus,
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
  const [selected, setSelected] = useState<string | null>(null);
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

  const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
  return (
    <PickerDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('');
        onOpenChange(next);
      }}
      size="m"
      className="h-[min(560px,calc(100vh-2rem))]"
      onCloseAutoFocus={
        onReturnFocus
          ? (event) => {
              event.preventDefault();
              onReturnFocus();
            }
          : undefined
      }
      icon={uploadAccept ? <ImageIcon /> : <FileText />}
      title={title}
      description={description}
      query={query}
      onQueryChange={setQuery}
      searchPlaceholder="Search the vault"
      groups={[{ label: needle ? undefined : `${paths.length} in this vault`, items: shown }]}
      getKey={(path) => path}
      selectedKey={selected}
      onSelect={setSelected}
      renderItem={(path) => {
        const slash = path.lastIndexOf('/');
        return (
          <PickerRow
            icon={uploadAccept ? <ImageIcon /> : <FileText />}
            title={name(path)}
            detail={slash > 0 ? path.slice(0, slash) : 'Vault root'}
          />
        );
      }}
      onPick={onPick}
      pickLabel={(path) => (path ? `Use ${name(path)}` : 'Use')}
      emptyText="No matching files in this vault."
      secondary={
        uploadAccept && onUpload ? (
          <>
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
            <Button type="button" variant="ghost" onClick={() => fileInput.current?.click()}>
              <FileUp className="size-4" />
              From this computer…
            </Button>
          </>
        ) : undefined
      }
    />
  );
}
