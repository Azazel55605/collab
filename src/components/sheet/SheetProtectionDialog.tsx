import { useState } from 'react';

import { LockKeyhole, Trash2 } from 'lucide-react';

import { protectedRangeLabel } from '../../lib/sheet/protectedRanges';
import type { SheetProtectedRange, SheetWorksheet } from '../../types/sheet';
import { Button } from '../ui/button';
import { FormField } from '../ui/form-dialog';
import { Input } from '../ui/input';
import { DetailRow, ListDetailDialog, ListDetailRow } from '../ui/list-detail-dialog';

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
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const ranges = worksheet.protectedRanges ?? [];
  const label = (range: SheetProtectedRange) => range.name ?? protectedRangeLabel(worksheet, range);
  const selected = ranges.find((range) => range.id === selectedId) ?? null;
  const createForm = (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (readOnly) return;
        onProtect(name);
        setName('');
        setCreating(false);
      }}
    >
      <p className="text-[13px] font-semibold">Protect {selectionLabel}</p>
      <p className="-mt-2 text-xs text-muted-foreground">
        Prevents accidental edits in this editor. It is not encryption or access control.
      </p>
      <FormField label="Name (optional)" htmlFor="protected-range-name">
        <Input
          id="protected-range-name"
          autoFocus
          aria-label="Protected range name"
          value={name}
          placeholder={selectionLabel}
          onChange={(event) => setName(event.target.value)}
          className="h-9"
        />
      </FormField>
      <div className="flex gap-2">
        <Button type="submit" disabled={readOnly}>
          <LockKeyhole data-icon="inline-start" />
          Protect
        </Button>
        {ranges.length > 0 && (
          <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
  return (
    <ListDetailDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<LockKeyhole />}
      tone="warning"
      title="Protected ranges"
      description="Cells on this worksheet that cannot be changed by accident."
      items={ranges}
      getKey={(range) => range.id}
      selectedKey={selectedId}
      onSelect={(key) => {
        setSelectedId(key);
        setCreating(false);
      }}
      renderRow={(range) => (
        <ListDetailRow title={label(range)} summary={protectedRangeLabel(worksheet, range)} />
      )}
      detailOverride={creating || ranges.length === 0 ? createForm : undefined}
      renderDetail={(range) => (
        <>
          <DetailRow label="Name">
            <span className="text-[13px]">{label(range)}</span>
          </DetailRow>
          <DetailRow label="Range" description={`On ${worksheet.name}.`}>
            <span className="font-mono text-[13px]">{protectedRangeLabel(worksheet, range)}</span>
          </DetailRow>
        </>
      )}
      onNew={() => setCreating(true)}
      newLabel="Protect the selection"
      newDisabled={readOnly}
      footerStart={
        selected && !creating ? (
          <Button
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={readOnly}
            aria-label={`Remove protection ${selected.name ?? selected.id}`}
            onClick={() => onRemove(selected.id)}
          >
            <Trash2 />
            Remove protection
          </Button>
        ) : undefined
      }
    />
  );
}
