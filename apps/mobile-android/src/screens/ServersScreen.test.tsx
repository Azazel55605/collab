import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { useMobileStore } from '../state/store';
import { ServersScreen } from './ServersScreen';

describe('mobile server editing', () => {
  it('expands an editor below the selected server with a per-server offline mode', () => {
    useMobileStore.setState({
      servers: [{
        serverUrl: 'https://server.test',
        username: 'ada',
        allowInvalidCertificates: true,
        persistAcrossReboots: true,
        offlineCopyMode: 'always',
      }],
      statuses: {},
    });

    render(<ServersScreen onOpenServer={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Edit https://server.test'));

    expect(screen.getByRole('form', { name: 'Edit https://server.test' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Always' }).className).toContain('selected');
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });
});
