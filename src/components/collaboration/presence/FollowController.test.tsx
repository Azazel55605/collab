import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useCollabStore } from '../../../store/collabStore';
import { useEditorStore } from '../../../store/editorStore';
import type { PresenceEntry } from '../../../types/collab';

import { FollowController } from './FollowController';

const lena = (activeFile: string | null, lastSeen = Date.now()): PresenceEntry => ({
  userId: 'lena',
  userName: 'Lena',
  userColor: '#0e7490',
  activeFile,
  cursorLine: null,
  lastSeen,
  appVersion: '',
});

describe('FollowController', () => {
  beforeEach(() => {
    useEditorStore.setState({ openTabs: [], activeTabPath: null } as never);
    useCollabStore.setState({ peers: [lena('Notes/Plan.md')], followingUserId: null });
  });

  it('opens each document the followed person opens, and stops on request', () => {
    render(<FollowController />);
    expect(screen.queryByRole('status')).toBeNull();

    act(() => useCollabStore.getState().setFollowing('lena'));
    expect(screen.getByRole('status').textContent).toContain('Following Lena');
    expect(useEditorStore.getState().activeTabPath).toBe('Notes/Plan.md');

    act(() => useCollabStore.setState({ peers: [lena('Notes/Retro.md')] }));
    expect(useEditorStore.getState().activeTabPath).toBe('Notes/Retro.md');

    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    expect(useCollabStore.getState().followingUserId).toBeNull();
  });

  it('stops following someone who went offline', () => {
    useCollabStore.setState({ peers: [lena('Notes/Plan.md', Date.now() - 60_000)] });
    render(<FollowController />);
    act(() => useCollabStore.getState().setFollowing('lena'));
    expect(useCollabStore.getState().followingUserId).toBeNull();
  });
});
