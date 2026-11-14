import { useEffect, useState } from 'react';

import { Table2, Trash2 } from 'lucide-react';

import type { SheetTable } from '../../types/sheet';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { FormDialog, FormField } from '../ui/form-dialog';
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

  if (activeTable) {
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        size="s"
        icon={<Table2 />}
        title={activeTable.name}
        description={`${activeTable.columns.length} columns. Removing the table keeps its cells.`}
        submitLabel="Done"
        cancelLabel="Close"
        onSubmit={() => onOpenChange(false)}
        secondary={
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={readOnly}
            onClick={() => {
              onRemove(activeTable.id);
              onOpenChange(false);
            }}
          >
            <Trash2 />
            Remove table
          </Button>
        }
      >
        <FormField label="Columns">
          <div className="grid grid-cols-2 gap-1.5 text-xs">
            {activeTable.columns.map((column) => (
              <div
                key={column.id}
                className="truncate rounded-md border border-border/60 px-2 py-1.5"
              >
                {column.name}
              </div>
            ))}
          </div>
        </FormField>
      </FormDialog>
    );
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="s"
      icon={<Table2 />}
      title="Create table"
      description={`Turn ${selectionLabel} into a structured table.`}
      submitLabel="Create table"
      submitDisabled={readOnly || !name.trim()}
      onSubmit={() => {
        onCreate(name, hasHeaderRow);
        onOpenChange(false);
      }}
    >
      <FormField label="Table name" htmlFor="sheet-table-name">
        <Input
          id="sheet-table-name"
          autoFocus
          value={name}
          maxLength={64}
          disabled={readOnly}
          onChange={(event) => setName(event.target.value)}
          className="h-9"
        />
      </FormField>
      <label className="flex items-center gap-2 text-[13px]">
        <Checkbox
          checked={hasHeaderRow}
          disabled={readOnly}
          onCheckedChange={(checked) => setHasHeaderRow(checked === true)}
        />
        The selection includes a header row
      </label>
    </FormDialog>
  );
}
