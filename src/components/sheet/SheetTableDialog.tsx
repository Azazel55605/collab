import { useEffect, useState } from 'react';

import { Table2, Trash2 } from 'lucide-react';

import type { SheetTable } from '../../types/sheet';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
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
  activeTable: SheetTable | null;
  suggestedName: string;
  selectionLabel: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, hasHeaderRow: boolean) => void;
  onRemove: (tableId: string) => void;
}

export default function SheetTableDialog({
  open,
  readOnly,
  activeTable,
  suggestedName,
  selectionLabel,
  onOpenChange,
  onCreate,
  onRemove,
}: Props) {
  const [name, setName] = useState(suggestedName);
  const [hasHeaderRow, setHasHeaderRow] = useState(true);
  useEffect(() => {
    if (open) setName(suggestedName);
  }, [open, suggestedName]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{activeTable ? activeTable.name : 'Create table'}</DialogTitle>
          <DialogDescription>
            {activeTable
              ? `${activeTable.columns.length} columns with stable table identities.`
              : `Turn ${selectionLabel} into a structured table.`}
          </DialogDescription>
        </DialogHeader>

        {activeTable ? (
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-2 text-xs">
              {activeTable.columns.map((column) => (
                <div
                  key={column.id}
                  className="truncate rounded-md border border-border/60 px-2 py-1.5"
                >
                  {column.name}
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="destructive"
              disabled={readOnly}
              onClick={() => {
                onRemove(activeTable.id);
                onOpenChange(false);
              }}
            >
              <Trash2 />
              Remove table
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            <label className="grid gap-1 text-xs font-medium">
              Table name
              <Input
                value={name}
                maxLength={64}
                disabled={readOnly}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={hasHeaderRow}
                disabled={readOnly}
                onCheckedChange={(checked) => setHasHeaderRow(checked === true)}
              />
              Selection includes a header row
            </label>
            <Button
              type="button"
              disabled={readOnly || !name.trim()}
              onClick={() => {
                onCreate(name, hasHeaderRow);
                onOpenChange(false);
              }}
            >
              <Table2 />
              Create table
            </Button>
          </div>
        )}

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
