import { useEffect, useState } from 'react';

import { DatabaseZap, Link2Off, RefreshCw } from 'lucide-react';

import { flattenVaultFiles } from '../../lib/vaultLinks';
import type { CalendarDefinition } from '../../types/calendar';
import type { SheetDataConnection } from '../../types/sheet';
import type { NoteFile } from '../../types/vault';
import { ChoiceCard, ChoiceGroup } from '../ui/app-dialog';
import { Button } from '../ui/button';
import { DetailRow, ListDetailDialog, ListDetailRow } from '../ui/list-detail-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

interface Props {
  open: boolean;
  readOnly?: boolean;
  fileTree: NoteFile[];
  calendars: CalendarDefinition[];
  connections: SheetDataConnection[];
  onOpenChange: (open: boolean) => void;
  onAddKanban: (relativePath: string) => void;
  onAddCalendar: (calendarId: string) => void;
  onRefresh: (connection: SheetDataConnection) => void;
  onRemove: (connectionId: string) => void;
}

export default function SheetDataConnectionsDialog({
  open,
  readOnly,
  fileTree,
  calendars,
  connections,
  onOpenChange,
  onAddKanban,
  onAddCalendar,
  onRefresh,
  onRemove,
}: Props) {
  const [kanbanPath, setKanbanPath] = useState('');
  const [calendarId, setCalendarId] = useState('');
  const [sourceKind, setSourceKind] = useState<'kanban' | 'calendar'>('kanban');
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const kanbanFiles = flattenVaultFiles(fileTree).filter((file) =>
    /\.kanban$/i.test(file.relativePath),
  );
  useEffect(() => {
    if (!open) return;
    setKanbanPath('');
    setCalendarId('');
    setCreating(false);
  }, [open]);

  const sourceName = (connection: SheetDataConnection) =>
    connection.kind === 'kanbanTasks'
      ? (connection.sourcePath ?? 'Kanban board')
      : (calendars.find((calendar) => calendar.id === connection.calendarId)?.name ??
        connection.calendarId ??
        'Calendar');
  const selected = connections.find((connection) => connection.id === selectedId) ?? null;
  const createForm = (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] font-semibold">New snapshot</p>
      <p className="-mt-2 text-xs text-muted-foreground">
        A read-only copy of tasks or calendar items, written at the selection. Refreshing replaces
        only that range.
      </p>
      <ChoiceGroup
        value={sourceKind}
        onValueChange={(value) => setSourceKind(value as 'kanban' | 'calendar')}
        aria-label="Source"
        className="sm:grid-cols-2"
      >
        <ChoiceCard value="kanban" title="Kanban tasks" description="Cards from a board" />
        <ChoiceCard value="calendar" title="Calendar items" description="Events and tasks" />
      </ChoiceGroup>
      {sourceKind === 'kanban' ? (
        <div className="flex gap-2">
          <Select value={kanbanPath} onValueChange={setKanbanPath}>
            <SelectTrigger className="h-9 min-w-0 flex-1" aria-label="Kanban board source">
              <SelectValue placeholder="Choose a Kanban board" />
            </SelectTrigger>
            <SelectContent>
              {kanbanFiles.map((file) => (
                <SelectItem key={file.relativePath} value={file.relativePath}>
                  {file.relativePath}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            disabled={readOnly || !kanbanPath}
            onClick={() => {
              onAddKanban(kanbanPath);
              setCreating(false);
            }}
          >
            Import tasks
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Select value={calendarId} onValueChange={setCalendarId}>
            <SelectTrigger className="h-9 min-w-0 flex-1" aria-label="Calendar source">
              <SelectValue placeholder="Choose a calendar" />
            </SelectTrigger>
            <SelectContent>
              {calendars.map((calendar) => (
                <SelectItem key={calendar.id} value={calendar.id}>
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: calendar.color }}
                  />
                  {calendar.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            disabled={readOnly || !calendarId}
            onClick={() => {
              onAddCalendar(calendarId);
              setCreating(false);
            }}
          >
            Import items
          </Button>
        </div>
      )}
    </div>
  );
  return (
    <ListDetailDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<DatabaseZap />}
      title="Data snapshots"
      description="Read-only copies of Collab tasks or calendars inside this workbook."
      items={connections}
      getKey={(connection) => connection.id}
      selectedKey={selectedId}
      onSelect={(key) => {
        setSelectedId(key);
        setCreating(false);
      }}
      renderRow={(connection) => (
        <ListDetailRow
          title={sourceName(connection)}
          summary={`${connection.itemCount} rows · ${connection.kind === 'kanbanTasks' ? 'tasks' : 'calendar'}`}
        />
      )}
      detailOverride={creating || connections.length === 0 ? createForm : undefined}
      renderDetail={(connection) => (
        <>
          <DetailRow
            label="Source"
            description={connection.kind === 'kanbanTasks' ? 'Kanban board' : 'Calendar'}
          >
            <span className="max-w-56 truncate text-[13px]">{sourceName(connection)}</span>
          </DetailRow>
          <DetailRow label="Rows">
            <span className="text-[13px] tabular-nums">{connection.itemCount}</span>
          </DetailRow>
          <DetailRow label="Refreshed" description="Refreshing replaces only the managed range.">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={readOnly}
              aria-label="Refresh data snapshot"
              onClick={() => onRefresh(connection)}
            >
              <RefreshCw />
              {new Date(connection.refreshedAt).toLocaleString()}
            </Button>
          </DetailRow>
          <DetailRow label="Columns">
            <span className="max-w-64 text-right text-[12.5px] text-muted-foreground">
              {connection.columns.map((column) => column.label).join(', ')}
            </span>
          </DetailRow>
        </>
      )}
      onNew={() => setCreating(true)}
      newLabel="New snapshot"
      newDisabled={readOnly}
      footerStart={
        selected && !creating ? (
          <Button
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={readOnly}
            aria-label="Remove data connection"
            onClick={() => onRemove(selected.id)}
          >
            <Link2Off />
            Remove snapshot
          </Button>
        ) : undefined
      }
    />
  );
}
