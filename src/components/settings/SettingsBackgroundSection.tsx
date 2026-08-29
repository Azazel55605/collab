import { useEffect, useState } from 'react';

import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import {
  type BackgroundSettings,
  type BackgroundSyncInterval,
  tauriCommands,
} from '../../lib/tauri';
import { Button } from '../ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

import { OptionRow, PillSelect, SectionLabel, ToggleSwitch } from './settingsControls';

const DEFAULT_SETTINGS: BackgroundSettings = {
  schemaVersion: 1,
  runInBackground: false,
  backgroundSync: true,
  syncInterval: 'system_managed',
  startAtLogin: false,
  closeBehavior: 'hide_to_tray',
  paused: false,
  onlyUnmeteredNetworks: false,
  requireCharging: false,
  pauseOnLowBattery: true,
  allowRoaming: true,
};

const INTERVAL_LABELS: Record<BackgroundSyncInterval, string> = {
  system_managed: 'System managed',
  fifteen_minutes: 'Every 15 minutes',
  thirty_minutes: 'Every 30 minutes',
  hourly: 'Hourly',
  manual: 'Manual only',
};

export default function SettingsBackgroundSection() {
  const [settings, setSettings] = useState<BackgroundSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    tauriCommands
      .backgroundSettingsGet()
      .then(setSettings)
      .catch((error) => toast.error(`Could not load background settings: ${error}`))
      .finally(() => setLoading(false));
  }, []);

  const save = async (next: BackgroundSettings) => {
    const previous = settings;
    setSettings(next);
    try {
      setSettings(await tauriCommands.backgroundSettingsSave(next));
    } catch (error) {
      setSettings(previous);
      toast.error(`Could not save background settings: ${error}`);
    }
  };

  const runSync = async () => {
    setSyncing(true);
    try {
      const jobs = await tauriCommands.backgroundSyncRegistered();
      toast.success(
        jobs.length === 0
          ? 'No cached hosted data is ready for background sync.'
          : `Started ${jobs.length} background sync job${jobs.length === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      toast.error(`Could not start background sync: ${error}`);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  const enabled = settings.runInBackground;
  const syncEnabled = enabled && settings.backgroundSync;

  return (
    <div className="space-y-5">
      <div>
        <SectionLabel>Desktop lifecycle</SectionLabel>
        <OptionRow
          label="Run in background"
          description="Keep Collab available in the system tray after its window closes."
        >
          <ToggleSwitch
            checked={enabled}
            onToggle={() => void save({ ...settings, runInBackground: !enabled })}
          />
        </OptionRow>
        <OptionRow
          label="Close button"
          description="Choose whether closing the main window hides or quits Collab."
          disabled={!enabled}
        >
          <PillSelect
            options={['hide_to_tray', 'quit'] as const}
            value={settings.closeBehavior}
            onChange={(closeBehavior) => void save({ ...settings, closeBehavior })}
            getLabel={(value) => (value === 'hide_to_tray' ? 'Hide to tray' : 'Quit')}
            disabled={!enabled}
          />
        </OptionRow>
        <OptionRow
          label="Start at login"
          description="Launch Collab directly into the tray when you sign in."
          disabled={!enabled}
        >
          <ToggleSwitch
            checked={settings.startAtLogin}
            onToggle={() => void save({ ...settings, startAtLogin: !settings.startAtLogin })}
            disabled={!enabled}
          />
        </OptionRow>
      </div>

      <div>
        <SectionLabel>Background sync</SectionLabel>
        <OptionRow
          label="Sync while hidden"
          description="Keep eligible offline vaults and hosted calendars current."
        >
          <ToggleSwitch
            checked={settings.backgroundSync}
            onToggle={() => void save({ ...settings, backgroundSync: !settings.backgroundSync })}
            disabled={!enabled}
          />
        </OptionRow>
        <OptionRow label="Schedule" disabled={!syncEnabled}>
          <Select
            value={settings.syncInterval}
            onValueChange={(syncInterval) =>
              void save({
                ...settings,
                syncInterval: syncInterval as BackgroundSyncInterval,
              })
            }
            disabled={!syncEnabled}
          >
            <SelectTrigger aria-label="Background sync schedule" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(INTERVAL_LABELS) as BackgroundSyncInterval[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {INTERVAL_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </OptionRow>
        <OptionRow
          label="Pause background sync"
          description="Keep the tray active without running scheduled synchronization."
          disabled={!syncEnabled}
        >
          <ToggleSwitch
            checked={settings.paused}
            onToggle={() => void save({ ...settings, paused: !settings.paused })}
            disabled={!syncEnabled}
          />
        </OptionRow>
        <div className="pt-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            disabled={!enabled || syncing}
            onClick={() => void runSync()}
          >
            {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Sync now
          </Button>
        </div>
      </div>
    </div>
  );
}
