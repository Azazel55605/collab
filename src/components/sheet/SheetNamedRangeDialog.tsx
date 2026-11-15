import { useEffect, useMemo, useState } from 'react';

import { Bookmark, BookmarkPlus, Trash2 } from 'lucide-react';

import { SheetAddressIndex } from '../../lib/sheet/address';
import type { SheetNamedRangeScope } from '../../lib/sheet/namedRanges';
import type { SheetDocument, SheetNamedRange } from '../../types/sheet';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { FormField, FormRow } from '../ui/form-dialog';
import { Input } from '../ui/input';
import { DetailRow, ListDetailDialog, ListDetailRow } from '../ui/list-detail-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

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
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName('');
    setScope('workbook');
    setCreating(false);
  }, [open]);

  const rows = useMemo(
    () =>
      (document.namedRanges ?? []).map((namedRange) => {
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
      }),
    [document.namedRanges, document.worksheets],
  );

  const scopeLabel = (namedRange: SheetNamedRange) =>
    namedRange.scopeWorksheetId === activeWorksheetId
      ? 'This sheet'
      : namedRange.scopeWorksheetId
        ? 'Sheet local'
        : 'Workbook';
  const createForm = (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (readOnly || !name.trim()) return;
        onCreate(name, scope);
        setName('');
        setCreating(false);
      }}
    >
      <p className="text-[13px] font-semibold">Name {selectionLabel}</p>
      <p className="-mt-2 text-xs text-muted-foreground">
        Use the name in formulas instead of the cell address.
      </p>
      <FormRow>
        <FormField label="Name" htmlFor="named-range-name">
          <Input
            id="named-range-name"
            autoFocus
            value={name}
            placeholder="Revenue"
            aria-label="Named range name"
            disabled={readOnly}
            onChange={(event) => setName(event.target.value)}
            className="h-9"
          />
        </FormField>
        <FormField label="Scope">
          <Select
            value={scope}
            disabled={readOnly}
            onValueChange={(value) => setScope(value as SheetNamedRangeScope)}
          >
            <SelectTrigger className="h-9 w-full" aria-label="Named range scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="workbook">Whole workbook</SelectItem>
              <SelectItem value="worksheet">This worksheet</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
      </FormRow>
      <div className="flex gap-2">
        <Button type="submit" disabled={readOnly || !name.trim()}>
          <BookmarkPlus data-icon="inline-start" />
          Add
        </Button>
        {rows.length > 0 && (
          <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
  const selected = rows.find((row) => row.namedRange.id === selectedId) ?? null;
  return (
    <ListDetailDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<Bookmark />}
      title="Named ranges"
      description="Names you can use in formulas instead of cell addresses."
      items={rows}
      getKey={(row) => row.namedRange.id}
      selectedKey={selectedId}
      onSelect={(key) => {
        setSelectedId(key);
        setCreating(false);
      }}
      renderRow={({ namedRange, worksheet, rangeLabel }) => (
        <ListDetailRow
          title={<span className="font-mono">{namedRange.name}</span>}
          summary={`${worksheet?.name ?? 'Missing worksheet'}!${rangeLabel ?? 'invalid'}`}
          trailing={<Badge variant="secondary">{scopeLabel(namedRange)}</Badge>}
        />
      )}
      detailOverride={creating || rows.length === 0 ? createForm : undefined}
      renderDetail={({ namedRange, worksheet, rangeLabel }) => (
        <>
          <DetailRow label="Name">
            <span className="font-mono text-[13px]">{namedRange.name}</span>
          </DetailRow>
          <DetailRow label="Refers to" description="The cells the name stands for.">
            <span className="font-mono text-[13px]">
              {worksheet?.name ?? 'Missing worksheet'}!{rangeLabel ?? 'invalid'}
            </span>
          </DetailRow>
          <DetailRow label="Scope" description="Where formulas can use the name.">
            <span className="text-[13px]">{scopeLabel(namedRange)}</span>
          </DetailRow>
          <div className="pt-3">
            <Button variant="outline" size="sm" onClick={() => onNavigate(namedRange)}>
              Go to range
            </Button>
          </div>
        </>
      )}
      onNew={() => setCreating(true)}
      newLabel="Name the selection"
      newDisabled={readOnly}
      footerStart={
        selected && !creating ? (
          <Button
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={readOnly}
            aria-label={`Remove named range ${selected.namedRange.name}`}
            onClick={() => onRemove(selected.namedRange.id)}
          >
            <Trash2 />
            Remove name
          </Button>
        ) : undefined
      }
    />
  );
}
