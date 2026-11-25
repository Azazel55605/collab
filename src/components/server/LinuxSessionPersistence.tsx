import { useEffect, useState } from 'react';

import { tauriCommands } from '../../lib/tauri';
import { Checkbox } from '../ui/checkbox';

export function LinuxSessionPersistence({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const [isLinux, setIsLinux] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => tauriCommands.hostOs?.())
      .then((os) => {
        if (active) setIsLinux(os === 'linux');
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  if (!isLinux) return null;
  return (
    <label className="flex items-start gap-2 rounded-lg border border-border/50 bg-card/30 p-3">
      <Checkbox
        aria-label="Keep me signed in across reboots"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <span>
        <span className="block text-xs font-medium">Keep me signed in across reboots</span>
        <span className="mt-1 block text-[11px] text-muted-foreground">
          Saves your next sign-in in your desktop keyring. With this off, the session lasts until
          reboot.
        </span>
      </span>
    </label>
  );
}
