import { useEffect, useState } from 'react';

import { MonitorPlay, Radio, Smartphone } from 'lucide-react';

import { listDisplays } from '../../lib/deck/presentWindow';
import type { DisplayInfo } from '../../lib/deck/presentWindow';
import { cn } from '../../lib/utils';
import { useUiStore } from '../../store/uiStore';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

function SettingToggle({
  checked,
  description,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-lg border border-border/40 bg-card/40 px-4 py-3 text-left transition-colors hover:bg-accent/30"
    >
      <span className="pr-4">
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors',
          checked ? 'bg-primary' : 'bg-muted-foreground/30',
        )}
      >
        <span
          className={cn(
            'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-4' : 'translate-x-0',
          )}
        />
      </span>
    </button>
  );
}

export default function SettingsPresentationSection() {
  const {
    presentationAllowRemoteStart,
    presentationAlwaysAllowPhoneControl,
    presentationDefaultMode,
    presentationDirectControl,
    presentationPreferredDisplayId,
    setPresentationAllowRemoteStart,
    setPresentationAlwaysAllowPhoneControl,
    setPresentationDefaultMode,
    setPresentationDirectControl,
    setPresentationPreferredDisplayId,
  } = useUiStore();
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listDisplays().then((next) => {
      if (!cancelled) setDisplays(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-md space-y-4">
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <MonitorPlay size={16} /> Default presentation mode
        </label>
        <Select value={presentationDefaultMode} onValueChange={setPresentationDefaultMode}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="slideshow">Slide show in this window</SelectItem>
            <SelectItem value="presenter">Presenter view with audience window</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Preferred audience display</label>
        <Select
          value={presentationPreferredDisplayId ?? 'automatic'}
          onValueChange={(value) =>
            setPresentationPreferredDisplayId(value === 'automatic' ? null : value)
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="automatic">Automatic</SelectItem>
            {displays.map((display) => (
              <SelectItem key={display.id} value={display.id}>
                {display.name}
                {display.primary ? ' (primary)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Automatic uses another connected display when one is available.
        </p>
      </div>

      <SettingToggle
        checked={presentationAlwaysAllowPhoneControl}
        onChange={setPresentationAlwaysAllowPhoneControl}
        label="Always allow phone control"
        description="New slide shows immediately advertise a remote to your signed-in phones."
      />
      <SettingToggle
        checked={presentationDirectControl}
        onChange={setPresentationDirectControl}
        label="Prefer direct phone connection"
        description="Use an encrypted peer-to-peer channel when possible, with the server relay as fallback."
      />
      <SettingToggle
        checked={presentationAllowRemoteStart}
        onChange={setPresentationAllowRemoteStart}
        label="Allow presentations to start from my phone"
        description="Lets your signed-in phone start a deck that is already open on this computer."
      />

      <div className="flex gap-2 rounded-lg border border-border/40 bg-card/30 p-3 text-xs text-muted-foreground">
        <Smartphone size={16} className="mt-0.5 shrink-0" />
        <span>
          Phone commands remain restricted to your account. <Radio size={13} className="inline" />
          Direct mode is negotiated only while a show is active.
        </span>
      </div>
    </div>
  );
}
