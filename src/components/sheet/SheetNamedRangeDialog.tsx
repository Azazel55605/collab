import { useEffect, useMemo, useState } from 'react';
import { BookmarkPlus, Trash2 } from 'lucide-react';

import type { SheetDocument, SheetNamedRange } from '../../types/sheet';
import type { SheetNamedRangeScope } from '../../lib/sheet/namedRanges';
import { SheetAddressIndex } from '../../lib/sheet/address';
import { Badge } from '../ui/badge';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Separator } from '../ui/separator';

interface Props {
  open: boolean;
  readOnly?: boolean;
  document: SheetDocument;
  activeWorksheetId: string;
  selectionLabel: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (name: string, scope: SheetNamedRangeScope) => void;
  onRemove: (namedRangeId: string) => void;
  onNavigate: (namedRange: SheetNamedRange) => void;
}

export default function SheetNamedRangeDialog({
  open,
  readOnly,
  document,
  activeWorksheetId,
  selectionLabel,
  onOpenChange,
  onCreate,
  onRemove,
  onNavigate,
}: Props) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<SheetNamedRangeScope>('workbook');
  useEffect(() => {
    if (!open) return;
    setName('');
    setScope('workbook');
  }, [open]);

  const rows = useMemo(() => (document.namedRanges ?? []).map((namedRange) => {
    const worksheet = document.worksheets.find(
      (candidate) => candidate.id === namedRange.worksheetId,
    );
    return {
      namedRange,
      worksheet,
      rangeLabel: worksheet
        ? new SheetAddressIndex(worksheet).a1ForRange(namedRange.range)
        : null,
    };
  }), [document.namedRanges, document.worksheets]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Named ranges</DialogTitle>
          <DialogDescription>Create a reusable formula name for {selectionLabel}.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[1fr_9rem_auto] gap-2">
            <label className="flex flex-col gap-1 text-xs font-medium">
              Name
              <Input
                value={name}
                placeholder="Revenue"
                aria-label="Named range name"
                disabled={readOnly}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium">
              Scope
              <Select value={scope} disabled={readOnly} onValueChange={(value) => setScope(value as SheetNamedRangeScope)}>
                <SelectTrigger className="w-full" aria-label="Named range scope"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="workbook">Workbook</SelectItem>
                    <SelectItem value="worksheet">This worksheet</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </label>
            <Button
              type="button"
              className="self-end"
              disabled={readOnly || !name.trim()}
              onClick={() => {
                onCreate(name, scope);
                setName('');
              }}
            >
              <BookmarkPlus data-icon="inline-start" />
              Add
            </Button>
          </div>

          {rows.length > 0 ? (
            <>
              <Separator />
              <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                {rows.map(({ namedRange, worksheet, rangeLabel }) => (
                  <div key={namedRange.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => onNavigate(namedRange)}
                    >
                      <span className="block truncate text-xs font-medium">{namedRange.name}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {worksheet?.name ?? 'Missing worksheet'} · {rangeLabel ?? 'Invalid range'}
                      </span>
                    </button>
                    <Badge variant="secondary">
                      {namedRange.scopeWorksheetId === activeWorksheetId
                        ? 'This sheet'
                        : namedRange.scopeWorksheetId
                          ? 'Sheet local'
                          : 'Workbook'}
                    </Badge>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      disabled={readOnly}
                      aria-label={`Remove named range ${namedRange.name}`}
                      onClick={() => onRemove(namedRange.id)}
                    >
                      <Trash2 data-icon="inline-start" />
                    </Button>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="py-4 text-center text-xs text-muted-foreground">
              No named ranges in this workbook.
            </div>
          )}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
