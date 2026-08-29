import { useEffect, useState } from 'react';

import { Link2Off, RefreshCw } from 'lucide-react';

import { flattenVaultFiles } from '../../lib/vaultLinks';
import type { CalendarDefinition } from '../../types/calendar';
import type { SheetDataConnection } from '../../types/sheet';
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
  const kanbanFiles = flattenVaultFiles(fileTree).filter((file) =>
    /\.kanban$/i.test(file.relativePath),
  );
  useEffect(() => {
    if (!open) return;
    setKanbanPath('');
    setCalendarId('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Data snapshots</DialogTitle>
          <DialogDescription>
            Import read-only snapshots from Collab tasks or calendars. Refreshing replaces only the
            managed range.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <Select value={kanbanPath} onValueChange={setKanbanPath}>
              <SelectTrigger className="w-full" aria-label="Kanban board source">
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
              onClick={() => onAddKanban(kanbanPath)}
            >
              Import tasks
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <Select value={calendarId} onValueChange={setCalendarId}>
              <SelectTrigger className="w-full" aria-label="Calendar source">
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
              onClick={() => onAddCalendar(calendarId)}
            >
              Import items
            </Button>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {connections.map((connection) => (
              <div
                key={connection.id}
                className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">
                    {connection.kind === 'kanbanTasks'
                      ? connection.sourcePath
                      : (calendars.find((calendar) => calendar.id === connection.calendarId)
                          ?.name ?? connection.calendarId)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {connection.itemCount} rows · refreshed{' '}
                    {new Date(connection.refreshedAt).toLocaleString()}
                  </div>
                </div>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={readOnly}
                  aria-label="Refresh data snapshot"
                  onClick={() => onRefresh(connection)}
                >
                  <RefreshCw />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={readOnly}
                  aria-label="Remove data connection"
                  onClick={() => onRemove(connection.id)}
                >
                  <Link2Off />
                </Button>
              </div>
            ))}
            {connections.length === 0 && (
              <div className="py-5 text-center text-xs text-muted-foreground">
                No data snapshots in this workbook.
              </div>
            )}
          </div>
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
