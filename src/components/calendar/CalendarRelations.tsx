import { useEffect, useMemo, useState } from 'react';

import {
  Bell,
  ExternalLink,
  File,
  LoaderCircle,
  Paperclip,
  SquareKanban,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';

import { tauriCommands } from '../../lib/tauri';
import { createVaultClient } from '../../lib/vaultClient';
import { useVaultStore } from '../../store/vaultStore';
import type {
  CalendarAttachment,
  CalendarAttendanceResponse,
  CalendarAttendee,
  CalendarDefinition,
  CalendarItem,
} from '../../types/calendar';
import { type KanbanCard, normalizeKanbanBoard } from '../../types/kanban';
import type { NoteFile, UserDirectoryEntry } from '../../types/vault';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

function flattenFiles(nodes: NoteFile[]): NoteFile[] {
  return nodes.flatMap((node) => (node.isFolder ? flattenFiles(node.children ?? []) : [node]));
}

export function CalendarAttendeeEditor({
  calendar,
  attendees,
  onChange,
}: {
  calendar?: CalendarDefinition;
  attendees: CalendarAttendee[];
  onChange: (attendees: CalendarAttendee[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const hosted = calendar?.location.kind === 'hosted' ? calendar.location : null;

  useEffect(() => {
    if (!hosted || query.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    const timeout = window.setTimeout(() => {
      void tauriCommands
        .hostedUserDirectory(hosted.serverUrl, query.trim())
        .then((entries) => {
          if (active) setResults(entries);
        })
        .catch(() => {
          if (active) setResults([]);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [hosted?.serverUrl, query]);

  if (!hosted) return null;
  const add = (entry: UserDirectoryEntry) => {
    if (
      attendees.some(
        (attendee) => attendee.kind === 'collabUser' && attendee.userId === entry.userId,
      )
    )
      return;
    onChange([
      ...attendees,
      {
        id: crypto.randomUUID(),
        kind: 'collabUser',
        serverUrl: hosted.serverUrl,
        userId: entry.userId,
        displayName: entry.displayName || entry.username,
        response: 'needs-action',
        role: 'required',
      },
    ]);
    setQuery('');
    setResults([]);
  };

  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium">People</span>
      {attendees.map((attendee) => (
        <div
          key={attendee.id}
          className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs"
        >
          <Users className="size-3.5 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {attendee.displayName ?? (attendee.kind === 'email' ? attendee.email : attendee.userId)}
          </span>
          <span className="text-[10px] capitalize text-muted-foreground">
            {attendee.response.replace('-', ' ')}
          </span>
          <Select
            value={attendee.role}
            onValueChange={(role) =>
              onChange(
                attendees.map((entry) =>
                  entry.id === attendee.id
                    ? { ...entry, role: role as CalendarAttendee['role'] }
                    : entry,
                ),
              )
            }
          >
            <SelectTrigger
              aria-label={`Role for ${attendee.displayName ?? 'attendee'}`}
              size="sm"
              className="w-24"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="required">Required</SelectItem>
              <SelectItem value="optional">Optional</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${attendee.displayName ?? 'attendee'}`}
            onClick={() => onChange(attendees.filter((entry) => entry.id !== attendee.id))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className="relative">
        <UserPlus className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="pl-8"
          placeholder="Search people on this server"
          aria-label="Search server users"
        />
        {loading && (
          <LoaderCircle className="absolute right-2.5 top-2.5 size-3.5 animate-spin text-muted-foreground" />
        )}
      </div>
      {query.trim().length >= 2 && !loading && (
        <div className="max-h-36 overflow-y-auto rounded-md border border-border/60 p-1">
          {results.map((entry) => (
            <button
              key={entry.userId}
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
              onClick={() => add(entry)}
            >
              <Users className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{entry.displayName || entry.username}</span>
              <span className="truncate text-[10px] text-muted-foreground">@{entry.username}</span>
            </button>
          ))}
          {results.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">No people found</p>
          )}
        </div>
      )}
    </div>
  );
}

export function CalendarAttachmentEditor({
  calendar,
  attachments,
  onChange,
}: {
  calendar?: CalendarDefinition;
  attachments: CalendarAttachment[];
  onChange: (attachments: CalendarAttachment[]) => void;
}) {
  const vault = useVaultStore((state) => state.vault);
  const fileTree = useVaultStore((state) => state.fileTree);
  const [url, setUrl] = useState('');
  const [kanbanCards, setKanbanCards] = useState<Array<{ board: NoteFile; card: KanbanCard }>>([]);
  const [loadingBoard, setLoadingBoard] = useState(false);
  const [uploading, setUploading] = useState(false);
  const files = useMemo(() => flattenFiles(fileTree), [fileTree]);
  const boards = files.filter((file) => file.extension.toLowerCase() === 'kanban');
  const referenceOrigin =
    vault?.kind === 'hosted'
      ? { serverUrl: vault.serverUrl, vaultId: vault.hostedVaultId }
      : { vaultId: vault?.id };
  const addFile = (path: string) => {
    const file = files.find((entry) => entry.relativePath === path);
    if (!file || attachments.some((entry) => entry.kind === 'vaultFile' && entry.fileId === path))
      return;
    onChange([
      ...attachments,
      {
        id: crypto.randomUUID(),
        kind: 'vaultFile',
        name: file.name,
        fileId: file.relativePath,
        path: file.relativePath,
        ...referenceOrigin,
      },
    ]);
  };
  const loadBoard = async (path: string) => {
    const board = boards.find((entry) => entry.relativePath === path);
    if (!vault || !board) return;
    setLoadingBoard(true);
    try {
      const document = await createVaultClient(vault).readDocument(path);
      const parsed = normalizeKanbanBoard(JSON.parse(document.content));
      setKanbanCards(
        parsed.columns.flatMap((column) => column.cards.map((card) => ({ board, card }))),
      );
    } catch {
      setKanbanCards([]);
    } finally {
      setLoadingBoard(false);
    }
  };
  const addCard = (cardId: string) => {
    const selected = kanbanCards.find((entry) => entry.card.id === cardId);
    if (
      !selected ||
      attachments.some(
        (entry) =>
          entry.kind === 'kanbanTask' &&
          entry.fileId === selected.board.relativePath &&
          entry.cardId === cardId,
      )
    )
      return;
    onChange([
      ...attachments,
      {
        id: crypto.randomUUID(),
        kind: 'kanbanTask',
        name: selected.card.title,
        fileId: selected.board.relativePath,
        cardId,
        ...referenceOrigin,
      },
    ]);
  };
  const addUrl = () => {
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      onChange([
        ...attachments,
        {
          id: crypto.randomUUID(),
          kind: 'externalUrl',
          name: parsed.hostname,
          url: parsed.toString(),
        },
      ]);
      setUrl('');
    } catch {
      // Invalid URLs remain in the input for correction.
    }
  };
  const uploadFile = async () => {
    if (calendar?.location.kind !== 'hosted') return;
    const paths = await tauriCommands.showOpenFilesDialog([
      'pdf',
      'txt',
      'md',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'svg',
      'csv',
      'json',
      'ics',
    ]);
    const sourcePath = paths?.[0];
    if (!sourcePath) return;
    setUploading(true);
    try {
      const payload = await tauriCommands.readFileForUpload(sourcePath);
      const uploaded = await tauriCommands.hostedCalendarRequest<{
        id: string;
        name: string;
        mediaType?: string;
        sizeBytes?: number;
      }>(
        calendar.location.serverUrl,
        'POST',
        `/api/v1/calendars/${encodeURIComponent(calendar.id)}/attachments`,
        {
          name: payload.name,
          mediaType: payload.mediaType,
          contentBase64: payload.contentBase64,
        },
      );
      onChange([
        ...attachments,
        {
          id: crypto.randomUUID(),
          kind: 'uploaded',
          name: uploaded.name || payload.name,
          attachmentId: uploaded.id,
          contentType: uploaded.mediaType || payload.mediaType,
          sizeBytes: uploaded.sizeBytes,
        },
      ]);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium">Attachments</span>
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5 text-xs"
        >
          {attachment.kind === 'kanbanTask' ? (
            <SquareKanban className="size-3.5 text-muted-foreground" />
          ) : attachment.kind === 'externalUrl' ? (
            <ExternalLink className="size-3.5 text-muted-foreground" />
          ) : (
            <File className="size-3.5 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
          <span className="text-[10px] text-muted-foreground">
            {attachment.kind === 'kanbanTask'
              ? 'Kanban'
              : attachment.kind === 'vaultFile'
                ? 'File'
                : attachment.kind === 'externalUrl'
                  ? 'Link'
                  : 'Upload'}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${attachment.name}`}
            onClick={() => onChange(attachments.filter((entry) => entry.id !== attachment.id))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      {vault && files.length > 0 && (
        <Select onValueChange={addFile}>
          <SelectTrigger aria-label="Attach vault file" className="w-full">
            <Paperclip className="size-3.5" />
            <SelectValue placeholder="Attach vault file" />
          </SelectTrigger>
          <SelectContent>
            {files.map((file) => (
              <SelectItem key={file.relativePath} value={file.relativePath}>
                {file.relativePath}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {calendar?.location.kind === 'hosted' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          disabled={uploading}
          onClick={() => void uploadFile()}
        >
          {uploading ? <LoaderCircle className="animate-spin" /> : <Paperclip />}Upload a file
        </Button>
      )}
      {vault && boards.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          <Select onValueChange={(value) => void loadBoard(value)}>
            <SelectTrigger aria-label="Choose Kanban board" className="w-full">
              <SelectValue placeholder="Kanban board" />
            </SelectTrigger>
            <SelectContent>
              {boards.map((board) => (
                <SelectItem key={board.relativePath} value={board.relativePath}>
                  {board.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select disabled={loadingBoard || kanbanCards.length === 0} onValueChange={addCard}>
            <SelectTrigger aria-label="Attach Kanban task" className="w-full">
              {loadingBoard ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <SelectValue placeholder="Task" />
              )}
            </SelectTrigger>
            <SelectContent>
              {kanbanCards.map(({ board, card }) => (
                <SelectItem key={`${board.relativePath}:${card.id}`} value={card.id}>
                  {card.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="flex gap-2">
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          type="url"
          placeholder="https://..."
          aria-label="Attachment URL"
        />
        <Button type="button" variant="outline" size="sm" disabled={!url.trim()} onClick={addUrl}>
          Add link
        </Button>
      </div>
    </div>
  );
}

type HostedInvitation = {
  id: string;
  organizerUserId: string;
  attendeeUserId: string;
  attendeeId: string;
  response: CalendarAttendanceResponse;
  item: CalendarItem;
};

export function CalendarInvitations({
  origins,
  onChanged,
}: {
  origins: Array<{ serverUrl: string; userId: string }>;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [invitations, setInvitations] = useState<Array<HostedInvitation & { serverUrl: string }>>(
    [],
  );
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError('');
    void Promise.all(
      origins.map(async ({ serverUrl }) => {
        const entries = await tauriCommands.hostedCalendarRequest<HostedInvitation[]>(
          serverUrl,
          'GET',
          '/api/v1/calendars/invitations',
        );
        return entries.map((entry) => ({ ...entry, serverUrl }));
      }),
    )
      .then((entries) => {
        if (active) setInvitations(entries.flat());
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, origins]);
  const respond = async (
    invitation: HostedInvitation & { serverUrl: string },
    response: CalendarAttendanceResponse,
  ) => {
    try {
      setError('');
      await tauriCommands.hostedCalendarRequest(
        invitation.serverUrl,
        'POST',
        `/api/v1/calendars/invitations/${encodeURIComponent(invitation.id)}/response`,
        { response },
      );
      setInvitations((current) =>
        current.map((entry) =>
          entry.id === invitation.id && entry.serverUrl === invitation.serverUrl
            ? { ...entry, response }
            : entry,
        ),
      );
      onChanged();
    } catch (reason) {
      setError(String(reason));
    }
  };
  const pending = invitations.filter((invitation) => invitation.response === 'needs-action');
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Calendar invitations"
          title="Calendar invitations"
          className="relative"
        >
          <Bell />
          {pending.length > 0 && (
            <span className="absolute right-0 top-0 flex size-3.5 items-center justify-center rounded-full bg-primary text-[8px] text-primary-foreground">
              {pending.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <div className="mb-2 flex items-center gap-2 px-1">
          <Users className="size-4 text-primary" />
          <span className="text-sm font-semibold">Invitations</span>
        </div>
        {loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Loading invitations
          </div>
        )}
        {!loading && error && (
          <p className="rounded bg-destructive/10 p-2 text-xs text-destructive">{error}</p>
        )}
        {!loading && !error && invitations.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">No invitations</p>
        )}
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {invitations.map((invitation) => (
            <div
              key={`${invitation.serverUrl}:${invitation.id}`}
              className="rounded-md border border-border/60 p-2"
            >
              <p className="truncate text-xs font-medium">{invitation.item.title}</p>
              <p className="mb-2 truncate text-[10px] text-muted-foreground">
                {new URL(invitation.serverUrl).host}
              </p>
              <div className="flex gap-1">
                {(
                  [
                    ['accepted', 'Accept'],
                    ['tentative', 'Maybe'],
                    ['declined', 'Decline'],
                  ] as Array<[CalendarAttendanceResponse, string]>
                ).map(([response, label]) => (
                  <Button
                    key={response}
                    type="button"
                    variant={invitation.response === response ? 'default' : 'outline'}
                    size="xs"
                    onClick={() => void respond(invitation, response)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
