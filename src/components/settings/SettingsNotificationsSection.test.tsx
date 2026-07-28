import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  request: vi.fn(),
  sendTest: vi.fn(),
}));

vi.mock('../../lib/tauri', () => ({
  tauriCommands: {
    notificationPermissionStatus: mocks.status,
    notificationRequestPermission: mocks.request,
    notificationSendTest: mocks.sendTest,
  },
}));

import SettingsNotificationsSection from './SettingsNotificationsSection';

describe('SettingsNotificationsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.status.mockResolvedValue({ status: 'prompt', supported: true });
    mocks.request.mockResolvedValue({ status: 'granted', supported: true });
    mocks.sendTest.mockResolvedValue(undefined);
  });

  it('requests permission and enables test delivery', async () => {
    render(<SettingsNotificationsSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Send test' }));
    await waitFor(() => expect(mocks.sendTest).toHaveBeenCalled());
  });
});
