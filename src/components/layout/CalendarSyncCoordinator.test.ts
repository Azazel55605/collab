import { beforeEach, expect, it, vi } from 'vitest';

import { calendarInvalidationPaths } from '../../lib/kanbanCalendarProjection';
import { clearDocumentReads } from '../../lib/sharedDocumentResources';
import { useCalendarStore } from '../../store/calendarStore';
import { useVaultStore } from '../../store/vaultStore';
import type { NoteFile, VaultMeta } from '../../types/vault';

import { syncLocalKanbanProjection } from './CalendarSyncCoordinator';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  list: vi.fn(),
  replace: vi.fn().mockResolvedValue(undefined),
  calendars: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../lib/vaultClient', () => ({
  createVaultClient: () => ({
    id: 'local-qa',
    name: 'QA',
    listFiles: mocks.list,
    readDocument: mocks.read,
  }),
}));
vi.mock('../../lib/tauri', () => ({
  tauriCommands: { calendarReplaceGeneratedKanban: mocks.replace, calendarList: mocks.calendars },
}));
let number = 0;
function fixture() {
  const vault = {
    id: `calendar-qa-${++number}`,
    kind: 'local',
    path: '/qa',
    name: 'QA',
  } as VaultMeta;
  const file: NoteFile = {
    relativePath: 'tasks.kanban',
    name: 'tasks.kanban',
    extension: 'kanban',
    modifiedAt: 10,
    size: 100,
    isFolder: false,
  };
  useVaultStore.setState({ vault, fileTree: [file], isLoading: false, isVaultLocked: false });
  useCalendarStore.setState({ profileId: 'profile-1', range: null });
  return { vault, file };
}
const content = JSON.stringify({
  columns: [
    {
      id: 'todo',
      title: 'Todo',
      cards: [
        {
          id: 'a',
          title: 'Assignment',
          assignees: ['profile-1'],
          tags: [],
          comments: [],
          checklist: [],
        },
      ],
    },
  ],
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ content });
  mocks.replace.mockResolvedValue(undefined);
  mocks.calendars.mockResolvedValue([]);
});
it('uses the indexed tree and reads only changed boards, preserving deletion projection', async () => {
  const { vault, file } = fixture();
  await syncLocalKanbanProjection('profile-1', vault);
  await syncLocalKanbanProjection('profile-1', vault);
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(mocks.replace).toHaveBeenCalledTimes(1);
  useVaultStore.setState({ fileTree: [{ ...file, contentRevision: 'new' }] });
  await syncLocalKanbanProjection('profile-1', vault);
  expect(mocks.read).toHaveBeenCalledTimes(2);
  useVaultStore.setState({ fileTree: [] });
  await syncLocalKanbanProjection('profile-1', vault);
  expect(mocks.replace.mock.calls[mocks.replace.mock.calls.length - 1]?.[2]).toEqual([]);
});
it('retries failed publication and reconciles events arriving during a read without parallel jobs', async () => {
  const { vault, file } = fixture();
  mocks.replace.mockRejectedValueOnce(new Error('disk full'));
  await expect(syncLocalKanbanProjection('profile-1', vault)).rejects.toThrow('disk full');
  await syncLocalKanbanProjection('profile-1', vault);
  expect(mocks.replace).toHaveBeenCalledTimes(2);
  let finish!: (v: unknown) => void;
  mocks.read.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  useVaultStore.setState({ fileTree: [{ ...file, contentRevision: 'v2' }] });
  const first = syncLocalKanbanProjection('profile-1', vault);
  await Promise.resolve();
  useVaultStore.setState({ fileTree: [] });
  const second = syncLocalKanbanProjection('profile-1', vault);
  finish({ content });
  await Promise.all([first, second]);
  expect(mocks.replace.mock.calls[mocks.replace.mock.calls.length - 1]?.[2]).toEqual([]);
});

it('clears retained plaintext on privacy cleanup and does not project locked vaults', async () => {
  const { vault } = fixture();
  await syncLocalKanbanProjection('profile-1', vault);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  useVaultStore.setState({ isVaultLocked: true });
  clearDocumentReads();
  await syncLocalKanbanProjection('profile-1', vault);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  useVaultStore.setState({ isVaultLocked: false });
  await syncLocalKanbanProjection('profile-1', vault);
  expect(mocks.read).toHaveBeenCalledTimes(2);
});

it('accepts actual rename events without a path field and ignores another vault', () => {
  expect(
    calendarInvalidationPaths(
      { oldPath: 'old.kanban', newPath: 'new.md', vaultPath: '/qa' },
      '/qa',
    ),
  ).toEqual(['old.kanban', 'new.md']);
  expect(
    calendarInvalidationPaths(
      { oldPath: 'Boards', newPath: 'Archive', vaultPath: '/other' },
      '/qa',
    ),
  ).toEqual([]);
});
