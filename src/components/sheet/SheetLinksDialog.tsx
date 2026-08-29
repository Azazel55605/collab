import { useEffect, useState } from 'react';

import { Link2, Paperclip, Plus, Trash2 } from 'lucide-react';

import { createSheetAttachmentId } from '../../lib/sheet/document';
import { flattenVaultFiles } from '../../lib/vaultLinks';
import type { SheetCell, SheetCellAttachment } from '../../types/sheet';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

interface Props {
  open: boolean;
  readOnly?: boolean;
  cell?: SheetCell;
  fileTree: NoteFile[];
  onOpenChange: (open: boolean) => void;
  onSave: (link: string | null, attachments: SheetCellAttachment[]) => void;
}

export default function SheetLinksDialog({
  open,
  readOnly,
  cell,
  fileTree,
  onOpenChange,
  onSave,
}: Props) {
  const [link, setLink] = useState('');
  const [attachments, setAttachments] = useState<SheetCellAttachment[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const files = flattenVaultFiles(fileTree);

  useEffect(() => {
    if (!open) return;
    setLink(cell?.link ?? '');
    setAttachments(cell?.attachments ?? []);
    setSelectedPath('');
  }, [cell, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Cell links and attachments</DialogTitle>
          <DialogDescription>
            Links and attachments stay vault-relative and follow normal Collab reference handling.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-xs font-medium">
            <span className="flex items-center gap-1.5">
              <Link2 size={13} /> Link target
            </span>
            <Input
              value={link}
              disabled={readOnly}
              placeholder="Notes/Project.md"
              aria-label="Cell link target"
              onChange={(event) => setLink(event.target.value)}
            />
          </label>
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <Paperclip size={13} /> Attachments
            </span>
            <div className="flex gap-2">
              <Select value={selectedPath} disabled={readOnly} onValueChange={setSelectedPath}>
                <SelectTrigger className="min-w-0 flex-1" aria-label="Vault attachment">
                  <SelectValue placeholder="Choose a vault file" />
                </SelectTrigger>
                <SelectContent>
                  {files.map((file) => (
                    <SelectItem key={file.relativePath} value={file.relativePath}>
                      {file.relativePath}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="icon"
                disabled={
                  readOnly ||
                  !selectedPath ||
                  attachments.some((attachment) => attachment.relativePath === selectedPath)
                }
                aria-label="Add attachment"
                onClick={() => {
                  if (!selectedPath) return;
                  setAttachments((current) => [
                    ...current,
                    {
                      id: createSheetAttachmentId(),
                      relativePath: selectedPath,
                    },
                  ]);
                  setSelectedPath('');
                }}
              >
                <Plus />
              </Button>
            </div>
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-xs">
                  {attachment.label || attachment.relativePath}
                </span>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={readOnly}
                  aria-label={`Remove attachment ${attachment.relativePath}`}
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((candidate) => candidate.id !== attachment.id),
                    )
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            disabled={readOnly}
            onClick={() => {
              onSave(link.trim() || null, attachments);
              onOpenChange(false);
            }}
          >
            Save links
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
