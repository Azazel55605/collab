import { Sparkles } from 'lucide-react';

import type { AnimationSpeed } from '../../store/uiStore';
import { ANIMATION_SPEED_OPTIONS, SCALE_OPTIONS } from '../../store/uiStore';
import { cn } from '../../lib/utils';
import { Separator } from '../ui/separator';
import { OptionRow, PillSelect, SectionLabel, ToggleSwitch } from './settingsControls';

type Props = {
  scale: number;
  setScale: (scale: typeof SCALE_OPTIONS[number]) => void;
  animationsEnabled: boolean;
  setAnimationsEnabled: (enabled: boolean) => void;
  animationSpeed: AnimationSpeed;
  setAnimationSpeed: (speed: AnimationSpeed) => void;
};

export default function SettingsDisplaySection({
  scale,
  setScale,
  animationsEnabled,
  setAnimationsEnabled,
  animationSpeed,
  setAnimationSpeed,
}: Props) {
  return (
    <div>
      <SectionLabel>Interface Scale</SectionLabel>
      <OptionRow
        label="UI scale"
        description="Zoom the entire interface for HiDPI displays"
      >
        <PillSelect
          options={SCALE_OPTIONS}
          value={scale as typeof SCALE_OPTIONS[number]}
          onChange={setScale}
          getLabel={(value) => `${value}%`}
        />
      </OptionRow>
      <p className="text-[11px] text-muted-foreground mt-2">
        100% is native pixel density. Increase for HiDPI / high-resolution displays.
      </p>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Motion</SectionLabel>
      <OptionRow
        label="Disable animations"
        description="Turns off transitions, entry effects, and repeated motion across the app"
      >
        <ToggleSwitch
          checked={!animationsEnabled}
          onToggle={() => setAnimationsEnabled(!animationsEnabled)}
          animated
        />
      </OptionRow>

      <OptionRow
        label="Animation speed"
        description="Controls how quickly interface motion runs when animations are enabled"
      >
        <div className={cn(!animationsEnabled && 'pointer-events-none opacity-45')}>
          <PillSelect
            options={ANIMATION_SPEED_OPTIONS}
            value={animationSpeed}
            onChange={setAnimationSpeed}
            getLabel={(value: AnimationSpeed) => value.charAt(0).toUpperCase() + value.slice(1)}
          />
        </div>
      </OptionRow>

      <div className="mt-3 rounded-lg border border-border/40 bg-accent/10 p-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-2 text-foreground">
          <Sparkles size={13} className="text-primary" />
          Motion respects your system reduced-motion preference automatically.
        </div>
      </div>
    </div>
  );
}
