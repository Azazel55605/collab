import { useEffect, useState } from 'react';
import { Bell, BellOff, CheckCircle2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { tauriCommands } from '../../lib/tauri';
import type { NotificationPermissionStatus } from '../../types/notification';
import { Button } from '../ui/button';
import { OptionRow, SectionLabel } from './settingsControls';

export default function SettingsNotificationsSection() {
  const [permission, setPermission] = useState<NotificationPermissionStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setPermission(await tauriCommands.notificationPermissionStatus());
    } catch (error) {
      toast.error(`Could not read notification permission: ${error}`);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const requestPermission = async () => {
    setBusy(true);
    try {
      const next = await tauriCommands.notificationRequestPermission();
      setPermission(next);
      if (next.status === 'granted') toast.success('Desktop notifications enabled');
    } catch (error) {
      toast.error(`Could not enable notifications: ${error}`);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      await tauriCommands.notificationSendTest();
      toast.success('Test notification sent');
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  };

  const granted = permission?.status === 'granted';

  return (
    <>
      <SectionLabel>Desktop notifications</SectionLabel>
      <p className="mb-2 text-[12px] text-muted-foreground">
        Permission and native delivery for reminders and background activity.
      </p>
      <OptionRow
        label="System permission"
        description={granted
          ? 'Collab can deliver notifications while hidden in the tray.'
          : permission?.status === 'denied'
            ? 'Notifications are blocked. Your operating system may require enabling them in system settings.'
            : 'Enable native desktop notifications for due reminders.'}
      >
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {granted ? <CheckCircle2 size={13} className="text-emerald-500" /> : <BellOff size={13} />}
            {permission?.status ?? 'Checking'}
          </span>
          {!granted && permission?.supported !== false && (
            <Button size="sm" onClick={() => void requestPermission()} disabled={busy}>
              <Bell size={13} /> Enable
            </Button>
          )}
        </div>
      </OptionRow>
      <OptionRow
        label="Test notification"
        description="Send a local notification without creating an inbox item."
      >
        <Button variant="outline" size="sm" onClick={() => void sendTest()} disabled={busy || !granted}>
          <Send size={13} /> Send test
        </Button>
      </OptionRow>
      <SectionLabel>Delivery behavior</SectionLabel>
      <p className="text-[12px] text-muted-foreground">
        When Collab is focused, due reminders appear in the in-app inbox. When hidden or unfocused,
        they use the operating system notification center.
      </p>
    </>
  );
}
