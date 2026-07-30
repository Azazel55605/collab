import { useState } from 'react';
import { LockKeyhole, Trash2 } from 'lucide-react';

import type { SheetProtectedRange, SheetWorksheet } from '../../types/sheet';
import { protectedRangeLabel } from '../../lib/sheet/protectedRanges';
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

interface Props {
  open: boolean;
  readOnly?: boolean;
  worksheet: SheetWorksheet;
  selectionLabel: string;
  onOpenChange: (open: boolean) => void;
  onProtect: (name: string) => void;
  onRemove: (id: string) => void;
}

export default function SheetProtectionDialog({
  open,
  readOnly,
  worksheet,
  selectionLabel,
  onOpenChange,
  onProtect,
  onRemove,
}: Props) {
  const [name, setName] = useState('');
  const ranges = worksheet.protectedRanges ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Protected ranges</DialogTitle>
          <DialogDescription>
            Prevent accidental edits. This is an editor policy, not encryption or access control.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex gap-2">
            <Input
              aria-label="Protected range name"
              value={name}
              placeholder={selectionLabel}
              onChange={(event) => setName(event.target.value)}
            />
            <Button
              type="button"
              disabled={readOnly}
              onClick={() => {
                onProtect(name);
                setName('');
              }}
            >
              <LockKeyhole data-icon="inline-start" />
              Protect
            </Button>
          </div>
          {ranges.length > 0 && (
            <div className="max-h-52 space-y-1 overflow-y-auto border-t border-border/60 pt-3">
              {ranges.map((range: SheetProtectedRange) => (
                <div key={range.id} className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate">
                    {range.name ?? protectedRangeLabel(worksheet, range)}
                  </span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    disabled={readOnly}
                    aria-label={`Remove protection ${range.name ?? range.id}`}
                    onClick={() => onRemove(range.id)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
