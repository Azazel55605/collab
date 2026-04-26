import type { CanvasWebCardDefaultMode } from '../../store/uiStore';
import { cn } from '../../lib/utils';
import { Separator } from '../ui/separator';
import { OptionRow, PillSelect, SectionLabel, ToggleSwitch } from './settingsControls';

type Props = {
  canvasWebCardDefaultMode: CanvasWebCardDefaultMode;
  setCanvasWebCardDefaultMode: (mode: CanvasWebCardDefaultMode) => void;
  canvasWebCardAutoLoad: boolean;
  setCanvasWebCardAutoLoad: (value: boolean) => void;
  webPreviewsEnabled: boolean;
};

export default function SettingsCanvasSection({
  canvasWebCardDefaultMode,
  setCanvasWebCardDefaultMode,
  canvasWebCardAutoLoad,
  setCanvasWebCardAutoLoad,
  webPreviewsEnabled,
}: Props) {
  return (
    <div>
      <SectionLabel>Web Cards</SectionLabel>
      <OptionRow
        label="Default web card mode"
        description="Choose whether new canvas web cards start in preview or embed mode"
      >
        <PillSelect
          options={['preview', 'embed'] as const}
          value={canvasWebCardDefaultMode}
          onChange={(value) => setCanvasWebCardDefaultMode(value as CanvasWebCardDefaultMode)}
          getLabel={(value: CanvasWebCardDefaultMode) => value === 'preview' ? 'Preview' : 'Embed'}
        />
      </OptionRow>

      <Separator className="bg-border/40 my-4" />

      <OptionRow
        label="Disable web preview auto-load"
        description="Require a manual click before canvas web cards fetch preview metadata"
      >
        <ToggleSwitch
          checked={!canvasWebCardAutoLoad}
          onToggle={() => setCanvasWebCardAutoLoad(!canvasWebCardAutoLoad)}
          disabled={!webPreviewsEnabled}
          animated
        />
      </OptionRow>

      <div className={cn('mt-3 rounded-lg border border-border/40 bg-accent/10 p-3 text-xs text-muted-foreground')}>
        {!webPreviewsEnabled
          ? <>Web previews are currently disabled globally, so canvas web cards and link hover previews will not fetch metadata.</>
          : <>When auto-load is off, web cards show a manual <span className="text-foreground font-medium">Load preview</span> action instead of fetching immediately.</>}
      </div>
    </div>
  );
}
