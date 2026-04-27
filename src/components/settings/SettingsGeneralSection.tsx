import { cn } from '../../lib/utils';
import { Separator } from '../ui/separator';
import { OptionRow, SectionLabel, ToggleSwitch } from './settingsControls';

type Props = {
  restorePreviousSession: boolean;
  setRestorePreviousSession: (value: boolean) => void;
  webPreviewsEnabled: boolean;
  setWebPreviewsEnabled: (value: boolean) => void;
  hoverWebLinkPreviewsEnabled: boolean;
  setHoverWebLinkPreviewsEnabled: (value: boolean) => void;
  backgroundWebPreviewPrefetchEnabled: boolean;
  setBackgroundWebPreviewPrefetchEnabled: (value: boolean) => void;
  confirmDelete: boolean;
  setConfirmDelete: (value: boolean) => void;
};

export default function SettingsGeneralSection({
  restorePreviousSession,
  setRestorePreviousSession,
  webPreviewsEnabled,
  setWebPreviewsEnabled,
  hoverWebLinkPreviewsEnabled,
  setHoverWebLinkPreviewsEnabled,
  backgroundWebPreviewPrefetchEnabled,
  setBackgroundWebPreviewPrefetchEnabled,
  confirmDelete,
  setConfirmDelete,
}: Props) {
  return (
    <div>
      <SectionLabel>Startup</SectionLabel>
      <OptionRow
        label="Restore previous session"
        description="Reopen the last vault and previously open files when launching the app"
      >
        <ToggleSwitch
          checked={restorePreviousSession}
          onToggle={() => setRestorePreviousSession(!restorePreviousSession)}
        />
      </OptionRow>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Web Previews</SectionLabel>
      <OptionRow
        label="Enable web previews"
        description="Master switch for loading website previews anywhere in the app, including canvas web cards"
      >
        <ToggleSwitch
          checked={webPreviewsEnabled}
          onToggle={() => setWebPreviewsEnabled(!webPreviewsEnabled)}
          animated
        />
      </OptionRow>

      <OptionRow
        label="Hover previews for links"
        description="Show a small website preview below external links when hovering over them"
        disabled={!webPreviewsEnabled}
      >
        <ToggleSwitch
          checked={hoverWebLinkPreviewsEnabled}
          onToggle={() => setHoverWebLinkPreviewsEnabled(!hoverWebLinkPreviewsEnabled)}
          disabled={!webPreviewsEnabled}
          animated
        />
      </OptionRow>

      <OptionRow
        label="Background prefetch for open documents"
        description="Warm website previews in the background for visible or open documents instead of the whole vault"
        disabled={!webPreviewsEnabled || !hoverWebLinkPreviewsEnabled}
      >
        <ToggleSwitch
          checked={backgroundWebPreviewPrefetchEnabled}
          onToggle={() => setBackgroundWebPreviewPrefetchEnabled(!backgroundWebPreviewPrefetchEnabled)}
          disabled={!webPreviewsEnabled || !hoverWebLinkPreviewsEnabled}
          animated
        />
      </OptionRow>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>File Operations</SectionLabel>
      <OptionRow
        label="Confirm before deleting"
        description="Show a confirmation dialog before permanently deleting notes or folders"
      >
        <ToggleSwitch
          checked={confirmDelete}
          onToggle={() => setConfirmDelete(!confirmDelete)}
        />
      </OptionRow>

      <div className={cn('mt-3 rounded-lg border border-border/40 bg-accent/10 p-3 text-xs text-muted-foreground')}>
        {webPreviewsEnabled
          ? 'Web previews are enabled globally. Hover previews and background prefetch can be tuned independently.'
          : 'Web previews are disabled globally, so canvas web cards and link hover previews will not fetch metadata.'}
      </div>
    </div>
  );
}
