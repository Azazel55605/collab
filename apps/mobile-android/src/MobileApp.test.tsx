import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { findBackgroundAttention, MobileApp } from './MobileApp';
import type { BackgroundJobRecord } from './mobileTauri';
import { useMobileStore } from './state/store';

function mockInvoke(handlers: Record<string, (args: unknown) => unknown>) {
  invoke.mockImplementation((command: string, args: unknown) => {
    const handler = handlers[command];
    if (!handler) return Promise.reject(new Error(`unhandled command ${command}`));
    return Promise.resolve(handler(args));
  });
}

const AUTH_REQUIRED_JOB: BackgroundJobRecord = {
  id: 'auth-job',
  idempotencyKey: 'auth-job',
  kind: 'calendar_sync',
  serverUrl: 'https://collab.example.com',
  profileId: 'mobile-profile',
  vaultId: null,
  trigger: 'periodic',
  attempt: 1,
  status: 'authentication_required',
  createdAt: '2026-07-27T08:00:00Z',
  startedAt: '2026-07-27T08:00:00Z',
  finishedAt: '2026-07-27T08:00:01Z',
  nextRetryAt: null,
  progress: { completed: 0, total: null, detail: null },
  summary: null,
  errorCategory: 'authentication',
  errorMessage: 'Sign in again.',
  retryable: false,
};

describe('MobileApp shell', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset store between tests so restored state does not leak.
    useMobileStore.setState({
      restored: false,
      servers: [],
      restoringServers: {},
      statuses: {},
      vaults: {},
      vaultsBusy: {},
      selected: null,
      files: [],
      filesBusy: false,
      filesError: null,
      filesOffline: false,
      fileCache: {},
      replicas: {},
      backgroundJobs: [],
      offlineBusy: {},
      offlineProgress: {},
      offlineError: null,
      calendarSyncing: false,
      calendarSyncProgress: {},
      calendarSyncResults: [],
      calendarConflicts: [],
      calendarMirrorConflicts: [],
      calendarMirrorStatuses: [],
      calendarMirrorProgress: {},
      calendarCacheOrigins: [],
      tab: 'servers',
      folderTrail: [{ id: null, name: 'Root' }],
      activeSheet: null,
    });
  });

  afterEach(() => {
    invoke.mockReset();
  });

  it('shows the login form when no servers are saved', async () => {
    mockInvoke({ server_connection_statuses: () => [] });
    render(<MobileApp />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_connection_statuses'));
    expect(screen.getByText('Connect to a hosted server')).toBeTruthy();
    // Bottom navigation is present and phone-first (no desktop sidebar).
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
  });

  it('hides a stale background authentication warning after reconnecting', () => {
    const server = {
      serverUrl: 'https://collab.example.com/',
      username: 'ada',
      allowInvalidCertificates: false,
      persistAcrossReboots: true,
    };
    expect(findBackgroundAttention(
      [AUTH_REQUIRED_JOB],
      [server],
      {
        'https://collab.example.com': {
          connected: true,
          serverUrl: 'https://collab.example.com',
          allowInvalidCertificates: false,
          user: null,
          accessExpiresAt: null,
        },
      },
    )).toBeUndefined();
    expect(findBackgroundAttention([AUTH_REQUIRED_JOB], [server], {})).toEqual(AUTH_REQUIRED_JOB);
  });

  it('opens the profile calendar without selecting a vault', async () => {
    mockInvoke({
      server_connection_statuses: () => [],
      calendar_list: () => [{
        schemaVersion: 1,
        id: 'calendar-1',
        globalId: 'global-1',
        location: { kind: 'local', profileId: 'mobile-profile' },
        name: 'Personal',
        color: '#a78bfa',
        defaultTimeZone: 'UTC',
        archived: false,
        readOnly: false,
        revision: 0,
        createdAt: '2026-07-23T08:00:00.000Z',
        updatedAt: '2026-07-23T08:00:00.000Z',
      }],
      calendar_list_items: () => [],
    });
    render(<MobileApp />);
    await waitFor(() => expect(useMobileStore.getState().restored).toBe(true));

    screen.getByRole('button', { name: /Calendar/ }).click();

    expect(await screen.findByRole('heading', { name: 'Calendar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Personal/ })).toBeTruthy();
    expect(useMobileStore.getState().selected).toBeNull();

    screen.getByRole('button', { name: 'Month' }).click();
    await waitFor(() => expect(document.querySelector('.mobile-calendar-content.view-month')).toBeTruthy());
    const month = document.querySelector('.mobile-calendar-content.view-month');
    expect(month).toBeTruthy();
    fireEvent.touchStart(month!, { touches: [{ clientX: 280, clientY: 240 }] });
    fireEvent.touchEnd(month!, { changedTouches: [{ clientX: 80, clientY: 242 }] });
    expect(useMobileStore.getState().tab).toBe('calendar');
  });

  it('persists the IEC/DIN schematic notation preference', async () => {
    mockInvoke({ server_connection_statuses: () => [] });
    render(<MobileApp />);
    await waitFor(() => expect(useMobileStore.getState().restored).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
    const settingsCategories = await screen.findByRole('navigation', { name: 'Settings categories' });
    fireEvent.click(within(settingsCategories).getByRole('button', { name: /Logic & circuits/ }));
    (await screen.findByRole('button', { name: 'IEC / DIN' })).click();

    const stored = JSON.parse(localStorage.getItem('collab-mobile-theme') ?? '{}') as Record<string, unknown>;
    expect(stored.schematicSymbolSet).toBe('iec');
  });

  it('shows and persists the mobile Calendar settings', async () => {
    mockInvoke({ server_connection_statuses: () => [] });
    render(<MobileApp />);
    await waitFor(() => expect(useMobileStore.getState().restored).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
    const settingsCategories = await screen.findByRole('navigation', { name: 'Settings categories' });
    fireEvent.click(within(settingsCategories).getByRole('button', { name: /Calendar/ }));
    expect(await screen.findByText('Default time zone')).toBeTruthy();
    screen.getByRole('button', { name: '2026-07-23' }).click();
    await waitFor(() => expect(screen.getByRole('button', { name: '2026-07-23' }).className).toContain('selected'));
    screen.getByRole('button', { name: '24 hour' }).click();
    await waitFor(() => expect(screen.getByRole('button', { name: '24 hour' }).className).toContain('selected'));
    fireEvent.click(screen.getByRole('checkbox', { name: /Hide weekends/ }));

    const stored = JSON.parse(localStorage.getItem('collab-mobile-theme') ?? '{}') as Record<string, unknown>;
    expect(stored.calendarDateFormat).toBe('YYYY_MM_DD');
    expect(stored.calendarTimeFormat).toBe('24-hour');
    expect(stored.calendarHideWeekends).toBe(true);
  });

  it('restores a saved session and lists vaults on the Vaults tab', async () => {
    localStorage.setItem(
      'collab-mobile-servers',
      JSON.stringify([
        {
          serverUrl: 'https://collab.example.com',
          username: 'ada',
          allowInvalidCertificates: false,
          persistAcrossReboots: true,
        },
      ]),
    );

    let connected = false;
    mockInvoke({
      server_connection_statuses: () =>
        connected
          ? [
              {
                connected: true,
                serverUrl: 'https://collab.example.com',
                allowInvalidCertificates: false,
                user: { id: 'u1', username: 'ada', displayName: 'Ada' },
                accessExpiresAt: null,
              },
            ]
          : [],
      server_has_saved_session: () => true,
      reconnect_server: () => {
        connected = true;
        return {
          connected: true,
          serverUrl: 'https://collab.example.com',
          allowInvalidCertificates: false,
          user: { id: 'u1', username: 'ada', displayName: 'Ada' },
          accessExpiresAt: null,
        };
      },
      hosted_vault_request: () => [
        { id: 'v1', name: 'Research', role: 'viewer', status: 'active', members: 2, storageBytes: 1024 },
      ],
    });

    render(<MobileApp />);

    await waitFor(() => expect(useMobileStore.getState().restored).toBe(true));
    // The reconnect used the stored refresh token (no password re-entry).
    expect(invoke).toHaveBeenCalledWith(
      'reconnect_server',
      expect.objectContaining({ serverUrl: 'https://collab.example.com' }),
    );

    // Switch to the Vaults tab and confirm the vault + read-only affordance show.
    screen.getByRole('button', { name: /Vaults/ }).click();
    await waitFor(() => expect(screen.getByText('Research')).toBeTruthy());
    expect(screen.getAllByText('Read only').length).toBeGreaterThan(0);
    expect(screen.getByText('Viewer')).toBeTruthy();
  });

  it('shows offline replicas on the Vaults tab when no server is connected', async () => {
    mockInvoke({
      server_connection_statuses: () => [],
      replica_list: () => [
        {
          serverUrl: 'https://collab.example.com',
          vaultId: 'v1',
          vaultName: 'Research',
          manifestSequence: 8,
          lastSyncedAt: '2026-07-10T10:00:00.000Z',
          status: 'idle',
          pendingCount: 0,
          updatedAt: '2026-07-10T10:00:00.000Z',
          role: 'editor',
          capabilities: ['vault.offlineCopy'],
        },
      ],
    });

    render(<MobileApp />);
    await waitFor(() => expect(useMobileStore.getState().restored).toBe(true));

    screen.getByRole('button', { name: /Vaults/ }).click();

    expect(await screen.findByText('Research')).toBeTruthy();
    expect(screen.getByText('Offline copies')).toBeTruthy();
    expect(screen.getByText(/Offline copy/)).toBeTruthy();
  });

  it('handles native Android back events through app navigation before showing quit confirmation', async () => {
    mockInvoke({ server_connection_statuses: () => [] });
    render(<MobileApp />);
    await waitFor(() => expect(useMobileStore.getState().restored).toBe(true));

    act(() => {
      useMobileStore.setState({
        tab: 'files',
        folderTrail: [{ id: null, name: 'Root' }, { id: 'folder-1', name: 'Folder' }],
        activeSheet: null,
      });
    });

    act(() => window.dispatchEvent(new Event('collab-android-back')));
    expect(useMobileStore.getState().folderTrail).toHaveLength(1);
    expect(useMobileStore.getState().tab).toBe('files');

    act(() => window.dispatchEvent(new Event('collab-android-back')));
    expect(useMobileStore.getState().tab).toBe('vaults');

    act(() => window.dispatchEvent(new Event('collab-android-back')));
    expect(screen.getByRole('dialog', { name: 'Quit Collab?' })).toBeTruthy();

    act(() => window.dispatchEvent(new Event('collab-android-back')));
    expect(screen.queryByRole('dialog', { name: 'Quit Collab?' })).toBeNull();
  });
});
